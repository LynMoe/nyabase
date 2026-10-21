import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import {
  AuditAction,
  Capability,
  FailureCode,
  StoragePoolResizeFamily,
  type CreateSharedVolumeRequest,
  type IntentAcceptedDto,
  type ListScope,
  type SharedVolumeDto,
} from '@nyabase/common';
import { assertListScope, type Actor } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import type { IncusClientFactory } from '../incus/incus-client.factory.js';
import { INCUS_CLIENT_FACTORY } from '../incus/incus-client.factory.js';
import { deterministicName, numberValue } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { acceptedIntent } from '../reconcile/accepted-intent.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { SharedVolumeCatalogInspectService } from './shared-volume-catalog.service.js';
import { VolumeCapacityService } from './volume-capacity.service.js';
import { VolumeDtoAssembler, type VolumeRow } from './volume-dtos.js';
import { VolumeLifecycleService } from './volume-lifecycle.service.js';
import {
  VOLUME_TX,
  assertCanAccess,
  assertPatchable,
  assertValidVolumeSize,
  checkVolumeResize,
  isUniqueViolation,
  nameTakenConflict,
  volumeUsageUnknownFailure,
  type VolumeAccess,
} from './volume-rules.js';
import {
  VolumesRepository,
  assertSharedGrant,
  listEligibleDestroyExecutors,
} from './volumes.repository.js';

type PatchInput = { expectedRevision: number; name?: string; sizeBytes?: number };
type Tx = Transaction<NyabaseDatabase>;

/** CephFS-backed volumes shared across servers: list, create, resize/rename and delete. */
@Injectable()
export class SharedVolumesService {
  private readonly dtos: VolumeDtoAssembler;
  private readonly capacityRules: VolumeCapacityService;
  private readonly lifecycle: VolumeLifecycleService;
  private readonly catalog: SharedVolumeCatalogInspectService;

  constructor(
    private readonly repository: VolumesRepository,
    private readonly pools: StoragePoolsRepository,
    private readonly transactions: PgTransactionManager,
    intents: IntentRepository,
    @Inject(PG_DATABASE) database: Kysely<NyabaseDatabase>,
    private readonly audit: AuditService,
    @Inject(INCUS_CLIENT_FACTORY) clients: IncusClientFactory,
  ) {
    this.dtos = new VolumeDtoAssembler(database, repository, pools);
    this.capacityRules = new VolumeCapacityService(database, repository, pools);
    this.lifecycle = new VolumeLifecycleService(repository, intents, audit);
    this.catalog = new SharedVolumeCatalogInspectService(repository, database, clients);
  }

  async list(
    actor: Actor,
    filters: { scope?: ListScope; attachableOnServerId?: string } = {},
  ): Promise<SharedVolumeDto[]> {
    const scope = filters.scope ?? 'mine';
    assertListScope(actor, scope, Capability.ManageSharedVolumes);
    const rows = await this.repository.listByKind(
      'shared',
      scope === 'mine' ? { ownerId: actor.userId } : {},
    );
    const filtered = filters.attachableOnServerId
      ? await this.filterAttachable(rows, filters.attachableOnServerId)
      : rows;
    return this.dtos.toSharedVolumeDtos(filtered);
  }

  async get(actor: Actor, id: string): Promise<SharedVolumeDto> {
    const { row } = assertCanAccess(actor, await this.repository.findById(id), 'shared');
    const [dto] = await this.dtos.toSharedVolumeDtos([row]);
    return dto!;
  }

  /** Only backends with exactly one registered executor pool on the server can be attached there. */
  private async filterAttachable(
    rows: readonly VolumeRow[],
    serverId: string,
  ): Promise<VolumeRow[]> {
    if (rows.length === 0) return [];
    const pools = await this.pools.listRegisteredSharedPools({ serverId });
    const counts = new Map<string, number>();
    for (const pool of pools) {
      if (!pool.shared_backend_id) continue;
      counts.set(pool.shared_backend_id, (counts.get(pool.shared_backend_id) ?? 0) + 1);
    }
    const attachable = new Set(
      [...counts.entries()].filter(([, count]) => count === 1).map(([backendId]) => backendId),
    );
    return rows.filter((row) => row.shared_backend_id !== null && attachable.has(row.shared_backend_id));
  }

