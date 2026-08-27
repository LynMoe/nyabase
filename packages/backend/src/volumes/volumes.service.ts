import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  FailureCode,
  AuditAction,
  IntentKind,
  IntentResourceType,
  StoragePoolResizeFamily,
  type StorageCapacityDto,
  type VolumeAttachmentDto,
  type VolumeAttachmentSummaryDto,
  type VolumeDto,
  type VolumeScope,
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
import { placementServersToDesire } from './volume-placement.js';
import { AuditService } from '../audit/audit.service.js';
import { classifyGrantExpiry, expiresAtSortKey } from '../access/grant-expiry.js';

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
  pool_id: string;
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
  created_at: Date | string;
  updated_at: Date | string;
};

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
  ) {}

  async listForUser(ownerId: string): Promise<VolumeDto[]> {
    const rows = await this.repository.list(ownerId);
    return this.toDtos(rows);
  }

  async listForAdmin(): Promise<VolumeDto[]> {
    const rows = await this.repository.list();
    return this.toDtos(rows);
  }

  async getForUser(id: string, actorId: string): Promise<VolumeDto> {
    const row = await this.repository.findById(id);
    if (!row || row.owner_id !== actorId) {
      throw new NotFoundException('Volume not found');
    }
    const [dto] = await this.toDtos([row]);
    return dto!;
  }

  async getForAdmin(id: string): Promise<VolumeDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw new NotFoundException('Volume not found');
    }
    const [dto] = await this.toDtos([row]);
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
      scope: VolumeScope;
    },
  ): Promise<IntentAcceptedDto> {
    if (input.ownerId) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'User volume creation cannot specify ownerId',
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
      scope: VolumeScope;
    },
  ): Promise<IntentAcceptedDto> {
    if (!input.ownerId) {
      throw new BadRequestException('Admin volume creation requires ownerId');
    }
    return this.createVolume(actorId, input.ownerId, input, 'admin');
  }

  private async createVolume(
    actorId: string,
    ownerId: string,
    input: {
      name: string;
      sizeBytes: number;
      scope: VolumeScope;
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
            desiredPresent: true,
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

  private async patchVolume(
    actorId: string,
    id: string,
    input: { expectedRevision: number; name?: string; sizeBytes?: number },
    access: 'user' | 'admin',
  ): Promise<VolumeDto | IntentAcceptedDto> {
    const current = await this.repository.findById(id);
    if (!current || (access === 'user' && current.owner_id !== actorId)) {
      throw new NotFoundException('Volume not found');
    }
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
    const pool = await this.pools.findById(current.pool_id);
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
      poolId: current.pool_id,
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
      const lockedPool = await this.pools.lockCapacityScope(
        locked.pool_id,
        locked.server_id,
        [locked.shared_backend_id],
        transaction,
      );
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
        poolId: locked.pool_id,
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
            locked.pool_id,
            locked.shared_backend_id,
            lockedDelta,
          );
        } else {
          await this.assertCapacityForDeltaForUser(
            transaction,
            locked.owner_id,
            locked.server_id,
            locked.pool_id,
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
      let placements = await this.repository.listDesiredPlacements(id, transaction);
      if (placements.length === 0) {
        await this.repository.upsertPlacement({
          volumeId: id,
          serverId: lockedPool.server_id,
          poolId: locked.pool_id,
          desiredPresent: true,
        }, transaction);
        placements = await this.repository.listDesiredPlacements(id, transaction);
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

  async deleteForUser(actorId: string, id: string) {
    return this.deleteVolume(actorId, id, 'user');
  }

  async deleteForAdmin(actorId: string, id: string) {
    return this.deleteVolume(actorId, id, 'admin');
  }

  private async deleteVolume(actorId: string, id: string, access: 'user' | 'admin') {
    const result = await this.transactions.run(async (transaction) => {
      const current = await this.repository.findById(id, transaction);
      if (!current || (access === 'user' && current.owner_id !== actorId)) {
        throw new NotFoundException('Volume not found');
      }
      if (current.lifecycle_phase === 'deleting') {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'Volume deletion is already in progress',
          details: { volumeId: id },
        });
      }
      if (await this.repository.hasAttachments(id, transaction)) {
        throw new ConflictException({
          code: FailureCode.VolumeDetachDraining,
          message: 'Detach all volume attachments before deleting the volume',
        });
      }
      await this.pools.lockCapacityScope(
        current.pool_id,
        current.server_id,
        [current.shared_backend_id],
        transaction,
      );
      const anchorPool = await transaction.selectFrom('infra.storage_pools')
        .select(['server_id'])
        .where('id', '=', current.pool_id)
        .executeTakeFirstOrThrow();
      const placements = await this.repository.listPlacements(id, transaction);
      if (placements.length === 0) {
        await this.repository.deleteVolumeRow(id, transaction);
        const intent = await this.intents.createPending({
          kind: IntentKind.VolumeEnsure,
          resourceType: IntentResourceType.Volume,
          resourceId: id,
          serverId: anchorPool.server_id,
          requestedBy: actorId,
          targetGeneration: current.generation,
          request: { operation: 'delete', idempotencyKey: 'delete' },
        }, transaction);
        await this.intents.settleOne(intent.id, { outcome: 'succeeded' }, transaction);
        await this.audit.append(transaction, actorId, AuditAction.DeleteVolume, id, 'volume');
        return { row: current, intent, deleted: true as const };
      }
      const row = await this.repository.updateDesired(
        id,
        current.generation,
        { lifecycle_phase: 'deleting', needs_attention: false, failure_code: null },
        transaction,
      );
      if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
      await this.repository.setAllDesiredPresent(id, false, transaction);
      const intents = [];
      for (const placement of placements) {
        intents.push(await this.intents.createPending({
          kind: IntentKind.VolumeEnsure,
          resourceType: IntentResourceType.Volume,
          resourceId: id,
          serverId: placement.server_id,
          requestedBy: actorId,
          targetGeneration: row.generation,
          request: {
            operation: 'delete',
            idempotencyKey: 'delete',
          },
        }, transaction));
      }
      const intent = intents[0]!;
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

  async listAttachmentsForUser(
    actorId: string,
    containerId: string,
  ): Promise<VolumeAttachmentDto[]> {
    const container = await this.database.selectFrom('control.containers')
      .select(['id', 'owner_id'])
      .where('id', '=', containerId)
      .executeTakeFirst();
    if (!container || container.owner_id !== actorId) {
      throw new NotFoundException('Container not found');
    }
    const rows = await this.repository.listAttachments(containerId);
    const names = await this.namesForVolumeIds(rows.map((row) => row.volume_id));
    return rows.map((row) => this.toAttachmentDto(row, names.get(row.volume_id) ?? row.volume_id));
  }

  async listAttachmentsForAdmin(containerId: string): Promise<VolumeAttachmentDto[]> {
    const container = await this.database.selectFrom('control.containers')
      .select(['id', 'owner_id'])
      .where('id', '=', containerId)
      .executeTakeFirst();
    if (!container) {
      throw new NotFoundException('Container not found');
    }
    const rows = await this.repository.listAttachments(containerId);
    const names = await this.namesForVolumeIds(rows.map((row) => row.volume_id));
    return rows.map((row) => this.toAttachmentDto(row, names.get(row.volume_id) ?? row.volume_id));
  }

  async attachForUser(actorId: string, containerId: string, input: {
    volumeId: string;
    containerPath: string;
    readOnly: boolean;
  }): Promise<IntentAcceptedDto> {
    return this.attachVolume(actorId, containerId, input, 'user');
  }

  async attachForAdmin(actorId: string, containerId: string, input: {
    volumeId: string;
    containerPath: string;
    readOnly: boolean;
  }): Promise<IntentAcceptedDto> {
    return this.attachVolume(actorId, containerId, input, 'admin');
  }

  private async attachVolume(actorId: string, containerId: string, input: {
    volumeId: string;
    containerPath: string;
    readOnly: boolean;
  }, access: 'user' | 'admin'): Promise<IntentAcceptedDto> {
    const result = await this.transactions.run(async (transaction) => {
      const container = await transaction.selectFrom('control.containers').selectAll()
        .where('id', '=', containerId).forUpdate().executeTakeFirst();
      const volume = await transaction.selectFrom('control.volumes').selectAll()
        .where('id', '=', input.volumeId).forUpdate().executeTakeFirst();
      if (!container || (access === 'user' && container.owner_id !== actorId)) {
        throw new NotFoundException('Container not found');
      }
      if (!volume || (access === 'user' && volume.owner_id !== actorId)) {
        throw new NotFoundException('Volume not found');
      }
      if (volume && volume.owner_id !== container.owner_id) {
        throw new ForbiddenException('A volume may only attach to its owner container');
      }
      if (volume.lifecycle_phase === 'deleting' || volume.lifecycle_phase === 'failed') {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'A deleting or failed volume cannot be attached',
          details: { volumeId: volume.id, lifecyclePhase: volume.lifecycle_phase },
        });
      }
      const drain = await this.repository.findDetachDrain(volume.id, transaction);
      if (drain && new Date(drain.drained_at).getTime() > Date.now()) {
        throw new ConflictException({
          code: FailureCode.VolumeDetachDraining,
          message: 'Volume attachment is still draining after a detach',
          details: { drainedAt: new Date(drain.drained_at).toISOString() },
        });
      }
      await this.repository.clearExpiredDetachDrain(volume.id, new Date(), transaction);
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
      const attachmentId = randomUUID();
      const attachment = await this.repository.insertAttachment({
        id: attachmentId,
        containerId,
        volumeId: volume.id,
        deviceName: deterministicName('nyd', attachmentId),
        containerPath: input.containerPath,
        readOnly: input.readOnly,
      }, transaction);
      const generation = Number(container.generation) + 1;
      await transaction.updateTable('control.containers')
        .set({ generation, needs_attention: false })
        .where('id', '=', containerId)
        .where('generation', '=', container.generation)
        .executeTakeFirstOrThrow();
      await this.repository.upsertPlacement({
        volumeId: volume.id,
        serverId: container.server_id,
        poolId: placementPoolId,
        desiredPresent: true,
      }, transaction);
      let blockedByIntentId: string | null = null;
      if (volume.shared_backend_id) {
        const ensure = await this.intents.ensurePending({
          kind: IntentKind.VolumeEnsure,
          resourceType: IntentResourceType.Volume,
          resourceId: volume.id,
          serverId: container.server_id,
          requestedBy: actorId,
          targetGeneration: volume.generation,
          reuseSettled: false,
          request: {
            operation: 'ensure_attachment',
            idempotencyKey: 'ensure_attachment',
          },
        }, transaction);
        if (ensure.status === 'pending') blockedByIntentId = ensure.id;
      }
      const intent = await this.intents.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId: containerId,
        serverId: container.server_id,
        requestedBy: actorId,
        targetGeneration: generation,
        blockedByIntentId,
        request: { operation: 'attach_volume', volumeId: volume.id, attachmentId: attachment.id },
      }, transaction);
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.AttachVolume,
        attachment.id,
        'volume_attachment',
        { containerId, volumeId: volume.id },
      );
      return { attachment, intent, volumeId: volume.id };
    }, { isolationLevel: 'serializable', maxAttempts: 5 });
    this.wake.wake({
      resourceType: IntentResourceType.Volume,
      resourceId: result.volumeId,
      serverId: result.intent.serverId,
      reason: 'intent',
    });
    this.wake.wake({
      resourceType: IntentResourceType.Container,
      resourceId: containerId,
      serverId: result.intent.serverId,
      reason: 'intent',
    });
    return acceptedIntent(result.intent);
  }

  async detachForUser(
    actorId: string,
    attachmentId: string,
    expectedContainerId?: string,
  ): Promise<unknown> {
    return this.detachVolume(actorId, attachmentId, 'user', expectedContainerId);
  }

  async detachForAdmin(
    actorId: string,
    attachmentId: string,
    expectedContainerId?: string,
  ): Promise<unknown> {
    return this.detachVolume(actorId, attachmentId, 'admin', expectedContainerId);
  }

  private async detachVolume(
    actorId: string,
    attachmentId: string,
    access: 'user' | 'admin',
    expectedContainerId?: string,
  ): Promise<unknown> {
    const result = await this.transactions.run(async (transaction) => {
      const found = await this.repository.findAttachment(attachmentId, transaction);
      if (!found) throw new NotFoundException('Volume attachment not found');
      if (expectedContainerId && found.container_id !== expectedContainerId) {
        throw new NotFoundException('Volume attachment not found');
      }
      const container = await transaction.selectFrom('control.containers').selectAll()
        .where('id', '=', found.container_id).forUpdate().executeTakeFirst();
      if (!container || (access === 'user' && container.owner_id !== actorId)) {
        throw new NotFoundException('Container not found');
      }
      const attachment = await transaction
        .selectFrom('control.volume_attachments')
        .selectAll()
        .where('id', '=', attachmentId)
        .forUpdate()
        .executeTakeFirst();
      if (!attachment) throw new NotFoundException('Volume attachment not found');
      const volume = await transaction.selectFrom('control.volumes')
        .selectAll()
        .where('id', '=', attachment.volume_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await this.repository.setDetachDrain(
        attachment.volume_id,
        new Date(Date.now() + 360_000),
        transaction,
      );
      await this.repository.deleteAttachment(attachmentId, transaction);
      const homePool = await transaction.selectFrom('infra.storage_pools')
        .select('server_id')
        .where('id', '=', volume.pool_id)
        .executeTakeFirstOrThrow();
      const desiredServers = placementServersToDesire({
        lifecyclePhase: volume.lifecycle_phase,
        serverId: volume.server_id,
        homeServerId: homePool.server_id,
        liveAttachmentServerIds: await this.repository.liveAttachmentServerIds(
          volume.id,
          transaction,
        ),
      });
      if (!desiredServers.has(container.server_id) && container.server_id !== homePool.server_id) {
        await this.repository.setDesiredPresent(volume.id, container.server_id, false, transaction);
      }
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
    return acceptedIntent(result);
  }

  private async resolveScopeForUser(
    transaction: Transaction<NyabaseDatabase>,
    ownerId: string,
    scope: VolumeScope,
  ): Promise<{
    poolId: string;
    serverId: string | null;
    sharedBackendId: string | null;
    anchorServerId: string;
  }> {
    const resolved = await this.resolveScopeCore(transaction, scope);
    if (scope.kind === 'local') {
      await this.assertServerGrant(ownerId, scope.serverId, transaction);
      await this.assertPoolGrant(ownerId, resolved.poolId, transaction);
    } else {
      await this.assertSharedGrant(ownerId, scope.sharedBackendId, transaction);
    }
    return resolved;
  }

  private async resolveScopeForAdmin(
    transaction: Transaction<NyabaseDatabase>,
    scope: VolumeScope,
  ): Promise<{
    poolId: string;
    serverId: string | null;
    sharedBackendId: string | null;
    anchorServerId: string;
  }> {
    return this.resolveScopeCore(transaction, scope);
  }

  private async resolveScopeCore(
    transaction: Transaction<NyabaseDatabase>,
    scope: VolumeScope,
  ): Promise<{
    poolId: string;
    serverId: string | null;
    sharedBackendId: string | null;
    anchorServerId: string;
  }> {
    const pool = await transaction.selectFrom('infra.storage_pools')
      .selectAll().where('id', '=', scope.poolId).executeTakeFirst();
    if (!pool || !pool.registered) throw new NotFoundException('Registered storage pool not found');
    if (scope.kind === 'local') {
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
    if (
      pool.driver !== 'cephfs'
      || !pool.shareable
      || pool.shared_backend_id !== scope.sharedBackendId
    ) {
      throw new BadRequestException('Shared volumes require a shareable CephFS pool');
    }
    if (pool.quota_effective === false) {
      throw new ConflictException({
        code: FailureCode.StoragePoolQuotaIneffective,
        message: 'This shared CephFS pool cannot enforce custom volume quotas',
        details: { poolId: pool.id },
      });
    }
    const lockedPool = await this.pools.lockCapacityScope(
      pool.id,
      null,
      [scope.sharedBackendId],
      transaction,
    );
    if (
      !lockedPool.registered
      || lockedPool.driver !== 'cephfs'
      || !lockedPool.shareable
      || lockedPool.shared_backend_id !== scope.sharedBackendId
    ) {
      throw new BadRequestException('Shared volumes require a shareable CephFS pool');
    }
    if (lockedPool.quota_effective === false) {
      throw new ConflictException({
        code: FailureCode.StoragePoolQuotaIneffective,
        message: 'This shared CephFS pool cannot enforce custom volume quotas',
        details: { poolId: lockedPool.id },
      });
    }
    return {
      poolId: lockedPool.id,
      serverId: null,
      sharedBackendId: scope.sharedBackendId,
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
      await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, pool.id, delta, transaction);
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
      await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, pool.id, delta, transaction);
      return;
    }
    if (!serverId) throw new BadRequestException('Local capacity requires a server');
    await this.assertLocalPoolPhysicalCapacity(pool, poolId, serverId, delta, transaction);
  }

  private async assertSharedBackendPhysicalCapacity(
    backend: {
      total_bytes: string | number | null;
      overcommit_ratio: string | number;
    },
    sharedBackendId: string,
    anchorPoolId: string,
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
          anchorPoolId,
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
    const descriptors = await this.poolDescriptors(rows.map((row) => row.pool_id));
    const attachments = await this.attachmentSummariesByVolumeIds(rows.map((row) => row.id));
    return rows.map((row) => this.toDto(
      row,
      descriptors.get(row.pool_id),
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
      });
      result.set(row.volume_id, list);
    }
    return result;
  }

  private toDto(
    row: VolumeRow,
    descriptor: { capability: VolumeDto['capability']; poolName: string } | undefined,
    attachments: VolumeAttachmentSummaryDto[],
  ): VolumeDto {
    const scope: VolumeScope = row.server_id !== null
      ? { kind: 'local', serverId: row.server_id, poolId: row.pool_id }
      : { kind: 'shared', sharedBackendId: row.shared_backend_id!, poolId: row.pool_id };
    return {
      id: row.id,
      ownerId: row.owner_id,
      poolId: row.pool_id,
      poolName: descriptor?.poolName ?? row.pool_id,
      serverId: row.server_id,
      sharedBackendId: row.shared_backend_id,
      name: row.name,
      incusName: row.incus_name,
      sizeBytes: numberValue(row.size_bytes),
      usedBytes: row.used_bytes === null ? null : numberValue(row.used_bytes),
      scope,
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

  private toAttachmentDto(row: {
    id: string;
    container_id: string;
    volume_id: string;
    device_name: string;
    container_path: string;
    read_only: boolean;
    detach_drained_at: Date | string | null;
    created_at: Date | string;
    updated_at: Date | string;
  }, volumeName: string): VolumeAttachmentDto {
    return {
      id: row.id,
      containerId: row.container_id,
      volumeId: row.volume_id,
      volumeName,
      deviceName: row.device_name,
      containerPath: row.container_path,
      readOnly: row.read_only,
      detachDrainedAt: isoDate(row.detach_drained_at),
      createdAt: isoDate(row.created_at) ?? new Date(0).toISOString(),
      updatedAt: isoDate(row.updated_at) ?? new Date(0).toISOString(),
    };
  }
}
