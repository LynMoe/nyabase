import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import {
  AuditAction,
  IntentKind,
  IntentResourceType,
  type StorageMountPreviewDto,
} from '@nyabase/common';
import { AuditService } from '../iam/audit.service.js';
import { resolvePoolAccess, resolveSharedBackendAccess } from '../iam/effective-access.js';
import { deterministicName, nullableNumber, numberValue } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { lockOwnerServerQuota } from '../platform/persistence-pg/advisory-locks.js';
import { loadServerDiskCharge } from '../platform/persistence-pg/disk-charge.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import type { DiskRef } from '../storage-pools/disk-mounts.js';
import { loadPlanSnapshot } from './storage-provisioning.read-model.js';
import { QUOTA_BALANCER_SOURCE, VOLUME_TX, isUniqueViolation, shrinkReservation } from './volume-rules.js';
import {
  planProvisioning,
  type PlanSnapshot,
  type PlannedCreate,
  type PlannedMount,
  type PlannedResize,
  type ProvisioningPlan,
} from './volume-provisioning.js';
import { createVolumeIntent, VolumesRepository } from './volumes.repository.js';

type Tx = Transaction<NyabaseDatabase>;

export interface ProvisioningOutcome {
  created: number;
  mounted: number;
  resized: number;
  pathConflicts: ProvisioningPlan['pathConflicts'];
}

/**
 * Applies `planProvisioning` as the system: creates the volumes users are
 * owed, mounts them into their containers, and sets the sizes the quota
 * balancer computed. Every action runs in its own transaction and re-checks
 * what it relies on (coverage, the disk still enabled, the volume's revision),
 * so a plan made from a stale snapshot only loses a pass. Audit rows have no
 * actor (the system); the balancer's resizes are not audited.
 */
@Injectable()
export class VolumeProvisioner {
  private readonly logger = new Logger(VolumeProvisioner.name);

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly intents: IntentRepository,
    private readonly repository: VolumesRepository,
    private readonly pools: StoragePoolsRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * One pass with this usage: plan, create, then plan again (a new shared
   * volume is mountable at once; a new local one once its ensure succeeded,
   * on a later pass), mount and resize.
   */
  async run(usage: ReadonlyMap<string, number | null>): Promise<ProvisioningOutcome> {
    let { snapshot } = await loadPlanSnapshot(this.database, { usage });
    let plan = planProvisioning(snapshot);
    let created = 0;
    for (const create of plan.creates) {
      if (await this.applyCreate(create)) created += 1;
    }
    if (created > 0) {
      ({ snapshot } = await loadPlanSnapshot(this.database, { usage }));
      plan = planProvisioning(snapshot);
    }
    const mounted = await this.applyMounts(plan.mounts);
    let resized = 0;
    for (const resize of plan.resizes) {
      if (await this.applyResize(resize)) resized += 1;
    }
    return { created, mounted, resized, pathConflicts: plan.pathConflicts };
  }

