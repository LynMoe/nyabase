import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  FailureCode,
  AuditAction,
  IntentKind,
  IntentResourceType,
  StoragePoolResizeFamily,
  type AttachVolumeRequest,
  type CreateSharedVolumeRequest,
  type LocalVolumeScope,
  type SharedBackendCatalogInspectDto,
  type SharedVolumeCatalogInspectDto,
  type SharedVolumeDto,
  type SharedVolumeScope,
  type StorageCapacityDto,
  type VolumeAttachmentDto,
  type VolumeAttachmentSummaryDto,
  type VolumeDto,
  type IntentAcceptedDto,
} from '@nyabase/common';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { IntentRepository } from '../runtime/intent.repository.js';
import { ReconcileWakeService } from '../runtime/reconcile-wake.service.js';
import { acceptedIntent, isoDate, lifecyclePhase, numberValue, deterministicName, poolLabel } from '../domain/domain-utils.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { storagePoolCapability } from '../storage-pools/storage-pools.service.js';
import { VolumesRepository, type VolumeExecutor } from './volumes.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { classifyGrantExpiry, expiresAtSortKey } from '../access/grant-expiry.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { listEligibleDestroyExecutors } from './eligible-destroy-executors.js';
import { occupancyForCatalogItem } from './shared-volume-inspect.js';
import {
  INCUS_CLIENT_FACTORY,
  type IncusClientFactory,
} from '../runtime/reconcile-worker.service.js';
import { IncusError } from '../incus/index.js';

type GrantRow = {
  disk_bytes: string | number | null;
  expires_at: Date | string | null;
  user_id: string | null;
  group_id: string | null;
  group_priority: number | null;
  id: string;
};

type VolumeRow = {
  id: string;
  owner_id: string;
  pool_id: string | null;
  server_id: string | null;
  shared_backend_id: string | null;
  name: string;
  incus_name: string;
  size_bytes: string | number;
  used_bytes: string | number | null;
  generation: number;
  observed_generation: number | null;
  lifecycle_phase: string;
  needs_attention: boolean;
  failure_code: string | null;
  dir_ensured: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

export function isIntentAccepted(
  result: VolumeDto | SharedVolumeDto | IntentAcceptedDto,
): result is IntentAcceptedDto {
  return 'intentId' in result;
}

type SharedGrantRow = {
  limit_bytes: string | number | bigint;
  expires_at: Date | string | null;
  user_id: string | null;
  group_id: string | null;
  group_priority: number | null;
  id: string;
};

function activeExpiry(value: Date | string | null): boolean {
  return classifyGrantExpiry(value) !== 'lost';
}

function liveExpiry(value: Date | string | null): boolean {
  return classifyGrantExpiry(value) === 'live';
}

type GrantCandidate = {
  user_id: string | null;
  group_id: string | null;
  group_priority: number | null;
  id: string;
  expires_at: Date | string | null;
};

function compareGrantCandidates(
  ownerId: string,
  left: GrantCandidate,
  right: GrantCandidate,
): number {
  const leftPhase = classifyGrantExpiry(left.expires_at) === 'live' ? 0 : 1;
  const rightPhase = classifyGrantExpiry(right.expires_at) === 'live' ? 0 : 1;
  if (leftPhase !== rightPhase) return leftPhase - rightPhase;
  const leftScope = left.user_id === ownerId ? 0 : 1;
  const rightScope = right.user_id === ownerId ? 0 : 1;
  if (leftScope !== rightScope) return leftScope - rightScope;
  if (leftScope === 1) {
    const leftExpires = expiresAtSortKey(left.expires_at);
    const rightExpires = expiresAtSortKey(right.expires_at);
    if (leftExpires !== rightExpires) return rightExpires > leftExpires ? 1 : -1;
    const priority = (right.group_priority ?? 0) - (left.group_priority ?? 0);
    if (priority !== 0) return priority;
  }
  return right.id.localeCompare(left.id);
}

function maxNullable(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return finite.length === 0 ? null : Math.max(...finite);
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === '23505') return true;
    current = record.cause;
  }
  return false;
}

export interface VolumeResizeCheckInput {
  volumeId: string;
  poolId: string;
  currentSizeBytes: number;
  requestedSizeBytes: number;
  usedBytes: number | null;
  resizeFamily: StoragePoolResizeFamily;
  blockFilesystem: string | null;
  attachments: ReadonlyArray<{
    attachmentId: string;
    containerId: string;
    containerPath: string;
  }>;
}

export interface VolumeResizeCheckFailure {
  code:
    | FailureCode.VolumeShrinkBelowUsage
    | FailureCode.VolumeShrinkRequiresDetach
    | FailureCode.VolumeShrinkUnsupported;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Shrink floor uses observed usedBytes. Quota-online used===size is real usage,
 * not a phantom-empty signal.
 */
export function effectiveUsageForShrinkFloor(input: {
  usedBytes: number | null;
  currentSizeBytes: number;
  resizeFamily: StoragePoolResizeFamily | string;
}): number | null {
  return input.usedBytes;
}

/**
 * Pure custom-volume resize policy.  It deliberately has no Incus client
 * input: the controller must reject an unsafe request before an intent is
 * created or a physical request is possible.
 */
export function checkVolumeResize(
  input: VolumeResizeCheckInput,
): VolumeResizeCheckFailure | null {
  const delta = input.requestedSizeBytes - input.currentSizeBytes;
  if (delta >= 0) return null;
  const effectiveUsed = effectiveUsageForShrinkFloor({
    usedBytes: input.usedBytes,
    currentSizeBytes: input.currentSizeBytes,
    resizeFamily: input.resizeFamily,
  });
  if (effectiveUsed !== null && effectiveUsed > input.requestedSizeBytes) {
    return {
      code: FailureCode.VolumeShrinkBelowUsage,
      message: 'Volume cannot shrink below observed usage',
      details: {
        volumeId: input.volumeId,
        requestedBytes: input.requestedSizeBytes,
        usedBytes: effectiveUsed,
      },
    };
  }
  if (
    input.resizeFamily === StoragePoolResizeFamily.BlockBacked
    && input.attachments.length > 0
  ) {
    return {
      code: FailureCode.VolumeShrinkRequiresDetach,
      message: 'Block-backed custom volume shrink requires detaching the volume first',
      details: {
        volumeId: input.volumeId,
        attachments: input.attachments,
      },
    };
  }
  if (input.blockFilesystem?.toLowerCase() === 'xfs') {
    return {
      code: FailureCode.VolumeShrinkUnsupported,
      message: 'XFS custom volume shrink is unsupported',
      details: {
        volumeId: input.volumeId,
        poolId: input.poolId,
        reason: 'xfs_cannot_shrink',
      },
    };
  }
  return null;
}

@Injectable()
export class VolumesService {
  constructor(
    private readonly repository: VolumesRepository,
    private readonly pools: StoragePoolsRepository,
    private readonly transactions: PgTransactionManager,
    private readonly intents: IntentRepository,
    private readonly wake: ReconcileWakeService,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly audit: AuditService,
    @Optional() private readonly config?: NyabaseConfigService,
    @Optional() @Inject(INCUS_CLIENT_FACTORY) private readonly clients?: IncusClientFactory,
  ) {}

  private async lockVolumeQuota(
    volume: { server_id: string | null; pool_id: string | null; shared_backend_id: string | null },
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    if (volume.server_id !== null) {
      if (!volume.pool_id) throw new ConflictException({ code: FailureCode.InvalidInput });
      await this.pools.lockCapacityScope(volume.pool_id, volume.server_id, [], transaction);
      return;
    }
    await this.pools.lockSharedBackends([volume.shared_backend_id], transaction);
  }

  async listForUser(ownerId: string): Promise<VolumeDto[]> {
    const rows = await this.repository.listByKind('local', ownerId);
    return this.toDtos(rows);
  }

  async listForAdmin(): Promise<VolumeDto[]> {
    const rows = await this.repository.listByKind('local');
    return this.toDtos(rows);
  }

  async listSharedForUser(ownerId: string, attachableOnServerId?: string): Promise<SharedVolumeDto[]> {
    const rows = await this.repository.listByKind('shared', ownerId);
    const filtered = attachableOnServerId
      ? await this.filterAttachableShared(rows, attachableOnServerId)
      : rows;
    return this.toSharedDtos(filtered);
  }

  async listSharedForAdmin(attachableOnServerId?: string): Promise<SharedVolumeDto[]> {
    const rows = await this.repository.listByKind('shared');
    const filtered = attachableOnServerId
      ? await this.filterAttachableShared(rows, attachableOnServerId)
      : rows;
    return this.toSharedDtos(filtered);
  }

  async getForUser(id: string, actorId: string): Promise<VolumeDto> {
    const row = await this.repository.findById(id);
    this.requireLocal(row, actorId, 'user');
    const [dto] = await this.toDtos([row!]);
    return dto!;
  }

  async getForAdmin(id: string): Promise<VolumeDto> {
    const row = await this.repository.findById(id);
    this.requireLocal(row, undefined, 'admin');
    const [dto] = await this.toDtos([row!]);
    return dto!;
  }

  async getSharedForUser(id: string, actorId: string): Promise<SharedVolumeDto> {
    const row = await this.repository.findById(id);
    this.requireShared(row, actorId, 'user');
    const [dto] = await this.toSharedDtos([row!]);
    return dto!;
  }

  async getSharedForAdmin(id: string): Promise<SharedVolumeDto> {
    const row = await this.repository.findById(id);
    this.requireShared(row, undefined, 'admin');
    const [dto] = await this.toSharedDtos([row!]);
    return dto!;
  }

