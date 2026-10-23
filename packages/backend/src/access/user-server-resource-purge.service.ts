import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import {
  AuditAction,
  ContainerPhase,
  IntentKind,
  IntentResourceType,
  Role,
} from '@nyabase/common';
import { AuditService } from '../iam/audit.service.js';
import { ContainerControlRepository } from '../containers/container-control.repository.js';
import { ContainerControlService } from '../containers/container-control.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { VOLUME_DESTROY_PLACEMENT_ID } from '../reconcile/reconcile-claim.repository.js';
import { VolumeAttachmentsService } from '../volumes/volume-attachments.service.js';
import { listEligibleDestroyExecutors, VolumesRepository } from '../volumes/volumes.repository.js';
import { isSystemActor, requireUserId, type Actor } from '../iam/actor.js';
import { assertActorRole } from '../iam/administration.js';

const OPERATOR_PURGE_AUDIT_ACTION = 'user.server.purge_resources' as AuditAction;
/**
 * Purges act on another user's containers: an administrator needs the explicit
 * `scope=all` override (the owner-only default is a 404); the system passes
 * either way.
 */
const PURGE_SCOPE = 'all';

interface OwnedVolume {
  id: string;
  owner_id: string;
  lifecycle_phase: string;
  pool_id: string | null;
  server_id: string | null;
  shared_backend_id: string | null;
}

/** `deletingOnly`: only volumes already being destroyed (coverage came back after the purge). */
export interface DetachVolumesOptions {
  readonly deletingOnly?: boolean;
}

const STOPPABLE_PHASES: ReadonlySet<string> = new Set([ContainerPhase.Active, ContainerPhase.Provisioning]);

export interface PurgeUserServerResourcesResult {
  intentIds: string[];
  containerIds: string[];
  volumeIntentIds: string[];
  volumeIds: string[];
}

@Injectable()
export class UserServerResourcePurgeService {
  constructor(
    private readonly transactions: PgTransactionManager,
    private readonly containerRepository: ContainerControlRepository,
    private readonly containers: ContainerControlService,
    private readonly volumes: VolumesRepository,
    private readonly intents: IntentRepository,
    private readonly attachments: VolumeAttachmentsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Deletes a user's containers and local volumes on one server, all queued in
   * one transaction (an administrator purges as themselves). Read committed,
   * as for the expiry purge: nothing here is admitted against a quota, every
   * row is locked before it is read, and the administrator's role is re-read
   * first, after the IAM lock wait (a snapshot would predate the wait and miss
   * a demotion committed during it).
   */
  async purge(
    actor: Actor,
    userId: string,
    serverId: string,
  ): Promise<PurgeUserServerResourcesResult> {
    return this.transactions.run(
      async (transaction) => {
        if (!isSystemActor(actor)) await assertActorRole(transaction, requireUserId(actor), Role.Admin);
        return this.purgeServerInTransaction(transaction, actor, userId, serverId);
      },
      { isolationLevel: 'read committed', maxAttempts: 5 },
    );
  }

  /**
   * `purge` in the caller's transaction. Grant expiry purges as the system in
   * the transaction that re-checked coverage under the IAM lock, so a grant
   * committed before the lock is seen and one committed after waits until
   * every delete is queued (a queued delete cannot be taken back).
   */
  async purgeServerInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    actor: Actor,
    userId: string,
    serverId: string,
  ): Promise<PurgeUserServerResourcesResult> {
    const reason = isSystemActor(actor) ? 'expiry' : 'admin';
    const owned = await this.containerRepository.list({ ownerId: userId, serverId }, transaction);
    const intentIds: string[] = [];
    const containerIds: string[] = [];
    for (const container of owned) {
      if (container.lifecycle_phase === ContainerPhase.Deleting) continue;
      const accepted = await this.containers.actionInTransaction(
        transaction,
        actor,
        container.id,
        'delete',
        PURGE_SCOPE,
      );
      intentIds.push(accepted.intentId);
      containerIds.push(container.id);
    }
    const volumeResult = await this.destroyVolumes(
      transaction,
      actor,
      userId,
      (volume) => volume.server_id === serverId && volume.shared_backend_id === null,
    );
    await this.audit.append(
      transaction,
      actor.userId,
      reason === 'expiry' ? AuditAction.ExpiryPurgeResources : OPERATOR_PURGE_AUDIT_ACTION,
      userId,
      'user',
      {
        serverId,
        containerIds,
        intentIds,
        volumeIds: volumeResult.volumeIds,
        volumeIntentIds: volumeResult.intentIds,
        reason,
      },
    );
    return {
      intentIds,
      containerIds,
      volumeIntentIds: volumeResult.intentIds,
      volumeIds: volumeResult.volumeIds,
    };
  }