  /** What enabling `disk` at `mountPath` would do now (volumes to create, containers to mount into). */
  async preview(disk: DiskRef, mountPath: string): Promise<StorageMountPreviewDto> {
    const { snapshot } = await loadPlanSnapshot(this.database);
    const target = snapshot.disks.find((row) => row.kind === disk.kind && row.id === disk.id);
    if (!target) return { volumes: [], mounts: [], pathConflicts: [] };
    target.mountPath = mountPath;
    target.maintenance = false;
    const first = planProvisioning(snapshot);
    const creates = first.creates.filter((create) => create.kind === disk.kind && create.diskId === disk.id);
    // The volumes to create, as if they existed, to see where they would mount.
    const withNew: PlanSnapshot = {
      ...snapshot,
      volumes: [
        ...snapshot.volumes,
        ...creates.map((create, index) => ({
          id: `new:${index}`,
          ownerId: create.ownerId,
          kind: create.kind,
          diskId: create.diskId,
          serverId: create.serverId,
          phase: 'active' as const,
          revision: 1,
          sizeBytes: create.sizeBytes,
          reservedBytes: null,
          usedBytes: 0,
          ownerOtherBytes: 0,
        })),
      ],
    };
    const second = planProvisioning(withNew);
    const onDisk = new Set(withNew.volumes
      .filter((volume) => volume.kind === disk.kind && volume.diskId === disk.id)
      .map((volume) => volume.id));
    const containers = new Map(snapshot.containers.map((row) => [row.id, row]));
    const users = creates.length === 0
      ? []
      : await this.database.selectFrom('iam.users')
        .select(['id', 'username'])
        .where('id', 'in', creates.map((create) => create.ownerId))
        .execute();
    const usernames = new Map(users.map((user) => [user.id, user.username]));
    const containerRef = (id: string) => {
      const container = containers.get(id)!;
      return { containerId: id, containerName: container.name, ownerId: container.ownerId, serverId: container.serverId };
    };
    return {
      volumes: creates.map((create) => ({ userId: create.ownerId, username: usernames.get(create.ownerId) ?? '' })),
      mounts: second.mounts.filter((mount) => onDisk.has(mount.volumeId)).map((mount) => containerRef(mount.containerId)),
      pathConflicts: second.pathConflicts
        .filter((conflict) => onDisk.has(conflict.volumeId))
        .map((conflict) => containerRef(conflict.containerId)),
    };
  }

  /**
   * Mounts the owner's mountable volumes into a container being created, in
   * the create transaction: its create intent brings them up with it.
   */
  async bindNewContainer(
    transaction: Tx,
    container: { id: string; owner_id: string; server_id: string },
  ): Promise<void> {
    const { snapshot } = await loadPlanSnapshot(transaction, { ownerId: container.owner_id });
    snapshot.containers = [{ id: container.id, ownerId: container.owner_id, serverId: container.server_id, name: '' }];
    snapshot.attachments = snapshot.attachments.filter((row) => row.containerId === container.id);
    for (const mount of planProvisioning(snapshot).mounts) {
      await this.insertMount(transaction, mount);
    }
  }