  async capacityForUser(ownerId: string, serverId: string): Promise<StorageCapacityDto> {
    await this.assertServerGrant(ownerId, serverId);
    const grant = await this.effectiveServerGrant(ownerId, serverId);
    const pools = (await this.pools.list(serverId)).filter((pool) => pool.shared_backend_id === null);
    const overcommitRatio = await this.serverOvercommit(serverId);
    const poolDtos = [];
    const sums = await this.ownerServerCommittedBytes(ownerId, serverId, undefined);
    const usedRoot = sums.root;
    const usedLocal = sums.local;
    for (const pool of pools) {
      const committed = await this.committedPoolBytes(pool.id);
      const available = pool.total_bytes === null
        ? null
        : Math.max(
          0,
          numberValue(pool.total_bytes)
            * overcommitRatio
            - committed,
        );
      poolDtos.push({
        poolId: pool.id,
        displayName: pool.display_name,
        driver: pool.driver as StorageCapacityDto['pools'][number]['driver'],
        shareable: pool.shareable,
        totalBytes: pool.total_bytes === null ? null : numberValue(pool.total_bytes),
        committedBytes: committed,
        availableBytes: available,
        quotaEffective: pool.quota_effective,
        overcommitRatio,
        capability: storagePoolCapability(
          pool.resize_family as StoragePoolResizeFamily,
          pool.quota_effective,
          pool.block_filesystem,
        ),
      });
    }
    const limit = grant?.disk_bytes === null
      || grant?.disk_bytes === undefined
      || numberValue(grant.disk_bytes) === 0
      ? null
      : numberValue(grant.disk_bytes);
    return {
      grantLimitBytes: limit,
      usedByRootDisksBytes: usedRoot,
      usedByLocalVolumesBytes: usedLocal,
      availableBytes: limit === null ? null : Math.max(0, limit - usedRoot - usedLocal),
      pools: poolDtos,
    };
  }

  async capacityForAdmin(serverId: string): Promise<StorageCapacityDto> {
    const pools = (await this.pools.list(serverId)).filter((pool) => pool.shared_backend_id === null);
    const overcommitRatio = await this.serverOvercommit(serverId);
    const poolDtos = [];
    for (const pool of pools) {
      const committed = await this.committedPoolBytes(pool.id);
      poolDtos.push({
        poolId: pool.id,
        displayName: pool.display_name,
        driver: pool.driver as StorageCapacityDto['pools'][number]['driver'],
        shareable: pool.shareable,
        totalBytes: pool.total_bytes === null ? null : numberValue(pool.total_bytes),
        committedBytes: committed,
        availableBytes: pool.total_bytes === null
          ? null
          : Math.max(0, numberValue(pool.total_bytes) * overcommitRatio - committed),
        quotaEffective: pool.quota_effective,
        overcommitRatio,
        capability: storagePoolCapability(
          pool.resize_family as StoragePoolResizeFamily,
          pool.quota_effective,
          pool.block_filesystem,
        ),
      });
    }
    const sums = await this.ownerServerCommittedBytesForAll(serverId);
    return {
      grantLimitBytes: null,
      usedByRootDisksBytes: sums.root,
      usedByLocalVolumesBytes: sums.local,
      availableBytes: null,
      pools: poolDtos,
    };
  }