  async create(actor: Actor, input: CreateSharedVolumeRequest): Promise<SharedVolumeDto> {
    assertValidVolumeSize(input.sizeBytes);
    const actorId = actor.userId;
    const ownerId = actor.userId;
    const id = randomUUID();
    const incusName = deterministicName('nyv', id);
    let row: VolumeRow;
    try {
      row = await this.transactions.run(async (transaction) => {
        await assertSharedGrant(transaction, ownerId, input.scope.sharedBackendId);
        await this.pools.lockSharedBackends([input.scope.sharedBackendId], transaction);
        await this.capacityRules.assertSharedCreateHealth(input.scope.sharedBackendId, transaction);
        await this.capacityRules.assertSharedCapacityWithinGrants(
          transaction,
          ownerId,
          input.scope.sharedBackendId,
          input.sizeBytes,
        );
        const created = await this.repository.insert({
          id,
          ownerId,
          poolId: null,
          serverId: null,
          sharedBackendId: input.scope.sharedBackendId,
          name: input.name,
          incusName,
          sizeBytes: input.sizeBytes,
          lifecyclePhase: 'active',
          dirEnsured: false,
        }, transaction);
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.CreateVolume,
          created.id,
          'volume',
          { sizeBytes: input.sizeBytes, scope: input.scope },
        );
        return created;
      }, VOLUME_TX);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTakenConflict(input.name);
      throw error;
    }
    const [dto] = await this.dtos.toSharedVolumeDtos([row]);
    return dto!;
  }

  async patch(
    actor: Actor,
    id: string,
    input: PatchInput,
  ): Promise<SharedVolumeDto | IntentAcceptedDto> {
    const { row: current, access } = assertCanAccess(
      actor,
      await this.repository.findById(id),
      'shared',
    );
    assertPatchable(current, input);
    if (input.sizeBytes === undefined || input.sizeBytes === numberValue(current.size_bytes)) {
      return this.renameOnly(actor, current, input);
    }
    const liveUsedBytes = await this.precheckLiveUsage(current, input.sizeBytes);
    const changed = await this.transactions.run(
      (transaction) => this.resizeInTransaction(transaction, actor, access, id, {
        ...input,
        sizeBytes: input.sizeBytes!,
      }, liveUsedBytes),
      VOLUME_TX,
    );
    if (!changed.intent) {
      const [dto] = await this.dtos.toSharedVolumeDtos([changed.row]);
      return dto!;
    }
    return acceptedIntent(changed.intent);
  }

  private async renameOnly(
    actor: Actor,
    current: VolumeRow,
    input: PatchInput,
  ): Promise<SharedVolumeDto> {
    if (input.name === undefined || input.name === current.name) {
      const [dto] = await this.dtos.toSharedVolumeDtos([current]);
      return dto!;
    }
    const updated = await this.transactions.run(async (transaction) => {
      const { row: locked } = assertCanAccess(
        actor,
        await this.repository.findById(current.id, transaction),
        'shared',
      );
      if (locked.revision !== input.expectedRevision) {
        throw new ConflictException({ code: FailureCode.RevisionConflict });
      }
      return this.lifecycle.renameVolume(transaction, actor.userId, locked, input.name!);
    }, VOLUME_TX);
    const [dto] = await this.dtos.toSharedVolumeDtos([updated]);
    return dto!;
  }

  /**
   * Before a shrink, ask a reachable server for the live usage so the floor
   * is real, and remember it. Returns the observed usage when there was one.
   */
  private async precheckLiveUsage(
    current: VolumeRow,
    requestedSize: number,
  ): Promise<number | undefined> {
    const currentSize = numberValue(current.size_bytes);
    if (requestedSize - currentSize >= 0) return undefined;
    const placements = await this.repository.listPlacements(current.id);
    if (placements.length === 0) return undefined;
    const previewPool = placements[0]?.pool_id
      ? await this.pools.findById(placements[0].pool_id)
      : null;
    const quotaEffective = previewPool?.quota_effective ?? true;
    const observed = await this.catalog.observeUsage(current);
    if (observed.status === 'unavailable') {
      throw new ConflictException(volumeUsageUnknownFailure(current.id, requestedSize));
    }
    const usedNumber = observed.usedBytes === null ? null : Number(observed.usedBytes);
    await this.repository.setUsedBytes(current.id, usedNumber);
    const failure = usedNumber === null
      ? volumeUsageUnknownFailure(current.id, requestedSize)
      : checkVolumeResize({
        volumeId: current.id,
        poolId: placements[0]?.pool_id ?? current.id,
        currentSizeBytes: currentSize,
        requestedSizeBytes: requestedSize,
        usedBytes: usedNumber,
        resizeFamily: StoragePoolResizeFamily.QuotaOnline,
        blockFilesystem: null,
        attachments: [],
      });
    if (failure && quotaEffective) throw new ConflictException(failure);
    return usedNumber ?? undefined;
  }

  private async resizeInTransaction(
    transaction: Tx,
    actor: Actor,
    access: VolumeAccess,
    id: string,
    input: { expectedRevision: number; name?: string; sizeBytes: number },
    liveUsedBytes: number | undefined,
  ) {
    const { row: locked } = assertCanAccess(
      actor,
      await this.repository.findById(id, transaction),
      'shared',
    );
    if (locked.revision !== input.expectedRevision) {
      throw new ConflictException({ code: FailureCode.RevisionConflict });
    }
    if (access === 'owner') {
      await assertSharedGrant(transaction, locked.owner_id, locked.shared_backend_id!);
    }
    const lockedDelta = input.sizeBytes - numberValue(locked.size_bytes);
    await this.capacityRules.lockVolumeQuota(locked, transaction);
    const placements = await this.repository.listPlacements(id, transaction);
    const representativePoolId = placements[0]?.pool_id ?? null;
    const lockedPool = representativePoolId
      ? await this.pools.findById(representativePoolId, transaction)
      : null;
    const quotaEffective = lockedPool?.quota_effective ?? true;
    const precheckFailure = checkVolumeResize({
      volumeId: id,
      poolId: representativePoolId ?? id,
      currentSizeBytes: numberValue(locked.size_bytes),
      requestedSizeBytes: input.sizeBytes,
      usedBytes: liveUsedBytes !== undefined
        ? liveUsedBytes
        : locked.used_bytes === null ? null : numberValue(locked.used_bytes),
      resizeFamily: StoragePoolResizeFamily.QuotaOnline,
      blockFilesystem: null,
      attachments: [],
    });
    if (precheckFailure && quotaEffective) throw new ConflictException(precheckFailure);
    if (lockedDelta > 0) {
      if (access === 'admin') {
        await this.capacityRules.assertSharedCapacityPhysical(
          transaction,
          locked.shared_backend_id!,
          lockedDelta,
        );
      } else {
        await this.capacityRules.assertSharedCapacityWithinGrants(
          transaction,
          locked.owner_id,
          locked.shared_backend_id!,
          lockedDelta,
        );
      }
    }
    const { row, intents } = await this.lifecycle.applyResize(
      transaction,
      actor.userId,
      locked,
      input,
      placements,
    );
    return { row, intent: intents[0] ?? null };
  }

  async delete(actor: Actor, id: string) {
    const actorId = actor.userId;
    const result = await this.transactions.run(async (transaction) => {
      const { row: current } = assertCanAccess(
        actor,
        await this.repository.findById(id, transaction),
        'shared',
      );
      if (current.lifecycle_phase === 'deleting') {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'Volume deletion is already in progress',
          details: { volumeId: id },
        });
      }
      await this.capacityRules.lockVolumeQuota(current, transaction);
      if (await this.repository.hasAttachments(id, transaction)) {
        throw new ConflictException({
          code: FailureCode.VolumeRequiresUnbind,
          message: 'Detach all volume attachments before deleting the volume',
        });
      }
      const placements = await this.repository.listPlacements(id, transaction);
      if (!current.dir_ensured && placements.length === 0) {
        return this.lifecycle.destroyUntrackedVolume(transaction, actorId, current, 'never_mounted');
      }
      await this.assertBackendReachable(transaction, current);
      return this.lifecycle.beginVolumeDestroy(transaction, actorId, current);
    }, VOLUME_TX);
    return acceptedIntent(result.intent);
  }

  /** Destroying needs at least one online server that can reach the backend. */
  private async assertBackendReachable(transaction: Tx, volume: VolumeRow): Promise<void> {
    const eligible = volume.shared_backend_id
      ? await listEligibleDestroyExecutors(transaction, volume.shared_backend_id)
      : [];
    if (eligible.length === 0) {
      throw new ConflictException({
        code: FailureCode.VolumeDeleteBackendUnreachable,
        message: '没有在线服务器可以访问该共享存储，请联系管理员。',
        details: { sharedBackendId: volume.shared_backend_id },
      });
    }
  }
}