  /**
   * A disk's maintenance flipped: rewrite every container that mounts one of
   * its volumes, so the disk leaves (or rejoins) their instances now rather
   * than at the next full scan.
   */
  async rewriteContainersOnDisk(disk: DiskRef): Promise<number> {
    const rows = await this.database.selectFrom('control.volume_attachments as attachment')
      .innerJoin('control.volumes as volume', 'volume.id', 'attachment.volume_id')
      .innerJoin('control.containers as container', 'container.id', 'attachment.container_id')
      .select(['container.id', 'container.server_id', 'container.revision'])
      .$if(disk.kind === 'pool', (query) => query.where('volume.pool_id', '=', disk.id))
      .$if(disk.kind === 'backend', (query) => query.where('volume.shared_backend_id', '=', disk.id))
      .where('container.lifecycle_phase', '=', 'active')
      .distinct()
      .execute();
    for (const row of rows) {
      await this.intents.ensurePending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId: row.id,
        serverId: row.server_id,
        targetRevision: row.revision,
        reuseSettled: false,
        request: { operation: 'storage_maintenance', idempotencyKey: `storage_maintenance:${disk.id}` },
      });
    }
    return rows.length;
  }

  private async applyCreate(create: PlannedCreate): Promise<boolean> {
    try {
      return await this.transactions.run(async (transaction) => {
        const covered = create.kind === 'pool'
          ? await resolvePoolAccess(transaction, create.ownerId, create.diskId)
          : await resolveSharedBackendAccess(transaction, create.ownerId, create.diskId);
        if (!covered) return false;
        const id = randomUUID();
        if (create.kind === 'pool') {
          const pool = await this.pools.lockCapacityScope(create.diskId, create.serverId, [], transaction);
          if (pool.mount_path === null || pool.maintenance || !pool.registered) return false;
          await this.repository.insert({
            id,
            ownerId: create.ownerId,
            poolId: create.diskId,
            serverId: create.serverId,
            sharedBackendId: null,
            name: create.mountPath,
            incusName: deterministicName('nyv', id),
            sizeBytes: create.sizeBytes,
          }, transaction);
          await this.repository.upsertPlacement({
            volumeId: id,
            serverId: create.serverId!,
            poolId: create.diskId,
            catalogState: 'ensuring',
          }, transaction);
          await createVolumeIntent(this.intents, {
            kind: IntentKind.VolumeEnsure,
            resourceType: IntentResourceType.Volume,
            resourceId: id,
            serverId: create.serverId!,
            requestedBy: null,
            targetRevision: 1,
            request: { operation: 'create', idempotencyKey: 'create', sizeBytes: create.sizeBytes },
          }, transaction);
        } else {
          await this.pools.lockSharedBackends([create.diskId], transaction);
          const backend = await transaction.selectFrom('infra.shared_backends')
            .select(['mount_path', 'maintenance'])
            .where('id', '=', create.diskId)
            .executeTakeFirst();
          if (!backend || backend.mount_path === null || backend.maintenance) return false;
          // A shared volume's directory is created where it is first mounted.
          await this.repository.insert({
            id,
            ownerId: create.ownerId,
            poolId: null,
            serverId: null,
            sharedBackendId: create.diskId,
            name: create.mountPath,
            incusName: deterministicName('nyv', id),
            sizeBytes: create.sizeBytes,
            lifecyclePhase: 'active',
            dirEnsured: false,
          }, transaction);
        }
        await this.audit.append(transaction, null, AuditAction.CreateVolume, id, 'volume', {
          ownerId: create.ownerId,
          sizeBytes: create.sizeBytes,
          scope: create.kind === 'pool'
            ? { kind: 'local', serverId: create.serverId, poolId: create.diskId }
            : { kind: 'shared', sharedBackendId: create.diskId },
        });
        return true;
      }, VOLUME_TX);
    } catch (error) {
      // Another pass created it first.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** One transaction and one update intent per container. */
  private async applyMounts(mounts: readonly PlannedMount[]): Promise<number> {
    const byContainer = new Map<string, PlannedMount[]>();
    for (const mount of mounts) byContainer.set(mount.containerId, [...(byContainer.get(mount.containerId) ?? []), mount]);
    let mounted = 0;
    for (const [containerId, list] of byContainer) {
      try {
        mounted += await this.transactions.run(async (transaction) => {
          const container = await transaction.selectFrom('control.containers')
            .select(['id', 'owner_id', 'server_id', 'revision', 'lifecycle_phase'])
            .where('id', '=', containerId)
            .forUpdate()
            .executeTakeFirst();
          if (!container || container.lifecycle_phase !== 'active') return 0;
          const attachmentIds: string[] = [];
          for (const mount of list) {
            const id = await this.insertMount(transaction, mount);
            if (id) attachmentIds.push(id);
          }
          if (attachmentIds.length === 0) return 0;
          const revision = Number(container.revision) + 1;
          await transaction.updateTable('control.containers')
            .set({ revision })
            .where('id', '=', containerId)
            .where('revision', '=', container.revision)
            .executeTakeFirstOrThrow();
          await this.intents.createPending({
            kind: IntentKind.ContainerUpdate,
            resourceType: IntentResourceType.Container,
            resourceId: containerId,
            serverId: container.server_id,
            requestedBy: null,
            targetRevision: revision,
            request: { operation: 'mount_volumes', attachmentIds },
          }, transaction);
          return attachmentIds.length;
        }, VOLUME_TX);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        this.logger.warn(`container=${containerId} mount raced another write; the next pass retries`);
      }
    }
    return mounted;
  }

  /** The attachment row (and the placement it needs), if the mount still holds; its id. */
  private async insertMount(transaction: Tx, mount: PlannedMount): Promise<string | null> {
    const volume = await this.repository.findByIdForUpdate(mount.volumeId, transaction);
    if (!volume || volume.lifecycle_phase !== 'active' || volume.owner_id !== mount.ownerId) return null;
    const covered = volume.shared_backend_id === null
      ? await resolvePoolAccess(transaction, mount.ownerId, volume.pool_id!)
      : await resolveSharedBackendAccess(transaction, mount.ownerId, volume.shared_backend_id);
    if (!covered) return null;
    if (await this.repository.findConflictingAttachment(mount.containerId, mount.volumeId, mount.containerPath, transaction)) {
      return null;
    }
    const id = randomUUID();
    await this.repository.insertAttachment({
      id,
      containerId: mount.containerId,
      volumeId: mount.volumeId,
      deviceName: deterministicName('nyd', id),
      containerPath: mount.containerPath,
      readOnly: false,
      bindState: 'attaching',
    }, transaction);
    await this.repository.upsertPlacement({
      volumeId: mount.volumeId,
      serverId: mount.serverId,
      poolId: mount.poolId,
      catalogState: 'ensuring',
    }, transaction);
    await this.audit.append(transaction, null, AuditAction.AttachVolume, id, 'volume_attachment', {
      containerId: mount.containerId,
      volumeId: mount.volumeId,
      containerPath: mount.containerPath,
    });
    return id;
  }

  /**
   * Writes the balancer's size with the shrink reservation it needs
   * (`shrinkReservation`) and queues one resize per placement; without
   * placements nothing holds the old size, so no reservation is kept
   * (`releaseSettledShrinkReservations`). Not audited: the quotas follow
   * usage, many times a day (the intents keep the history).
   */
  private async applyResize(resize: PlannedResize): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      // A data disk's grow takes what the owner's system disks left of the
      // total when the snapshot was read: under the lock root admission
      // takes, it waits a pass if they grew since (the next plan shrinks
      // instead).
      if (resize.quota) await lockOwnerServerQuota(transaction, resize.quota.ownerId, resize.quota.serverId);
      const locked = await this.repository.findByIdForUpdate(resize.volumeId, transaction);
      if (!locked || locked.revision !== resize.revision) return false;
      if (locked.lifecycle_phase === 'deleting' || locked.lifecycle_phase === 'failed') return false;
      const current = numberValue(locked.size_bytes);
      if (current === resize.sizeBytes) return false;
      if (resize.quota && resize.sizeBytes > current) {
        const charge = await loadServerDiskCharge(transaction, resize.quota.ownerId, resize.quota.serverId);
        if (charge.rootCommittedBytes > resize.quota.rootBytes) return false;
      }
      const reservation = shrinkReservation({
        currentBytes: current,
        reservedBytes: nullableNumber(locked.shrink_reserved_bytes),
        requestedBytes: resize.sizeBytes,
      });
      const row = await this.repository.updateDesired(locked.id, locked.revision, {
        size_bytes: resize.sizeBytes,
        shrink_reserved_bytes: reservation.reservedBytes,
      }, transaction);
      if (!row) return false;
      await this.repository.releaseSettledShrinkReservation(row.id, transaction);
      for (const placement of await this.repository.listPlacements(locked.id, transaction)) {
        await createVolumeIntent(this.intents, {
          kind: IntentKind.VolumeResize,
          resourceType: IntentResourceType.Volume,
          resourceId: locked.id,
          serverId: placement.server_id,
          requestedBy: null,
          targetRevision: row.revision,
          request: {
            operation: 'resize',
            idempotencyKey: 'resize',
            sizeBytes: resize.sizeBytes,
            source: QUOTA_BALANCER_SOURCE,
          },
        }, transaction);
      }
      return true;
    }, VOLUME_TX);
  }
}