  async createForUser(
    actorId: string,
    input: {
      ownerId?: string;
      name: string;
      sizeBytes: number;
      scope: LocalVolumeScope;
    },
  ): Promise<IntentAcceptedDto> {
    if (input.ownerId) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'User volume creation cannot specify ownerId',
      });
    }
    if (input.scope.kind !== 'local') {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Shared volumes must be created via /shared-volumes',
      });
    }
    return this.createVolume(actorId, actorId, input, 'user');
  }

  async createForAdmin(
    actorId: string,
    input: {
      ownerId: string;
      name: string;
      sizeBytes: number;
      scope: LocalVolumeScope;
    },
  ): Promise<IntentAcceptedDto> {
    if (!input.ownerId) {
      throw new BadRequestException('Admin volume creation requires ownerId');
    }
    if (input.scope.kind !== 'local') {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Shared volumes must be created via /shared-volumes',
      });
    }
    return this.createVolume(actorId, input.ownerId, input, 'admin');
  }

  async createSharedForUser(
    actorId: string,
    input: CreateSharedVolumeRequest,
  ): Promise<SharedVolumeDto> {
    if (input.ownerId) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'User volume creation cannot specify ownerId',
      });
    }
    return this.createSharedVolume(actorId, actorId, input, 'user');
  }

  async createSharedForAdmin(
    actorId: string,
    input: CreateSharedVolumeRequest & { ownerId: string },
  ): Promise<SharedVolumeDto> {
    if (!input.ownerId) {
      throw new BadRequestException('Admin volume creation requires ownerId');
    }
    return this.createSharedVolume(actorId, input.ownerId, input, 'admin');
  }

  private async createSharedVolume(
    actorId: string,
    ownerId: string,
    input: {
      name: string;
      sizeBytes: number;
      scope: SharedVolumeScope;
    },
    access: 'user' | 'admin',
  ): Promise<SharedVolumeDto> {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Volume size must be a positive safe integer',
      });
    }
    const id = randomUUID();
    const incusName = deterministicName('nyv', id);
    let row: VolumeRow;
    try {
      row = await this.transactions.run(
        async (transaction) => {
          if (access === 'user') {
            await this.assertSharedGrant(ownerId, input.scope.sharedBackendId, transaction);
          }
          await this.pools.lockSharedBackends([input.scope.sharedBackendId], transaction);
          await this.assertSharedCreateHealth(input.scope.sharedBackendId, transaction);
          if (access === 'admin') {
            await this.assertSharedCapacityForDeltaForAdmin(
              transaction,
              input.scope.sharedBackendId,
              input.sizeBytes,
            );
          } else {
            await this.assertSharedCapacityForDeltaForUser(
              transaction,
              ownerId,
              input.scope.sharedBackendId,
              input.sizeBytes,
            );
          }
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
        },
        { isolationLevel: 'serializable', maxAttempts: 5 },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'A volume with this name already exists in the storage scope',
          details: { name: input.name },
        });
      }
      throw error;
    }
    const [dto] = await this.toSharedDtos([row]);
    return dto!;
  }

  private async createVolume(
    actorId: string,
    ownerId: string,
    input: {
      name: string;
      sizeBytes: number;
      scope: LocalVolumeScope;
    },
    access: 'user' | 'admin',
  ): Promise<IntentAcceptedDto> {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Volume size must be a positive safe integer',
      });
    }
    const id = randomUUID();
    const incusName = deterministicName('nyv', id);
    let created;
    try {
      created = await this.transactions.run(
        async (transaction) => {
          const scope = access === 'admin'
            ? await this.resolveScopeForAdmin(transaction, input.scope)
            : await this.resolveScopeForUser(transaction, ownerId, input.scope);
          if (access === 'admin') {
            await this.assertCapacityForDeltaForAdmin(
              transaction,
              scope.serverId,
              scope.poolId,
              scope.sharedBackendId,
              input.sizeBytes,
            );
          } else {
            await this.assertCapacityForDeltaForUser(
              transaction,
              ownerId,
              scope.serverId,
              scope.poolId,
              scope.sharedBackendId,
              input.sizeBytes,
            );
          }
          const row = await this.repository.insert({
            id,
            ownerId,
            poolId: scope.poolId,
            serverId: scope.serverId,
            sharedBackendId: scope.sharedBackendId,
            name: input.name,
            incusName,
            sizeBytes: input.sizeBytes,
          }, transaction);
          await this.repository.upsertPlacement({
            volumeId: row.id,
            serverId: scope.anchorServerId,
            poolId: scope.poolId,
            catalogState: 'ensuring',
          }, transaction);
          const intent = await this.intents.createPending({
            kind: IntentKind.VolumeEnsure,
            resourceType: IntentResourceType.Volume,
            resourceId: row.id,
            serverId: scope.anchorServerId,
            requestedBy: actorId,
            targetGeneration: row.generation,
            request: {
              operation: 'create',
              idempotencyKey: 'create',
              sizeBytes: input.sizeBytes,
            },
          }, transaction);
          await this.audit.append(
            transaction,
            actorId,
            AuditAction.CreateVolume,
            row.id,
            'volume',
            { sizeBytes: input.sizeBytes, scope: input.scope },
          );
          return { row, intent };
        },
        { isolationLevel: 'serializable', maxAttempts: 5 },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'A volume with this name already exists in the storage scope',
          details: { name: input.name },
        });
      }
      throw error;
    }
    this.wake.wake({
      resourceType: IntentResourceType.Volume,
      resourceId: created.row.id,
      serverId: created.intent.serverId,
      reason: 'intent',
    });
    return acceptedIntent(created.intent);
  }

  async patchForUser(
    actorId: string,
    id: string,
    input: { expectedRevision: number; name?: string; sizeBytes?: number },
  ): Promise<VolumeDto | IntentAcceptedDto> {
    return this.patchVolume(actorId, id, input, 'user');
  }

  async patchForAdmin(
    actorId: string,
    id: string,
    input: { expectedRevision: number; name?: string; sizeBytes?: number },
  ): Promise<VolumeDto | IntentAcceptedDto> {
    return this.patchVolume(actorId, id, input, 'admin');
  }

  async patchSharedForUser(
    actorId: string,
    id: string,
    input: { expectedRevision: number; name?: string; sizeBytes?: number },
  ): Promise<SharedVolumeDto | IntentAcceptedDto> {
    return this.patchSharedVolume(actorId, id, input, 'user');
  }

  async patchSharedForAdmin(
    actorId: string,
    id: string,
    input: { expectedRevision: number; name?: string; sizeBytes?: number },
  ): Promise<SharedVolumeDto | IntentAcceptedDto> {
    return this.patchSharedVolume(actorId, id, input, 'admin');
  }

  private async patchVolume(
    actorId: string,
    id: string,
    input: { expectedRevision: number; name?: string; sizeBytes?: number },
    access: 'user' | 'admin',
  ): Promise<VolumeDto | IntentAcceptedDto> {
    const current = await this.repository.findById(id);
    this.requireLocal(current, actorId, access);
    if (current.generation !== input.expectedRevision) {
      throw new ConflictException({ code: FailureCode.RevisionConflict });
    }
    if (current.lifecycle_phase === 'deleting') {
      throw new ConflictException({
        code: FailureCode.InvalidInput,
        message: 'A deleting volume cannot be modified',
        details: { volumeId: id, lifecyclePhase: current.lifecycle_phase },
      });
    }
    if (
      input.sizeBytes !== undefined
      && (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0)
    ) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Volume size must be a positive safe integer',
      });
    }
    if (input.sizeBytes === undefined || input.sizeBytes === numberValue(current.size_bytes)) {
      if (input.name === undefined || input.name === current.name) {
        const [dto] = await this.toDtos([current]);
        return dto!;
      }
      const updated = await this.transactions.run(async (transaction) => {
        const locked = await this.repository.findById(id, transaction);
        if (!locked || locked.generation !== input.expectedRevision) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }
        const row = await this.repository.updateDesired(
          id,
          locked.generation,
          { name: input.name },
          transaction,
        );
        if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.UpdateVolume,
          id,
          'volume',
          { name: input.name },
        );
        return row;
      }, { isolationLevel: 'serializable', maxAttempts: 5 });
      const [dto] = await this.toDtos([updated]);
      return dto!;
    }
    const delta = input.sizeBytes - numberValue(current.size_bytes);
    const pool = current.pool_id
      ? await this.pools.findById(current.pool_id)
      : null;
    if (!pool) throw new NotFoundException('Volume pool not found');
    const precheckAttachments = delta < 0
      && pool.resize_family === StoragePoolResizeFamily.BlockBacked
      ? (await this.repository.listAttachments(undefined, id)).map((attachment) => ({
        attachmentId: attachment.id,
        containerId: attachment.container_id,
        containerPath: attachment.container_path,
      }))
      : [];
    const precheckFailure = checkVolumeResize({
      volumeId: id,
      poolId: pool.id,
      currentSizeBytes: numberValue(current.size_bytes),
      requestedSizeBytes: input.sizeBytes,
      usedBytes: current.used_bytes === null ? null : numberValue(current.used_bytes),
      resizeFamily: pool.resize_family as StoragePoolResizeFamily,
      blockFilesystem: pool.block_filesystem,
      attachments: precheckAttachments,
    });
    if (precheckFailure) {
      throw new ConflictException(precheckFailure);
    }
    const changed = await this.transactions.run(async (transaction) => {
      const locked = await this.repository.findById(id, transaction);
      if (!locked || locked.generation !== input.expectedRevision) {
        throw new ConflictException({ code: FailureCode.RevisionConflict });
      }
      const lockedDelta = input.sizeBytes! - numberValue(locked.size_bytes);
      await this.lockVolumeQuota(locked, transaction);
      const representativePoolId = locked.pool_id
        ?? (await this.repository.listPlacements(id, transaction))[0]?.pool_id
        ?? null;
      if (!representativePoolId) {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'A volume with no catalog registration cannot be resized',
        });
      }
      const lockedPool = await this.pools.findById(representativePoolId, transaction);
      if (!lockedPool) throw new NotFoundException('Volume pool not found');
      const scopeMatches = locked.server_id === null
        ? lockedPool.registered
          && lockedPool.shared_backend_id === locked.shared_backend_id
          && lockedPool.shareable
        : lockedPool.registered
          && lockedPool.server_id === locked.server_id
          && lockedPool.shared_backend_id === null
          && !lockedPool.shareable;
      if (!scopeMatches) {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'The volume storage scope changed while it was being modified',
          details: { volumeId: id, poolId: locked.pool_id },
        });
      }
      const lockedAttachments = lockedDelta < 0
        && lockedPool.resize_family === StoragePoolResizeFamily.BlockBacked
        ? (await this.repository.listAttachments(undefined, id, transaction)).map((attachment) => ({
          attachmentId: attachment.id,
          containerId: attachment.container_id,
          containerPath: attachment.container_path,
        }))
        : [];
      const lockedFailure = checkVolumeResize({
        volumeId: id,
        poolId: lockedPool.id,
        currentSizeBytes: numberValue(locked.size_bytes),
        requestedSizeBytes: input.sizeBytes!,
        usedBytes: locked.used_bytes === null ? null : numberValue(locked.used_bytes),
        resizeFamily: lockedPool.resize_family as StoragePoolResizeFamily,
        blockFilesystem: lockedPool.block_filesystem,
        attachments: lockedAttachments,
      });
      if (lockedFailure) {
        throw new ConflictException(lockedFailure);
      }
      if (lockedDelta > 0) {
        if (access === 'admin') {
          await this.assertCapacityForDeltaForAdmin(
            transaction,
            locked.server_id,
            representativePoolId,
            locked.shared_backend_id,
            lockedDelta,
          );
        } else {
          await this.assertCapacityForDeltaForUser(
            transaction,
            locked.owner_id,
            locked.server_id,
            representativePoolId,
            locked.shared_backend_id,
            lockedDelta,
          );
        }
      }
      const row = await this.repository.updateDesired(
        id,
        locked.generation,
        { ...(input.name === undefined ? {} : { name: input.name }), size_bytes: input.sizeBytes },
        transaction,
      );
      if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
      const placements = await this.repository.listPlacements(id, transaction);
      if (placements.length === 0) {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'A volume with no catalog registration cannot be resized',
        });
      }
      const intents = [];
      for (const placement of placements) {
        intents.push(await this.intents.createPending({
          kind: IntentKind.VolumeResize,
          resourceType: IntentResourceType.Volume,
          resourceId: id,
          serverId: placement.server_id,
          requestedBy: actorId,
          targetGeneration: row.generation,
          request: {
            operation: 'resize',
            idempotencyKey: 'resize',
            sizeBytes: input.sizeBytes,
          },
        }, transaction));
      }
      const intent = intents[0]!;
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.ResizeVolume,
        id,
        'volume',
        { sizeBytes: input.sizeBytes },
      );
      return { row, intent };
    }, { isolationLevel: 'serializable', maxAttempts: 5 });
    this.wake.wake({
      resourceType: IntentResourceType.Volume,
      resourceId: id,
      serverId: changed.intent.serverId,
      reason: 'intent',
    });
    return acceptedIntent(changed.intent);
  }

  private async patchSharedVolume(
    actorId: string,
    id: string,
    input: { expectedRevision: number; name?: string; sizeBytes?: number },
    access: 'user' | 'admin',
  ): Promise<SharedVolumeDto | IntentAcceptedDto> {
    const current = await this.repository.findById(id);
    this.requireShared(current, actorId, access);
    if (current.generation !== input.expectedRevision) {
      throw new ConflictException({ code: FailureCode.RevisionConflict });
    }
    if (current.lifecycle_phase === 'deleting') {
      throw new ConflictException({
        code: FailureCode.InvalidInput,
        message: 'A deleting volume cannot be modified',
        details: { volumeId: id, lifecyclePhase: current.lifecycle_phase },
      });
    }
    if (
      input.sizeBytes !== undefined
      && (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0)
    ) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Volume size must be a positive safe integer',
      });
    }
    if (input.sizeBytes === undefined || input.sizeBytes === numberValue(current.size_bytes)) {
      if (input.name === undefined || input.name === current.name) {
        const [dto] = await this.toSharedDtos([current]);
        return dto!;
      }
      const updated = await this.transactions.run(async (transaction) => {
        const locked = await this.repository.findById(id, transaction);
        this.requireShared(locked, actorId, access);
        if (locked.generation !== input.expectedRevision) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }
        const row = await this.repository.updateDesired(
          id,
          locked.generation,
          { name: input.name },
          transaction,
        );
        if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.UpdateVolume,
          id,
          'volume',
          { name: input.name },
        );
        return row;
      }, { isolationLevel: 'serializable', maxAttempts: 5 });
      const [dto] = await this.toSharedDtos([updated]);
      return dto!;
    }
    const changed = await this.transactions.run(async (transaction) => {
      const locked = await this.repository.findById(id, transaction);
      this.requireShared(locked, actorId, access);
      if (locked.generation !== input.expectedRevision) {
        throw new ConflictException({ code: FailureCode.RevisionConflict });
      }
      if (access === 'user') {
        await this.assertSharedGrant(locked.owner_id, locked.shared_backend_id!, transaction);
      }
      const lockedDelta = input.sizeBytes! - numberValue(locked.size_bytes);
      await this.lockVolumeQuota(locked, transaction);
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
        requestedSizeBytes: input.sizeBytes!,
        usedBytes: locked.used_bytes === null ? null : numberValue(locked.used_bytes),
        resizeFamily: StoragePoolResizeFamily.QuotaOnline,
        blockFilesystem: null,
        attachments: [],
      });
      if (precheckFailure && quotaEffective) {
        throw new ConflictException(precheckFailure);
      }
      if (lockedDelta > 0) {
        if (access === 'admin') {
          await this.assertSharedCapacityForDeltaForAdmin(
            transaction,
            locked.shared_backend_id!,
            lockedDelta,
          );
        } else {
          await this.assertSharedCapacityForDeltaForUser(
            transaction,
            locked.owner_id,
            locked.shared_backend_id!,
            lockedDelta,
          );
        }
      }
      const row = await this.repository.updateDesired(
        id,
        locked.generation,
        { ...(input.name === undefined ? {} : { name: input.name }), size_bytes: input.sizeBytes },
        transaction,
      );
      if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
      if (placements.length === 0) {
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.ResizeVolume,
          id,
          'volume',
          { sizeBytes: input.sizeBytes },
        );
        return { row, intent: null, serverIds: [] as string[] };
      }
      const intents = [];
      for (const placement of placements) {
        intents.push(await this.intents.createPending({
          kind: IntentKind.VolumeResize,
          resourceType: IntentResourceType.Volume,
          resourceId: id,
          serverId: placement.server_id,
          requestedBy: actorId,
          targetGeneration: row.generation,
          request: {
            operation: 'resize',
            idempotencyKey: 'resize',
            sizeBytes: input.sizeBytes,
          },
        }, transaction));
      }
      const intent = intents[0]!;
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.ResizeVolume,
        id,
        'volume',
        { sizeBytes: input.sizeBytes },
      );
      return { row, intent, serverIds: [...new Set(intents.map((item) => item.serverId).filter((value): value is string => Boolean(value)))] };
    }, { isolationLevel: 'serializable', maxAttempts: 5 });
    if (!changed.intent) {
      const [dto] = await this.toSharedDtos([changed.row]);
      return dto!;
    }
    for (const serverId of changed.serverIds.length > 0 ? changed.serverIds : [changed.intent.serverId]) {
      this.wake.wake({
        resourceType: IntentResourceType.Volume,
        resourceId: id,
        serverId,
        reason: 'intent',
      });
    }
    return acceptedIntent(changed.intent);
  }

  async deleteForUser(actorId: string, id: string) {
    return this.deleteVolume(actorId, id, 'user', 'local');
  }

  async deleteForAdmin(actorId: string, id: string) {
    return this.deleteVolume(actorId, id, 'admin', 'local');
  }

  async deleteSharedForUser(actorId: string, id: string) {
    return this.deleteVolume(actorId, id, 'user', 'shared');
  }

  async deleteSharedForAdmin(actorId: string, id: string) {
    return this.deleteVolume(actorId, id, 'admin', 'shared');
  }

  private async deleteVolume(
    actorId: string,
    id: string,
    access: 'user' | 'admin',
    kind: 'local' | 'shared',
  ) {
    const result = await this.transactions.run(async (transaction) => {
      const current = await this.repository.findById(id, transaction);
      if (kind === 'local') this.requireLocal(current, actorId, access);
      else this.requireShared(current, actorId, access);
      if (current.lifecycle_phase === 'deleting') {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'Volume deletion is already in progress',
          details: { volumeId: id },
        });
      }
      await this.lockVolumeQuota(current, transaction);
      if (await this.repository.hasAttachments(id, transaction)) {
        throw new ConflictException({
          code: FailureCode.VolumeRequiresUnbind,
          message: 'Detach all volume attachments before deleting the volume',
        });
      }
      const placements = await this.repository.listPlacements(id, transaction);
      if (kind === 'local') {
        if (placements.length > 0) {
          const server = await transaction.selectFrom('infra.servers')
            .select(['id', 'name', 'status'])
            .where('id', '=', current.server_id)
            .executeTakeFirst();
          if (!server || server.status !== 'online') {
            throw new ConflictException({
              code: FailureCode.ServerUnreachable,
              message: 'The volume server is unreachable; contact an administrator',
              details: {
                serverId: server?.id ?? current.server_id,
                serverName: server?.name ?? current.server_id,
              },
            });
          }
        }
      } else {
        if (!current.dir_ensured && placements.length === 0) {
          await this.settlePendingVolumeIntents(id, transaction);
          await this.repository.deleteVolumeRow(id, transaction);
          const intent = await this.intents.createPending({
            kind: IntentKind.VolumeDestroy,
            resourceType: IntentResourceType.Volume,
            resourceId: id,
            requestedBy: actorId,
            targetGeneration: current.generation,
            request: {
              operation: 'destroy',
              idempotencyKey: 'destroy',
              note: 'never_mounted',
            },
          }, transaction);
          await this.intents.settleOne(intent.id, { outcome: 'succeeded' }, transaction);
          await this.audit.append(transaction, actorId, AuditAction.DeleteVolume, id, 'volume', {
            reason: 'never_mounted',
          });
          return { row: current, intent, deleted: true as const };
        }
        const eligible = current.shared_backend_id
          ? await listEligibleDestroyExecutors(transaction, current.shared_backend_id)
          : [];
        if (eligible.length === 0) {
          throw new ConflictException({
            code: FailureCode.VolumeDeleteBackendUnreachable,
            message: '没有在线服务器可以访问该共享存储，请联系管理员。',
            details: { sharedBackendId: current.shared_backend_id },
          });
        }
      }
      if (kind === 'local' && placements.length === 0) {
        await this.settlePendingVolumeIntents(id, transaction);
        await this.repository.deleteVolumeRow(id, transaction);
        const intent = await this.intents.createPending({
          kind: IntentKind.VolumeDestroy,
          resourceType: IntentResourceType.Volume,
          resourceId: id,
          requestedBy: actorId,
          targetGeneration: current.generation,
          request: {
            operation: 'destroy',
            idempotencyKey: 'destroy',
            note: 'empty_tracking',
          },
        }, transaction);
        await this.intents.settleOne(intent.id, { outcome: 'succeeded' }, transaction);
        await this.audit.append(transaction, actorId, AuditAction.DeleteVolume, id, 'volume', {
          reason: 'empty_tracking',
        });
        return { row: current, intent, deleted: true as const };
      }
      const row = await this.repository.updateDesired(
        id,
        current.generation,
        { lifecycle_phase: 'deleting', needs_attention: false, failure_code: null },
        transaction,
      );
      if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
      const intent = await this.intents.createPending({
        kind: IntentKind.VolumeDestroy,
        resourceType: IntentResourceType.Volume,
        resourceId: id,
        requestedBy: actorId,
        targetGeneration: row.generation,
        request: { operation: 'destroy', idempotencyKey: 'destroy' },
      }, transaction);
      await this.audit.append(transaction, actorId, AuditAction.DeleteVolume, id, 'volume');
      return { row, intent, deleted: false as const };
    }, { isolationLevel: 'serializable', maxAttempts: 5 });
    this.wake.wake({
      resourceType: IntentResourceType.Volume,
      resourceId: id,
      serverId: result.intent.serverId,
      reason: 'intent',
    });
    return acceptedIntent(result.intent);
  }

  private async settlePendingVolumeIntents(
    volumeId: string,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    const pending = await transaction
      .selectFrom('control.intents')
      .select('id')
      .where('resource_type', '=', 'volume')
      .where('resource_id', '=', volumeId)
      .where('status', '=', 'pending')
      .execute();
    for (const row of pending) {
      await this.intents.settleOne(row.id, { outcome: 'succeeded' }, transaction);
    }
  }

  async listAttachmentsForUser(
    actorId: string,
    containerId: string,
    kind: 'local' | 'shared',
  ): Promise<VolumeAttachmentDto[]> {
    const container = await this.database.selectFrom('control.containers')
      .select(['id', 'owner_id', 'server_id'])
      .where('id', '=', containerId)
      .executeTakeFirst();
    if (!container || container.owner_id !== actorId) {
      throw new NotFoundException('Container not found');
    }
    return this.listAttachmentDtos(containerId, container.server_id, kind);
  }

  async listAttachmentsForAdmin(
    containerId: string,
    kind: 'local' | 'shared',
  ): Promise<VolumeAttachmentDto[]> {
    const container = await this.database.selectFrom('control.containers')
      .select(['id', 'owner_id', 'server_id'])
      .where('id', '=', containerId)
      .executeTakeFirst();
    if (!container) {
      throw new NotFoundException('Container not found');
    }
    return this.listAttachmentDtos(containerId, container.server_id, kind);
  }

  async attachForUser(
    actorId: string,
    containerId: string,
    input: AttachVolumeRequest,
    kind: 'local' | 'shared',
  ): Promise<IntentAcceptedDto> {
    return this.attachVolume(actorId, containerId, input, 'user', kind);
  }

  async attachForAdmin(
    actorId: string,
    containerId: string,
    input: AttachVolumeRequest,
    kind: 'local' | 'shared',
  ): Promise<IntentAcceptedDto> {
    return this.attachVolume(actorId, containerId, input, 'admin', kind);
  }

  async bindCreateTimeVolumes(
    transaction: Transaction<NyabaseDatabase>,
    actorId: string,
    access: 'user' | 'admin',
    container: { id: string; owner_id: string; server_id: string },
    volumes: readonly AttachVolumeRequest[],
  ): Promise<void> {
    for (const input of volumes) {
      await this.bindAttachmentRow(transaction, actorId, access, container, input, null);
    }
  }

  private async attachVolume(
    actorId: string,
    containerId: string,
    input: AttachVolumeRequest,
    access: 'user' | 'admin',
    kind: 'local' | 'shared',
  ): Promise<IntentAcceptedDto> {
    const result = await this.transactions.run(async (transaction) => {
      const container = await transaction.selectFrom('control.containers').selectAll()
        .where('id', '=', containerId).forUpdate().executeTakeFirst();
      if (!container || (access === 'user' && container.owner_id !== actorId)) {
        throw new NotFoundException('Container not found');
      }
      const generation = Number(container.generation) + 1;
      await transaction.updateTable('control.containers')
        .set({ generation, needs_attention: false })
        .where('id', '=', containerId)
        .where('generation', '=', container.generation)
        .executeTakeFirstOrThrow();
      const attachment = await this.bindAttachmentRow(
        transaction,
        actorId,
        access,
        container,
        input,
        kind,
      );
      const intent = await this.intents.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId: containerId,
        serverId: container.server_id,
        requestedBy: actorId,
        targetGeneration: generation,
        blockedByIntentId: null,
        request: { operation: 'attach_volume', volumeId: input.volumeId, attachmentId: attachment.id },
      }, transaction);
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.AttachVolume,
        attachment.id,
        'volume_attachment',
        { containerId, volumeId: input.volumeId },
      );
      return { intent };
    }, { isolationLevel: 'serializable', maxAttempts: 5 }).catch((error: unknown) => {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'The volume is already attached to this container or the path is in use',
          details: { containerId, volumeId: input.volumeId, containerPath: input.containerPath },
        });
      }
      throw error;
    });
    this.wake.wake({
      resourceType: IntentResourceType.Container,
      resourceId: containerId,
      serverId: result.intent.serverId,
      reason: 'intent',
    });
    return acceptedIntent(result.intent);
  }

  private async bindAttachmentRow(
    transaction: Transaction<NyabaseDatabase>,
    actorId: string,
    access: 'user' | 'admin',
    container: { id: string; owner_id: string; server_id: string },
    input: AttachVolumeRequest,
    expectedKind: 'local' | 'shared' | null,
  ): Promise<{ id: string }> {
    const volume = await transaction.selectFrom('control.volumes').selectAll()
      .where('id', '=', input.volumeId).forUpdate().executeTakeFirst();
    const volumeKind: 'local' | 'shared' | null = !volume
      ? null
      : volume.shared_backend_id !== null ? 'shared' : 'local';
    if (
      !volume
      || (access === 'user' && volume.owner_id !== actorId)
      || (expectedKind !== null && volumeKind !== expectedKind)
    ) {
      throw new NotFoundException('Volume not found');
    }
    if (volume.owner_id !== container.owner_id) {
      throw new ForbiddenException('A volume may only attach to its owner container');
    }
    if (volume.lifecycle_phase === 'deleting' || volume.lifecycle_phase === 'failed') {
      throw new ConflictException({
        code: FailureCode.InvalidInput,
        message: 'A deleting or failed volume cannot be attached',
        details: { volumeId: volume.id, lifecyclePhase: volume.lifecycle_phase },
      });
    }
    if (volume.shared_backend_id !== null && access === 'user') {
      await this.assertSharedGrant(volume.owner_id, volume.shared_backend_id, transaction);
    }
    if (volume.server_id !== null && volume.server_id !== container.server_id) {
      throw new ConflictException({
        code: FailureCode.VolumeCrossServerDenied,
        message: 'A local volume can only attach on its pool server',
        details: {
          volumeId: volume.id,
          serverId: container.server_id,
          reason: 'local_pool_server_mismatch',
        },
      });
    }
    let placementPoolId = volume.pool_id;
    if (volume.shared_backend_id !== null) {
      const visible = await transaction.selectFrom('infra.storage_pools')
        .select('id')
        .where('shared_backend_id', '=', volume.shared_backend_id)
        .where('server_id', '=', container.server_id)
        .where('driver', '=', 'cephfs')
        .where('shareable', '=', true)
        .where('registered', '=', true)
        .execute();
      if (visible.length !== 1) throw new ConflictException({
        code: FailureCode.VolumeCrossServerDenied,
        message: 'The shared backend is not registered on the target server',
        details: {
          volumeId: volume.id,
          serverId: container.server_id,
          reason: 'backend_not_reachable',
        },
      });
      placementPoolId = visible[0]!.id;
    }
    if (!placementPoolId) {
      throw new ConflictException({
        code: FailureCode.VolumeCrossServerDenied,
        message: 'A local volume is missing its pool',
      });
    }
    const occupied = await transaction.selectFrom('control.volume_attachments')
      .select(['id', 'volume_id', 'container_path'])
      .where('container_id', '=', container.id)
      .where((expression) => expression.or([
        expression('volume_id', '=', volume.id),
        expression('container_path', '=', input.containerPath),
      ]))
      .executeTakeFirst();
    if (occupied) {
      throw new ConflictException({
        code: FailureCode.InvalidInput,
        message: 'The volume is already attached to this container or the path is in use',
        details: {
          containerId: container.id,
          volumeId: volume.id,
          containerPath: input.containerPath,
          attachmentId: occupied.id,
        },
      });
    }
    const attachmentId = randomUUID();
    const attachment = await this.repository.insertAttachment({
      id: attachmentId,
      containerId: container.id,
      volumeId: volume.id,
      deviceName: deterministicName('nyd', attachmentId),
      containerPath: input.containerPath,
      readOnly: input.readOnly,
      bindState: 'attaching',
    }, transaction);
    await this.repository.upsertPlacement({
      volumeId: volume.id,
      serverId: container.server_id,
      poolId: placementPoolId,
      catalogState: 'ensuring',
    }, transaction);
    return attachment;
  }

  async detachForUser(
    actorId: string,
    attachmentId: string,
    expectedContainerId: string,
    kind: 'local' | 'shared',
  ): Promise<unknown> {
    return this.detachVolume(actorId, attachmentId, 'user', expectedContainerId, kind);
  }

  async detachForAdmin(
    actorId: string,
    attachmentId: string,
    expectedContainerId: string,
    kind: 'local' | 'shared',
  ): Promise<unknown> {
    return this.detachVolume(actorId, attachmentId, 'admin', expectedContainerId, kind);
  }

  private async detachVolume(
    actorId: string,
    attachmentId: string,
    access: 'user' | 'admin',
    expectedContainerId: string,
    kind: 'local' | 'shared',
  ): Promise<unknown> {
    const result = await this.transactions.run(async (transaction) => {
      const attachment = await transaction
        .selectFrom('control.volume_attachments as a')
        .innerJoin('control.volumes as v', 'v.id', 'a.volume_id')
        .selectAll('a')
        .select('v.shared_backend_id as shared_backend_id')
        .where('a.id', '=', attachmentId)
        .forUpdate('a')
        .executeTakeFirst();
      if (!attachment || attachment.container_id !== expectedContainerId) {
        throw new NotFoundException('Volume attachment not found');
      }
      const attachmentKind = attachment.shared_backend_id !== null ? 'shared' : 'local';
      if (attachmentKind !== kind) {
        throw new NotFoundException('Volume attachment not found');
      }
      const container = await transaction.selectFrom('control.containers').selectAll()
        .where('id', '=', attachment.container_id).forUpdate().executeTakeFirst();
      if (!container || (access === 'user' && container.owner_id !== actorId)) {
        throw new NotFoundException('Container not found');
      }
      const placement = await this.repository.findPlacement(
        attachment.volume_id,
        container.server_id,
        transaction,
      );
      const catalogPresent = placement?.catalog_state === 'present';
      const route = await transaction.selectFrom('control.container_ssh_routes')
        .select('instance_status')
        .where('container_id', '=', container.id)
        .executeTakeFirst();
      const observedStopped = (route?.instance_status ?? '').toLowerCase() === 'stopped';
      const powerStopped = container.power_intent === 'stopped';
      const requiresStop = attachment.bind_state === 'attached'
        || (attachment.bind_state === 'attaching' && catalogPresent);
      if (requiresStop && !(observedStopped && powerStopped)) {
        throw new ConflictException({
          code: FailureCode.VolumeDetachRequiresStop,
          message: '请先停止容器',
          details: { containerId: container.id, attachmentId },
        });
      }
      await this.repository.setAttachmentBindState(attachmentId, 'detaching', transaction);
      const generation = Number(container.generation) + 1;
      const updated = await transaction.updateTable('control.containers').set({
        generation,
        needs_attention: false,
      })
        .where('id', '=', container.id)
        .where('generation', '=', container.generation)
        .returning('id')
        .executeTakeFirst();
      if (!updated) {
        throw new ConflictException({ code: FailureCode.RevisionConflict });
      }
      const intent = await this.intents.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId: container.id,
        serverId: container.server_id,
        requestedBy: actorId,
        targetGeneration: generation,
        request: { operation: 'detach_volume', attachmentId },
      }, transaction);
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.DetachVolume,
        attachmentId,
        'volume_attachment',
        { containerId: container.id, volumeId: attachment.volume_id },
      );
      return intent;
    }, { isolationLevel: 'serializable', maxAttempts: 5 });
    this.wake.wake({
      resourceType: IntentResourceType.Container,
      resourceId: expectedContainerId,
      serverId: result.serverId,
      reason: 'intent',
    });
    return acceptedIntent(result);
  }

  private async resolveScopeForUser(
    transaction: Transaction<NyabaseDatabase>,
    ownerId: string,
    scope: LocalVolumeScope,
  ): Promise<{
    poolId: string;
    serverId: string;
    sharedBackendId: null;
    anchorServerId: string;
  }> {
    const resolved = await this.resolveScopeCore(transaction, scope);
    await this.assertServerGrant(ownerId, scope.serverId, transaction);
    await this.assertPoolGrant(ownerId, resolved.poolId, transaction);
    return resolved;
  }

  private async resolveScopeForAdmin(
    transaction: Transaction<NyabaseDatabase>,
    scope: LocalVolumeScope,
  ): Promise<{
    poolId: string;
    serverId: string;
    sharedBackendId: null;
    anchorServerId: string;
  }> {
    return this.resolveScopeCore(transaction, scope);
  }

  private async resolveScopeCore(
    transaction: Transaction<NyabaseDatabase>,
    scope: LocalVolumeScope,
  ): Promise<{
    poolId: string;
    serverId: string;
    sharedBackendId: null;
    anchorServerId: string;
  }> {
    const pool = await transaction.selectFrom('infra.storage_pools')
      .selectAll().where('id', '=', scope.poolId).executeTakeFirst();
    if (!pool || !pool.registered) throw new NotFoundException('Registered storage pool not found');
    if (
      pool.server_id !== scope.serverId
      || pool.shared_backend_id !== null
      || pool.shareable
    ) {
      throw new BadRequestException('Local volume scope does not match the pool');
    }
    if (
      pool.resize_family === StoragePoolResizeFamily.QuotaOnline
      && pool.quota_effective === false
    ) {
      throw new ConflictException({
        code: FailureCode.StoragePoolQuotaIneffective,
        message: 'This storage pool cannot enforce custom volume quotas',
        details: { poolId: pool.id },
      });
    }
    const lockedPool = await this.pools.lockCapacityScope(
      pool.id,
      scope.serverId,
      [null],
      transaction,
    );
    if (
      !lockedPool.registered
      || lockedPool.server_id !== scope.serverId
      || lockedPool.shared_backend_id !== null
      || lockedPool.shareable
    ) {
      throw new BadRequestException('Local volume scope does not match the pool');
    }
    if (
      lockedPool.resize_family === StoragePoolResizeFamily.QuotaOnline
      && lockedPool.quota_effective === false
    ) {
      throw new ConflictException({
        code: FailureCode.StoragePoolQuotaIneffective,
        message: 'This storage pool cannot enforce custom volume quotas',
        details: { poolId: lockedPool.id },
      });
    }
    return {
      poolId: lockedPool.id,
      serverId: scope.serverId,
      sharedBackendId: null,
      anchorServerId: lockedPool.server_id,
    };
  }

  private async assertCapacityForDeltaForUser(
    transaction: Transaction<NyabaseDatabase>,
    ownerId: string,
    serverId: string | null,
    poolId: string,
    sharedBackendId: string | null,
    delta: number,
  ): Promise<void> {
    if (delta <= 0) return;
    await this.pools.lockCapacityScope(
      poolId,
      serverId,
      [sharedBackendId],
      transaction,
    );
    const pool = await transaction.selectFrom('infra.storage_pools')
      .selectAll().where('id', '=', poolId).executeTakeFirstOrThrow();
    if (sharedBackendId) {
      const backend = await transaction.selectFrom('infra.shared_backends')
        .selectAll().where('id', '=', sharedBackendId).executeTakeFirstOrThrow();
      const grant = await this.effectiveSharedGrant(ownerId, sharedBackendId, transaction);
      if (grant === undefined) {
        throw new ForbiddenException('Shared backend access is not granted');
      }
      const userUsed = await transaction.selectFrom('control.volumes')
        .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('used'))
        .where('owner_id', '=', ownerId)
        .where('shared_backend_id', '=', sharedBackendId)
        .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
        .executeTakeFirstOrThrow();
      if (
        grant !== null
        && grant > 0
        && numberValue(userUsed.used) + delta > grant
      ) {
        throw new ConflictException({
          code: FailureCode.SharedBackendQuotaExceeded,
          message: 'Shared backend grant quota exceeded',
          details: {
            sharedBackendId,
            requestedBytes: delta,
            availableBytes: Math.max(0, grant - numberValue(userUsed.used)),
            grantLimitBytes: grant,
          },
        });
      }
      await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, delta, transaction);
      return;
    }
    if (!serverId) throw new BadRequestException('Local capacity requires a server');
    const grant = await this.effectiveServerGrant(ownerId, serverId, transaction);
    if (!grant || !liveExpiry(grant.expires_at)) {
      throw new ForbiddenException('Server storage access is not granted');
    }
    const sums = await this.ownerServerCommittedBytes(ownerId, serverId, undefined, transaction);
    if (grant.disk_bytes !== null && grant.disk_bytes !== undefined
      && numberValue(grant.disk_bytes) > 0
      && sums.root + sums.local + delta > numberValue(grant.disk_bytes)) {
      throw new ConflictException({
        code: FailureCode.StorageGrantExceeded,
        message: 'Server storage grant exceeded',
        details: {
          requestedBytes: delta,
          availableBytes: Math.max(0, numberValue(grant.disk_bytes) - sums.root - sums.local),
          grantLimitBytes: numberValue(grant.disk_bytes),
        },
      });
    }
    await this.assertLocalPoolPhysicalCapacity(pool, poolId, serverId, delta, transaction);
  }

  private async assertCapacityForDeltaForAdmin(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string | null,
    poolId: string,
    sharedBackendId: string | null,
    delta: number,
  ): Promise<void> {
    if (delta <= 0) return;
    await this.pools.lockCapacityScope(
      poolId,
      serverId,
      [sharedBackendId],
      transaction,
    );
    const pool = await transaction.selectFrom('infra.storage_pools')
      .selectAll().where('id', '=', poolId).executeTakeFirstOrThrow();
    if (sharedBackendId) {
      const backend = await transaction.selectFrom('infra.shared_backends')
        .selectAll().where('id', '=', sharedBackendId).executeTakeFirstOrThrow();
      await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, delta, transaction);
      return;
    }
    if (!serverId) throw new BadRequestException('Local capacity requires a server');
    await this.assertLocalPoolPhysicalCapacity(pool, poolId, serverId, delta, transaction);
  }

  private async assertSharedCreateHealth(
    sharedBackendId: string,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    const pools = await transaction.selectFrom('infra.storage_pools')
      .select(['id', 'quota_effective'])
      .where('shared_backend_id', '=', sharedBackendId)
      .where('driver', '=', 'cephfs')
      .where('shareable', '=', true)
      .where('registered', '=', true)
      .execute();
    if (pools.length === 0) {
      throw new ConflictException({
        code: FailureCode.InvalidInput,
        message: '该共享后端尚未在任何服务器上登记可写配额的 CephFS 池',
        details: { sharedBackendId },
      });
    }
    if (!pools.some((pool) => pool.quota_effective === true)) {
      throw new ConflictException({
        code: FailureCode.StoragePoolQuotaIneffective,
        message: 'This shared CephFS pool cannot enforce custom volume quotas',
        details: { sharedBackendId },
      });
    }
  }

  private async assertSharedCapacityForDeltaForUser(
    transaction: Transaction<NyabaseDatabase>,
    ownerId: string,
    sharedBackendId: string,
    delta: number,
  ): Promise<void> {
    if (delta <= 0) return;
    await this.pools.lockSharedBackends([sharedBackendId], transaction);
    const backend = await transaction.selectFrom('infra.shared_backends')
      .selectAll().where('id', '=', sharedBackendId).executeTakeFirstOrThrow();
    const grant = await this.effectiveSharedGrant(ownerId, sharedBackendId, transaction);
    if (grant === undefined) {
      throw new ForbiddenException('Shared backend access is not granted');
    }
    const userUsed = await transaction.selectFrom('control.volumes')
      .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('used'))
      .where('owner_id', '=', ownerId)
      .where('shared_backend_id', '=', sharedBackendId)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .executeTakeFirstOrThrow();
    if (
      grant !== null
      && grant > 0
      && numberValue(userUsed.used) + delta > grant
    ) {
      throw new ConflictException({
        code: FailureCode.SharedBackendQuotaExceeded,
        message: 'Shared backend grant quota exceeded',
        details: {
          sharedBackendId,
          requestedBytes: delta,
          availableBytes: Math.max(0, grant - numberValue(userUsed.used)),
          grantLimitBytes: grant,
        },
      });
    }
    await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, delta, transaction);
  }

  private async assertSharedCapacityForDeltaForAdmin(
    transaction: Transaction<NyabaseDatabase>,
    sharedBackendId: string,
    delta: number,
  ): Promise<void> {
    if (delta <= 0) return;
    await this.pools.lockSharedBackends([sharedBackendId], transaction);
    const backend = await transaction.selectFrom('infra.shared_backends')
      .selectAll().where('id', '=', sharedBackendId).executeTakeFirstOrThrow();
    await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, delta, transaction);
  }

  private async assertSharedBackendPhysicalCapacity(
    backend: {
      total_bytes: string | number | null;
      overcommit_ratio: string | number;
    },
    sharedBackendId: string,
    delta: number,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    const committed = await transaction.selectFrom('control.volumes')
      .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('used'))
      .where('shared_backend_id', '=', sharedBackendId)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .executeTakeFirstOrThrow();
    if (
      backend.total_bytes !== null
      && numberValue(committed.used) + delta
        > numberValue(backend.total_bytes) * numberValue(backend.overcommit_ratio)
    ) {
      throw new ConflictException({
        code: FailureCode.SharedBackendQuotaExceeded,
        message: 'Shared backend capacity exhausted',
        details: {
          sharedBackendId,
          requestedBytes: delta,
          availableBytes: Math.max(
            0,
            numberValue(backend.total_bytes) * numberValue(backend.overcommit_ratio)
              - numberValue(committed.used),
          ),
          overcommitRatio: numberValue(backend.overcommit_ratio),
        },
      });
    }
  }

  private async assertLocalPoolPhysicalCapacity(
    pool: { total_bytes: string | number | null },
    poolId: string,
    serverId: string,
    delta: number,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    const committed = await this.committedPoolBytes(poolId, transaction);
    const total = pool.total_bytes === null ? null : numberValue(pool.total_bytes);
    const ratio = await this.serverOvercommit(serverId, transaction);
    if (total !== null && committed + delta > total * ratio) {
      throw new ConflictException({
        code: FailureCode.StoragePoolExhausted,
        message: 'Storage pool overcommit capacity exceeded',
        details: {
          poolId,
          requestedBytes: delta,
          availableBytes: Math.max(0, total * ratio - committed),
          overcommitRatio: ratio,
        },
      });
    }
  }

  private async effectiveServerGrant(
    ownerId: string,
    serverId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<GrantRow | null> {
    const rows = await executor.selectFrom('iam.server_grants as grant')
      .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
      .leftJoin('iam.groups as group', 'group.id', 'grant.group_id')
      .select([
        'grant.disk_bytes',
        'grant.expires_at',
        'grant.user_id',
        'grant.group_id',
        'grant.id',
        'group.priority as group_priority',
      ])
      .where('grant.server_id', '=', serverId)
      .where((expression) => expression.or([
        expression('grant.user_id', '=', ownerId),
        expression('member.user_id', '=', ownerId),
      ]))
      .forUpdate('grant')
      .execute();
    const active = rows.filter((row) => activeExpiry(row.expires_at));
    active.sort((left, right) => compareGrantCandidates(ownerId, left, right));
    return (active[0] ?? null) as GrantRow | null;
  }

  private async assertServerGrant(
    ownerId: string,
    serverId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<void> {
    const grant = await this.effectiveServerGrant(ownerId, serverId, executor);
    if (!grant || !liveExpiry(grant.expires_at)) {
      throw new ForbiddenException('Server storage access is not granted');
    }
  }

  private async assertPoolGrant(ownerId: string, poolId: string, executor: VolumeExecutor) {
    const rows = await executor.selectFrom('iam.storage_pool_grants as grant')
      .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
      .select(['grant.id', 'grant.expires_at'])
      .where('grant.pool_id', '=', poolId)
      .where((expression) => expression.or([
        expression('grant.user_id', '=', ownerId),
        expression('member.user_id', '=', ownerId),
      ]))
      .execute();
    if (!rows.some((row) => liveExpiry(row.expires_at))) {
      throw new ForbiddenException('Storage pool access is not granted');
    }
  }

  private async assertSharedGrant(ownerId: string, backendId: string, executor: VolumeExecutor) {
    const row = await this.effectiveSharedGrant(ownerId, backendId, executor);
    if (row === undefined) throw new ForbiddenException('Shared backend access is not granted');
  }

  private async effectiveSharedGrant(
    ownerId: string,
    backendId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<number | null | undefined> {
    const rows = await executor.selectFrom('iam.shared_backend_grants as grant')
      .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
      .leftJoin('iam.groups as group', 'group.id', 'grant.group_id')
      .select([
        'grant.limit_bytes',
        'grant.expires_at',
        'grant.user_id',
        'grant.group_id',
        'grant.id',
        'group.priority as group_priority',
      ])
      .where('grant.shared_backend_id', '=', backendId)
      .where((expression) => expression.or([
        expression('grant.user_id', '=', ownerId),
        expression('member.user_id', '=', ownerId),
      ]))
      .forUpdate('grant')
      .execute();
    const active = rows.filter((row) => liveExpiry(row.expires_at));
    active.sort((left, right) => compareGrantCandidates(ownerId, left, right));
    const winner = active[0] as SharedGrantRow | undefined;
    if (!winner) return undefined;
    return numberValue(winner.limit_bytes) === 0 ? null : numberValue(winner.limit_bytes);
  }

  private async committedPoolBytes(
    poolId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<number> {
    const [volumes, roots] = await Promise.all([
      executor.selectFrom('control.volumes').select(sql<string>`coalesce(sum(size_bytes), 0)`.as('bytes'))
        .where('pool_id', '=', poolId)
        .where('shared_backend_id', 'is', null)
        .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
        .executeTakeFirstOrThrow(),
      executor.selectFrom('control.containers').select(sql<string>`coalesce(sum(
        case when root_size_pending_bytes is null
          then root_size_bytes
          else greatest(root_size_bytes, root_size_pending_bytes)
        end
      ), 0)`.as('bytes'))
        .where('root_pool_id', '=', poolId)
        .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
        .executeTakeFirstOrThrow(),
    ]);
    return numberValue(volumes.bytes) + numberValue(roots.bytes);
  }

  private async ownerServerCommittedBytes(
    ownerId: string,
    serverId: string,
    poolId: string | undefined,
    executor: VolumeExecutor = this.database,
  ): Promise<{ root: number; local: number }> {
    let rootQuery = executor.selectFrom('control.containers').select(sql<string>`coalesce(sum(
        case when root_size_pending_bytes is null
          then root_size_bytes
          else greatest(root_size_bytes, root_size_pending_bytes)
        end
      ), 0)`.as('bytes'))
        .where('owner_id', '=', ownerId)
        .where('server_id', '=', serverId)
        .where('lifecycle_phase', 'not in', ['failed', 'deleting']);
    if (poolId !== undefined) {
      rootQuery = rootQuery.where('root_pool_id', '=', poolId);
    }
    let volumeQuery = executor.selectFrom('control.volumes')
      .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('bytes'))
        .where('owner_id', '=', ownerId)
        .where('server_id', '=', serverId)
        .where('shared_backend_id', 'is', null)
        .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
    if (poolId !== undefined) {
      volumeQuery = volumeQuery.where('pool_id', '=', poolId);
    }
    const [roots, volumes] = await Promise.all([
      rootQuery.executeTakeFirstOrThrow(),
      volumeQuery.executeTakeFirstOrThrow(),
    ]);
    return { root: numberValue(roots.bytes), local: numberValue(volumes.bytes) };
  }

  private async ownerServerCommittedBytesForAll(
    serverId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<{ root: number; local: number }> {
    const [roots, volumes] = await Promise.all([
      executor.selectFrom('control.containers').select(sql<string>`coalesce(sum(
        case when root_size_pending_bytes is null
          then root_size_bytes
          else greatest(root_size_bytes, root_size_pending_bytes)
        end
      ), 0)`.as('bytes'))
        .where('server_id', '=', serverId)
        .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
        .executeTakeFirstOrThrow(),
      executor.selectFrom('control.volumes')
        .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('bytes'))
        .where('server_id', '=', serverId)
        .where('shared_backend_id', 'is', null)
        .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
        .executeTakeFirstOrThrow(),
    ]);
    return { root: numberValue(roots.bytes), local: numberValue(volumes.bytes) };
  }

  private async serverOvercommit(serverId: string, executor: VolumeExecutor = this.database) {
    const server = await executor.selectFrom('infra.servers')
      .select('storage_overcommit_ratio')
      .where('id', '=', serverId)
      .executeTakeFirst();
    return server ? numberValue(server.storage_overcommit_ratio) : 1;
  }

  private async poolDescriptors(
    poolIds: readonly string[],
  ): Promise<Map<string, { capability: VolumeDto['capability']; poolName: string }>> {
    const ids = [...new Set(poolIds)];
    const result = new Map<string, { capability: VolumeDto['capability']; poolName: string }>();
    if (ids.length === 0) return result;
    const pools = await this.database
      .selectFrom('infra.storage_pools')
      .select(['id', 'resize_family', 'quota_effective', 'block_filesystem', 'display_name', 'incus_name'])
      .where('id', 'in', ids)
      .execute();
    for (const pool of pools) {
      result.set(pool.id, {
        capability: storagePoolCapability(
          pool.resize_family as StoragePoolResizeFamily,
          pool.quota_effective,
          pool.block_filesystem,
        ),
        poolName: poolLabel(pool.display_name, pool.incus_name),
      });
    }
    return result;
  }

  async inspectSharedVolumeCatalogs(volumeId: string): Promise<SharedVolumeCatalogInspectDto> {
    const volume = await this.repository.findById(volumeId);
    this.requireShared(volume, undefined, 'admin');
    const pools = await this.database
      .selectFrom('infra.storage_pools as p')
      .innerJoin('infra.servers as s', 's.id', 'p.server_id')
      .select([
        's.id as server_id',
        's.name as server_name',
        's.status as server_status',
        'p.id as pool_id',
        'p.incus_name as pool_name',
      ])
      .where('p.shared_backend_id', '=', volume.shared_backend_id)
      .where('p.driver', '=', 'cephfs')
      .where('p.shareable', '=', true)
      .where('p.registered', '=', true)
      .where('s.status', '=', 'online')
      .orderBy('s.id', 'asc')
      .orderBy('p.id', 'asc')
      .execute();
    const placements = await this.repository.listPlacements(volumeId);
    const placementByServer = new Map(placements.map((row) => [row.server_id, row]));
    const attachments = await this.repository.listAttachments(undefined, volumeId);
    const attachedServers = new Set(
      (await this.database.selectFrom('control.containers')
        .select(['id', 'server_id'])
        .where('id', 'in', attachments.length === 0 ? ['00000000-0000-4000-8000-000000000000'] : attachments.map((row) => row.container_id))
        .execute()).map((row) => row.server_id),
    );
    const items: SharedVolumeCatalogInspectDto['items'] = [];
    for (const pool of pools) {
      const placement = placementByServer.get(pool.server_id);
      const pgCatalogState = placement?.catalog_state === 'present' || placement?.catalog_state === 'ensuring'
        ? placement.catalog_state
        : 'absent';
      let incusPresent: boolean | null = null;
      try {
        const client = await this.clients?.get(pool.server_id);
        if (!client) {
          incusPresent = null;
        } else {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5_000);
          try {
            await client.getStorageVolume(pool.pool_name, 'custom', volume.incus_name, {
              signal: controller.signal,
            });
            incusPresent = true;
          } catch (error) {
            incusPresent = error instanceof IncusError && error.code === 'INCUS_NOT_FOUND'
              ? false
              : null;
          } finally {
            clearTimeout(timer);
          }
        }
      } catch {
        incusPresent = null;
      }
      const occupancy = occupancyForCatalogItem({
        pgCatalogState,
        incusPresent,
        hasAttachment: attachedServers.has(pool.server_id),
      });
      if (occupancy === 'skip') continue;
      items.push({
        serverId: pool.server_id,
        serverName: pool.server_name,
        serverStatus: pool.server_status as SharedVolumeCatalogInspectDto['items'][number]['serverStatus'],
        poolId: pool.pool_id,
        poolName: pool.pool_name,
        pgCatalogState,
        incusPresent,
        occupancy,
      });
    }
    return {
      volumeId: volume.id,
      incusName: volume.incus_name,
      sharedBackendId: volume.shared_backend_id!,
      items,
    };
  }

  async inspectSharedBackendCatalogs(backendId: string): Promise<SharedBackendCatalogInspectDto> {
    const backend = await this.database.selectFrom('infra.shared_backends')
      .select('id')
      .where('id', '=', backendId)
      .executeTakeFirst();
    if (!backend) throw new NotFoundException('Shared backend not found');
    const pools = await this.database
      .selectFrom('infra.storage_pools as p')
      .innerJoin('infra.servers as s', 's.id', 'p.server_id')
      .select([
        's.id as server_id',
        's.name as server_name',
        'p.id as pool_id',
        'p.incus_name as pool_name',
      ])
      .where('p.shared_backend_id', '=', backendId)
      .where('p.driver', '=', 'cephfs')
      .where('p.shareable', '=', true)
      .where('p.registered', '=', true)
      .where('s.status', '=', 'online')
      .orderBy('s.id', 'asc')
      .execute();
    const volumes = await this.database
      .selectFrom('control.volumes')
      .select(['id', 'incus_name'])
      .where('shared_backend_id', '=', backendId)
      .execute();
    const volumeByName = new Map(volumes.map((row) => [row.incus_name, row.id]));
    const attachments = volumes.length === 0
      ? []
      : await this.database.selectFrom('control.volume_attachments as a')
        .innerJoin('control.containers as c', 'c.id', 'a.container_id')
        .select(['a.volume_id as volume_id', 'c.server_id as server_id'])
        .where('a.volume_id', 'in', volumes.map((row) => row.id))
        .execute();
    const inUse = new Set(attachments.map((row) => `${row.volume_id}:${row.server_id}`));
    const items: SharedBackendCatalogInspectDto['items'] = [];
    const managedName = /^nyv-[0-9a-f]{32}$/;
    for (const pool of pools) {
      let listed: Array<{ name?: string } | string> = [];
      try {
        const client = await this.clients?.get(pool.server_id);
        if (!client) continue;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
          listed = (await client.listStorageVolumes(pool.pool_name, 'custom', 1, {
            signal: controller.signal,
          })).metadata as Array<{ name?: string } | string>;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        continue;
      }
      for (const entry of listed) {
        const name = typeof entry === 'string'
          ? (entry.split('/').filter(Boolean).at(-1) ?? '')
          : (entry.name ?? '');
        if (!managedName.test(name)) continue;
        const volumeId = volumeByName.get(name) ?? null;
        const occupancy = volumeId === null
          ? 'dangling_incus'
          : inUse.has(`${volumeId}:${pool.server_id}`)
            ? 'in_use'
            : 'cache';
        items.push({
          serverId: pool.server_id,
          serverName: pool.server_name,
          poolId: pool.pool_id,
          poolName: pool.pool_name,
          incusName: name,
          volumeId,
          occupancy,
        });
      }
    }
    return { sharedBackendId: backendId, items };
  }

  private async listAttachmentDtos(
    containerId: string,
    serverId: string,
    kind: 'local' | 'shared',
  ): Promise<VolumeAttachmentDto[]> {
    const rows = await this.database
      .selectFrom('control.volume_attachments as a')
      .innerJoin('control.volumes as v', 'v.id', 'a.volume_id')
      .leftJoin('control.volume_placements as p', (join) => join
        .onRef('p.volume_id', '=', 'a.volume_id')
        .on('p.server_id', '=', serverId))
      .selectAll('a')
      .select([
        'v.name as volume_name',
        'v.shared_backend_id as shared_backend_id',
        'p.catalog_state as catalog_state',
      ])
      .where('a.container_id', '=', containerId)
      .orderBy('a.created_at')
      .execute();
    const filtered = rows.filter((row) => (
      kind === 'shared' ? row.shared_backend_id !== null : row.shared_backend_id === null
    ));
    return filtered.map((row) => this.toAttachmentDto(row, row.volume_name, {
      kind,
      catalogState: row.catalog_state,
    }));
  }

  private async namesForVolumeIds(volumeIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(volumeIds)];
    const result = new Map<string, string>();
    if (ids.length === 0) return result;
    const rows = await this.database
      .selectFrom('control.volumes')
      .select(['id', 'name'])
      .where('id', 'in', ids)
      .execute();
    for (const row of rows) result.set(row.id, row.name);
    return result;
  }

  private async toDtos(rows: readonly VolumeRow[]): Promise<VolumeDto[]> {
    if (rows.length === 0) return [];
    const descriptors = await this.poolDescriptors(
      rows.flatMap((row) => row.pool_id ? [row.pool_id] : []),
    );
    const attachments = await this.attachmentSummariesByVolumeIds(rows.map((row) => row.id));
    return rows.map((row) => this.toDto(
      row,
      row.pool_id ? descriptors.get(row.pool_id) : undefined,
      attachments.get(row.id) ?? [],
    ));
  }

  private async attachmentSummariesByVolumeIds(
    volumeIds: readonly string[],
  ): Promise<Map<string, VolumeAttachmentSummaryDto[]>> {
    const ids = [...new Set(volumeIds)];
    const result = new Map<string, VolumeAttachmentSummaryDto[]>();
    if (ids.length === 0) return result;
    const rows = await this.database
      .selectFrom('control.volume_attachments as attachment')
      .innerJoin('control.containers as container', 'container.id', 'attachment.container_id')
      .select([
        'attachment.id',
        'attachment.volume_id',
        'attachment.container_id',
        'attachment.container_path',
        'attachment.bind_state',
        'container.name',
      ])
      .where('attachment.volume_id', 'in', ids)
      .orderBy('attachment.created_at')
      .execute();
    for (const row of rows) {
      const list = result.get(row.volume_id) ?? [];
      list.push({
        attachmentId: row.id,
        containerId: row.container_id,
        containerName: row.name,
        containerPath: row.container_path,
        bindState: row.bind_state as VolumeAttachmentSummaryDto['bindState'],
      });
      result.set(row.volume_id, list);
    }
    return result;
  }

  private requireLocal(
    row: VolumeRow | undefined,
    actorId: string | undefined,
    access: 'user' | 'admin',
  ): asserts row is VolumeRow {
    if (
      !row
      || (access === 'user' && row.owner_id !== actorId)
      || row.shared_backend_id !== null
      || row.server_id === null
      || row.pool_id === null
    ) {
      throw new NotFoundException('Volume not found');
    }
  }

  private requireShared(
    row: VolumeRow | undefined,
    actorId: string | undefined,
    access: 'user' | 'admin',
  ): asserts row is VolumeRow {
    if (
      !row
      || (access === 'user' && row.owner_id !== actorId)
      || row.shared_backend_id === null
      || row.server_id !== null
    ) {
      throw new NotFoundException('Volume not found');
    }
  }

  private async filterAttachableShared(
    rows: readonly VolumeRow[],
    serverId: string,
  ): Promise<VolumeRow[]> {
    if (rows.length === 0) return [];
    const pools = await this.database
      .selectFrom('infra.storage_pools')
      .select('shared_backend_id')
      .where('server_id', '=', serverId)
      .where('driver', '=', 'cephfs')
      .where('shareable', '=', true)
      .where('registered', '=', true)
      .where('shared_backend_id', 'is not', null)
      .execute();
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

  private async toSharedDtos(rows: readonly VolumeRow[]): Promise<SharedVolumeDto[]> {
    if (rows.length === 0) return [];
    const backends = await this.sharedBackendDescriptors(
      rows.flatMap((row) => row.shared_backend_id ? [row.shared_backend_id] : []),
    );
    const attachments = await this.attachmentSummariesByVolumeIds(rows.map((row) => row.id));
    return rows.map((row) => this.toSharedDto(
      row,
      row.shared_backend_id ? backends.get(row.shared_backend_id) : undefined,
      attachments.get(row.id) ?? [],
    ));
  }

  private async sharedBackendDescriptors(
    backendIds: readonly string[],
  ): Promise<Map<string, { name: string; capability: SharedVolumeDto['capability'] }>> {
    const ids = [...new Set(backendIds)];
    const result = new Map<string, { name: string; capability: SharedVolumeDto['capability'] }>();
    if (ids.length === 0) return result;
    const backends = await this.database
      .selectFrom('infra.shared_backends')
      .select(['id', 'name', 'display_name'])
      .where('id', 'in', ids)
      .execute();
    const pools = await this.database
      .selectFrom('infra.storage_pools')
      .select(['shared_backend_id', 'quota_effective'])
      .where('shared_backend_id', 'in', ids)
      .where('driver', '=', 'cephfs')
      .where('shareable', '=', true)
      .where('registered', '=', true)
      .execute();
    const quotaByBackend = new Map<string, boolean>();
    for (const pool of pools) {
      if (!pool.shared_backend_id) continue;
      if (pool.quota_effective === true) quotaByBackend.set(pool.shared_backend_id, true);
      else if (!quotaByBackend.has(pool.shared_backend_id)) {
        quotaByBackend.set(pool.shared_backend_id, false);
      }
    }
    for (const backend of backends) {
      const hasPool = quotaByBackend.has(backend.id);
      const quotaEffective = hasPool ? quotaByBackend.get(backend.id) === true : true;
      result.set(backend.id, {
        name: poolLabel(backend.display_name, backend.name),
        capability: storagePoolCapability(StoragePoolResizeFamily.QuotaOnline, quotaEffective),
      });
    }
    return result;
  }

  private toSharedDto(
    row: VolumeRow,
    descriptor: { name: string; capability: SharedVolumeDto['capability'] } | undefined,
    attachments: VolumeAttachmentSummaryDto[],
  ): SharedVolumeDto {
    return {
      id: row.id,
      ownerId: row.owner_id,
      sharedBackendId: row.shared_backend_id!,
      sharedBackendName: descriptor?.name ?? row.shared_backend_id ?? row.name,
      name: row.name,
      incusName: row.incus_name,
      sizeBytes: numberValue(row.size_bytes),
      usedBytes: row.used_bytes === null ? null : numberValue(row.used_bytes),
      capability: descriptor?.capability ?? storagePoolCapability(
        StoragePoolResizeFamily.QuotaOnline,
        true,
      ),
      lifecyclePhase: lifecyclePhase(row.lifecycle_phase),
      generation: row.generation,
      observedGeneration: row.observed_generation,
      needsAttention: row.needs_attention,
      failureCode: row.failure_code,
      dirEnsured: row.dir_ensured,
      createdAt: isoDate(row.created_at) ?? new Date(0).toISOString(),
      updatedAt: isoDate(row.updated_at) ?? new Date(0).toISOString(),
      attachments,
    };
  }

  private toDto(
    row: VolumeRow,
    descriptor: { capability: VolumeDto['capability']; poolName: string } | undefined,
    attachments: VolumeAttachmentSummaryDto[],
  ): VolumeDto {
    return {
      id: row.id,
      ownerId: row.owner_id,
      poolId: row.pool_id!,
      poolName: descriptor?.poolName ?? row.pool_id ?? row.name,
      serverId: row.server_id!,
      name: row.name,
      incusName: row.incus_name,
      sizeBytes: numberValue(row.size_bytes),
      usedBytes: row.used_bytes === null ? null : numberValue(row.used_bytes),
      scope: { kind: 'local', serverId: row.server_id!, poolId: row.pool_id! },
      capability: descriptor?.capability ?? {
        growOnline: true,
        shrinkOnline: false,
        shrinkRequiresStop: false,
        shrinkNever: false,
        enforceUsageFloor: false,
      },
      lifecyclePhase: lifecyclePhase(row.lifecycle_phase),
      generation: row.generation,
      observedGeneration: row.observed_generation,
      needsAttention: row.needs_attention,
      failureCode: row.failure_code,
      createdAt: isoDate(row.created_at) ?? new Date(0).toISOString(),
      updatedAt: isoDate(row.updated_at) ?? new Date(0).toISOString(),
      attachments,
    };
  }

  private toAttachmentDto(
    row: {
      id: string;
      container_id: string;
      volume_id: string;
      device_name: string;
      container_path: string;
      read_only: boolean;
      bind_state: VolumeAttachmentSummaryDto['bindState'];
      created_at: Date | string;
      updated_at: Date | string;
    },
    volumeName: string,
    extra: { kind: 'local' | 'shared'; catalogState: string | null },
  ): VolumeAttachmentDto {
    return {
      id: row.id,
      containerId: row.container_id,
      volumeId: row.volume_id,
      volumeName,
      deviceName: row.device_name,
      containerPath: row.container_path,
      readOnly: row.read_only,
      bindState: row.bind_state,
      kind: extra.kind,
      onlineCancelAllowed: row.bind_state === 'attaching' && extra.catalogState !== 'present',
      createdAt: isoDate(row.created_at) ?? new Date(0).toISOString(),
      updatedAt: isoDate(row.updated_at) ?? new Date(0).toISOString(),
    };
  }
}