  /**
   * Grace over on a storage pool: the user's volumes there are destroyed, in
   * the caller's transaction (as for `purgeServerInTransaction`). The
   * containers they were attached to stay; detach what is still attached (an
   * administrator re-attached it during the grace) with
   * `detachVolumesForStoragePool` first.
   */
  async purgeStoragePoolVolumes(
    transaction: Transaction<NyabaseDatabase>,
    actor: Actor,
    userId: string,
    poolId: string,
  ): Promise<{ intentIds: string[]; volumeIds: string[] }> {
    return this.purgeResourceVolumes(
      transaction,
      actor,
      userId,
      (volume) => volume.pool_id === poolId && volume.shared_backend_id === null,
      { kind: 'storage_pool', id: poolId, field: 'poolId' },
    );
  }

  /** Grace over on a shared backend: as for a storage pool, on every server. */
  async purgeSharedBackendVolumes(
    transaction: Transaction<NyabaseDatabase>,
    actor: Actor,
    userId: string,
    sharedBackendId: string,
  ): Promise<{ intentIds: string[]; volumeIds: string[] }> {
    return this.purgeResourceVolumes(
      transaction,
      actor,
      userId,
      (volume) => volume.shared_backend_id === sharedBackendId,
      { kind: 'shared_backend', id: sharedBackendId, field: 'sharedBackendId' },
    );
  }

  /**
   * Access to a storage pool lapsed: detach the user's volumes there from
   * every container at once (running containers keep running without them).
   * The user may attach them again once access returns.
   */
  async detachVolumesForStoragePool(
    actor: Actor,
    userId: string,
    poolId: string,
    options: DetachVolumesOptions = {},
  ): Promise<{ intentIds: string[] }> {
    return this.detachVolumesForResource(
      actor,
      userId,
      (volume) => volume.pool_id === poolId && volume.shared_backend_id === null,
      { resourceKind: 'storage_pool', resourceId: poolId },
      options,
    );
  }

  /** Access to a shared backend lapsed: as for a storage pool, on every server. */
  async detachVolumesForSharedBackend(
    actor: Actor,
    userId: string,
    sharedBackendId: string,
    options: DetachVolumesOptions = {},
  ): Promise<{ intentIds: string[] }> {
    return this.detachVolumesForResource(
      actor,
      userId,
      (volume) => volume.shared_backend_id === sharedBackendId,
      { resourceKind: 'shared_backend', resourceId: sharedBackendId },
      options,
    );
  }

  async stopRunningContainersForGraceEntry(
    actor: Actor,
    userId: string,
    serverId: string,
  ): Promise<{ intentIds: string[] }> {
    const actorId = actor.userId;
    const owned = await this.containerRepository.list({ ownerId: userId, serverId });
    const intentIds: string[] = [];
    for (const container of owned) {
      // A container still provisioning may already run (a create that failed
      // after the start): it stops like any other. One already desired
      // stopped is stopped again only when its stop did not take effect
      // (`enforceStop`), so a parked container cannot keep running the grace.
      if (!STOPPABLE_PHASES.has(container.lifecycle_phase)) continue;
      const accepted = await this.containers.enforceStop(actor, container.id);
      if (accepted) intentIds.push(accepted.intentId);
    }
    if (intentIds.length > 0) {
      await this.transactions.run(async (transaction) => {
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.ExpiryStopContainers,
          userId,
          'user',
          { serverId, intentIds },
        );
      });
    }
    return { intentIds };
  }

  private async detachVolumesForResource(
    actor: Actor,
    userId: string,
    matches: (volume: OwnedVolume) => boolean,
    resource: { resourceKind: string; resourceId: string },
    options: DetachVolumesOptions,
  ): Promise<{ intentIds: string[] }> {
    const intentIds = await this.detachAll(
      actor,
      userId,
      options.deletingOnly
        ? (volume) => volume.lifecycle_phase === 'deleting' && matches(volume)
        : matches,
    );
    if (intentIds.length > 0) {
      await this.transactions.run(async (transaction) => {
        await this.audit.append(
          transaction,
          actor.userId,
          AuditAction.ExpiryDetachVolumes,
          userId,
          'user',
          { ...resource, intentIds },
        );
      });
    }
    return { intentIds };
  }

  /**
   * Detach intents for every attachment of the matching volumes that is not
   * already going (one whose detach intent ended without unplugging it is
   * detached again: `forceDetach`).
   */
  private async detachAll(
    actor: Actor,
    userId: string,
    matches: (volume: OwnedVolume) => boolean,
  ): Promise<string[]> {
    const intentIds: string[] = [];
    for (const volume of (await this.volumes.list(userId)).filter(matches)) {
      for (const attachment of await this.volumes.listAttachments(undefined, volume.id)) {
        const intent = await this.attachments.forceDetach(actor, attachment.id);
        if (intent) intentIds.push(intent.id);
      }
    }
    return intentIds;
  }

  private async purgeResourceVolumes(
    transaction: Transaction<NyabaseDatabase>,
    actor: Actor,
    userId: string,
    matches: (volume: OwnedVolume) => boolean,
    resource: { kind: 'storage_pool' | 'shared_backend'; id: string; field: 'poolId' | 'sharedBackendId' },
  ): Promise<{ intentIds: string[]; volumeIds: string[] }> {
    const result = await this.destroyVolumes(transaction, actor, userId, matches);
    if (result.volumeIds.length > 0) {
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.ExpiryPurgeResources,
        resource.id,
        resource.kind,
        {
          userId,
          [resource.field]: resource.id,
          volumeIds: result.volumeIds,
          intentIds: result.intentIds,
        },
      );
    }
    return result;
  }

  /**
   * Marks the matching volumes deleting and queues their destroy. A volume
   * that is still attached is destroyed once its attachments are gone. Each
   * volume row is locked first, and attachments and placements reference it,
   * so read committed sees every one committed before the lock.
   */
  private async destroyVolumes(
    transaction: Transaction<NyabaseDatabase>,
    actor: Actor,
    userId: string,
    matches: (volume: OwnedVolume) => boolean,
  ): Promise<{ intentIds: string[]; volumeIds: string[] }> {
    const actorId = actor.userId;
    const owned = (await this.volumes.list(userId, transaction)).filter(matches);
    const intentIds: string[] = [];
    const volumeIds: string[] = [];
    for (const volume of owned) {
      const locked = await transaction.selectFrom('control.volumes')
        .selectAll()
        .where('id', '=', volume.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) continue;
      const sentinel = await transaction
        .selectFrom('control.reconcile_claims')
        .select('resource_id')
        .where('resource_type', '=', 'volume')
        .where('resource_id', '=', locked.id)
        .where('placement_server_id', '=', VOLUME_DESTROY_PLACEMENT_ID)
        .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (sentinel) continue;
      const attachments = await this.volumes.listAttachments(undefined, locked.id, transaction);
      const placements = await this.volumes.listPlacements(locked.id, transaction);
      // Any executor, online or not: an unreachable one only delays the
      // destroy, while dropping the row would leave the data behind.
      const eligible = locked.shared_backend_id
        ? await listEligibleDestroyExecutors(transaction, locked.shared_backend_id, {
          includeOffline: true,
        })
        : [];
      const dropNow = attachments.length === 0 && placements.length === 0
        && (!locked.dir_ensured || eligible.length === 0);
      if (dropNow) {
        const pending = await transaction
          .selectFrom('control.intents')
          .select('id')
          .where('resource_type', '=', 'volume')
          .where('resource_id', '=', locked.id)
          .where('status', '=', 'pending')
          .execute();
        for (const row of pending) {
          await this.intents.settleOne(row.id, { outcome: 'succeeded' }, transaction);
        }
        await this.volumes.deleteVolumeRow(locked.id, transaction);
        if (locked.dir_ensured && eligible.length === 0) {
          await this.audit.append(
            transaction,
            actorId,
            AuditAction.DeleteVolume,
            locked.id,
            'volume',
            { reason: 'destroy_executor_gone' },
          );
        }
        volumeIds.push(locked.id);
        continue;
      }
      const intentId = await this.beginDestroy(transaction, actorId, locked);
      if (!intentId) continue;
      intentIds.push(intentId);
      volumeIds.push(locked.id);
    }
    return { intentIds, volumeIds };
  }

  /** Marks the volume deleting (once) and ensures its pending destroy intent. */
  private async beginDestroy(
    transaction: Transaction<NyabaseDatabase>,
    actorId: string | null,
    locked: { id: string; revision: number; lifecycle_phase: string },
  ): Promise<string | null> {
    let desired = locked;
    if (locked.lifecycle_phase !== 'deleting') {
      const updated = await this.volumes.updateDesired(
        locked.id,
        locked.revision,
        {
          lifecycle_phase: 'deleting',
          failure_code: null,
          needs_attention: false,
        },
        transaction,
      );
      if (!updated) return null;
      desired = updated;
    }
    const intent = await this.intents.ensurePending({
      kind: IntentKind.VolumeDestroy,
      resourceType: IntentResourceType.Volume,
      resourceId: desired.id,
      requestedBy: actorId,
      targetRevision: desired.revision,
      request: {
        operation: 'destroy',
        idempotencyKey: 'destroy',
      },
    }, transaction);
    return intent.id;
  }
}
