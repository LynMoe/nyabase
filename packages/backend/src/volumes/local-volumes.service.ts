import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import {
  AuditAction,
  Capability,
  FailureCode,
  IntentKind,
  IntentResourceType,
  StoragePoolResizeFamily,
  type IntentAcceptedDto,
  type ListScope,
  type LocalVolumeScope,
  type StorageCapacityDto,
  type VolumeDto,
} from '@nyabase/common';
import { assertListScope, type Actor } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import { deterministicName, numberValue } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { acceptedIntent } from '../reconcile/accepted-intent.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { assertCanAccess, type VolumeAccess } from './volume-access.js';
import {
  assertCapacityPhysical,
  assertCapacityWithinGrants,
  lockVolumeQuota,
} from './volume-capacity.js';
import { ownerCapacity, serverWideCapacity } from './volume-capacity-report.js';
import type { VolumeRow } from './volume-dtos.js';
import {
  VOLUME_TX,
  applyResize,
  assertPatchable,
  assertValidVolumeSize,
  beginVolumeDestroy,
  destroyUntrackedVolume,
  isUniqueViolation,
  nameTakenConflict,
  renameVolume,
  type VolumeLifecycleDeps,
} from './volume-lifecycle.js';
import { createVolumeIntent } from './volume-intents.js';
import { toVolumeDtos, type VolumeDeps } from './volume-read-model.js';
import { checkVolumeResize } from './volume-resize-policy.js';
import { resolveOwnerScope } from './volume-scope.js';
import { VolumesRepository } from './volumes.repository.js';

type PatchInput = { expectedRevision: number; name?: string; sizeBytes?: number };
type Tx = Transaction<NyabaseDatabase>;

/** Per-server (local pool) custom volumes: list, create, resize/rename, delete and capacity. */
@Injectable()
export class LocalVolumesService {
  private readonly deps: VolumeDeps & VolumeLifecycleDeps;

  constructor(
    private readonly repository: VolumesRepository,
    private readonly pools: StoragePoolsRepository,
    private readonly transactions: PgTransactionManager,
    private readonly intents: IntentRepository,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly audit: AuditService,
  ) {
    this.deps = { database, repository, pools, intents, audit };
  }

  async list(
    actor: Actor,
    filters: { scope?: ListScope; serverId?: string } = {},
  ): Promise<VolumeDto[]> {
    const scope = filters.scope ?? 'mine';
    assertListScope(actor, scope, Capability.ManageVolumes);
    const rows = await this.repository.listByKind(
      'local',
      scope === 'mine' ? { ownerId: actor.userId } : { serverId: filters.serverId },
    );
    return toVolumeDtos(this.deps, rows);
  }

  async get(actor: Actor, id: string): Promise<VolumeDto> {
    const { row } = assertCanAccess(actor, await this.repository.findById(id), 'local');
    const [dto] = await toVolumeDtos(this.deps, [row]);
    return dto!;
  }

  /**
   * `scope=mine`: the caller's own storage on a server they hold a grant for.
   * `scope=all`: the server-wide view for `ManageServers`.
   */
  async capacity(
    actor: Actor,
    serverId: string,
    scope: ListScope = 'mine',
  ): Promise<StorageCapacityDto> {
    assertListScope(actor, scope, Capability.ManageServers);
    return scope === 'all'
      ? serverWideCapacity(this.deps, serverId)
      : ownerCapacity(this.deps, actor.userId, serverId);
  }

  async create(
    actor: Actor,
    input: { name: string; sizeBytes: number; scope: LocalVolumeScope },
  ): Promise<IntentAcceptedDto> {
    if (input.scope.kind !== 'local') {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Shared volumes must be created via /shared-volumes',
      });
    }
    assertValidVolumeSize(input.sizeBytes);
    const actorId = actor.userId;
    const ownerId = actor.userId;
    const id = randomUUID();
    const incusName = deterministicName('nyv', id);
    let created;
    try {
      created = await this.transactions.run(async (transaction) => {
        const scope = await resolveOwnerScope(this.deps, transaction, ownerId, input.scope);
        await assertCapacityWithinGrants(
          this.deps,
          transaction,
          ownerId,
          scope.serverId,
          scope.poolId,
          scope.sharedBackendId,
          input.sizeBytes,
        );
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
        const intent = await createVolumeIntent(this.intents, {
          kind: IntentKind.VolumeEnsure,
          resourceType: IntentResourceType.Volume,
          resourceId: row.id,
          serverId: scope.anchorServerId,
          requestedBy: actorId,
          targetRevision: row.revision,
          request: { operation: 'create', idempotencyKey: 'create', sizeBytes: input.sizeBytes },
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
      }, VOLUME_TX);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTakenConflict(input.name);
      throw error;
    }
    return acceptedIntent(created.intent);
  }

  async patch(
    actor: Actor,
    id: string,
    input: PatchInput,
  ): Promise<VolumeDto | IntentAcceptedDto> {
    const { row: current, access } = assertCanAccess(
      actor,
      await this.repository.findById(id),
      'local',
    );
    assertPatchable(current, input);
    if (input.sizeBytes === undefined || input.sizeBytes === numberValue(current.size_bytes)) {
      return this.renameOnly(actor.userId, current, input);
    }
    await this.precheckResize(current, input.sizeBytes);
    const changed = await this.transactions.run(
      (transaction) => this.resizeInTransaction(transaction, actor.userId, access, id, {
        ...input,
        sizeBytes: input.sizeBytes!,
      }),
      VOLUME_TX,
    );
    return acceptedIntent(changed.intent);
  }

  private async renameOnly(
    actorId: string,
    current: VolumeRow,
    input: PatchInput,
  ): Promise<VolumeDto> {
    if (input.name === undefined || input.name === current.name) {
      const [dto] = await toVolumeDtos(this.deps, [current]);
      return dto!;
    }
    const updated = await this.transactions.run(async (transaction) => {
      const locked = await this.repository.findById(current.id, transaction);
      if (!locked || locked.revision !== input.expectedRevision) {
        throw new ConflictException({ code: FailureCode.RevisionConflict });
      }
      return renameVolume(this.deps, transaction, actorId, locked, input.name!);
    }, VOLUME_TX);
    const [dto] = await toVolumeDtos(this.deps, [updated]);
    return dto!;
  }

  /** Attachments that block a block-backed shrink; empty when the shrink needs no such check. */
  private async shrinkBlockingAttachments(
    volumeId: string,
    delta: number,
    resizeFamily: string,
    executor?: Tx,
  ) {
    if (delta >= 0 || resizeFamily !== StoragePoolResizeFamily.BlockBacked) return [];
    return (await this.repository.listAttachments(undefined, volumeId, executor)).map((attachment) => ({
      attachmentId: attachment.id,
      containerId: attachment.container_id,
      containerPath: attachment.container_path,
    }));
  }

  /** Reject an unsafe resize before any intent exists (the locked re-check repeats it). */
  private async precheckResize(current: VolumeRow, requestedSizeBytes: number): Promise<void> {
    const delta = requestedSizeBytes - numberValue(current.size_bytes);
    const pool = current.pool_id ? await this.pools.findById(current.pool_id) : null;
    if (!pool) throw new NotFoundException('Volume pool not found');
    const failure = checkVolumeResize({
      volumeId: current.id,
      poolId: pool.id,
      currentSizeBytes: numberValue(current.size_bytes),
      requestedSizeBytes,
      usedBytes: current.used_bytes === null ? null : numberValue(current.used_bytes),
      resizeFamily: pool.resize_family as StoragePoolResizeFamily,
      blockFilesystem: pool.block_filesystem,
      attachments: await this.shrinkBlockingAttachments(current.id, delta, pool.resize_family),
    });
    if (failure) throw new ConflictException(failure);
  }

  private async resizeInTransaction(
    transaction: Tx,
    actorId: string,
    access: VolumeAccess,
    id: string,
    input: { expectedRevision: number; name?: string; sizeBytes: number },
  ) {
    const locked = await this.repository.findById(id, transaction);
    if (!locked || locked.revision !== input.expectedRevision) {
      throw new ConflictException({ code: FailureCode.RevisionConflict });
    }
    const lockedDelta = input.sizeBytes - numberValue(locked.size_bytes);
    await lockVolumeQuota(this.pools, locked, transaction);
    const noRegistration = () => new ConflictException({
      code: FailureCode.InvalidInput,
      message: 'A volume with no catalog registration cannot be resized',
    });
    const representativePoolId = locked.pool_id
      ?? (await this.repository.listPlacements(id, transaction))[0]?.pool_id
      ?? null;
    if (!representativePoolId) throw noRegistration();
    const lockedPool = await this.pools.findById(representativePoolId, transaction);
    if (!lockedPool) throw new NotFoundException('Volume pool not found');
    const scopeMatches = lockedPool.registered
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
    const lockedFailure = checkVolumeResize({
      volumeId: id,
      poolId: lockedPool.id,
      currentSizeBytes: numberValue(locked.size_bytes),
      requestedSizeBytes: input.sizeBytes,
      usedBytes: locked.used_bytes === null ? null : numberValue(locked.used_bytes),
      resizeFamily: lockedPool.resize_family as StoragePoolResizeFamily,
      blockFilesystem: lockedPool.block_filesystem,
      attachments: await this.shrinkBlockingAttachments(
        id,
        lockedDelta,
        lockedPool.resize_family,
        transaction,
      ),
    });
    if (lockedFailure) throw new ConflictException(lockedFailure);
    if (lockedDelta > 0) {
      if (access === 'admin') {
        await assertCapacityPhysical(
          this.deps,
          transaction,
          locked.server_id,
          representativePoolId,
          locked.shared_backend_id,
          lockedDelta,
        );
      } else {
        await assertCapacityWithinGrants(
          this.deps,
          transaction,
          locked.owner_id,
          locked.server_id,
          representativePoolId,
          locked.shared_backend_id,
          lockedDelta,
        );
      }
    }
    const placements = await this.repository.listPlacements(id, transaction);
    if (placements.length === 0) throw noRegistration();
    const { intents } = await applyResize(this.deps, transaction, actorId, locked, input, placements);
    return { intent: intents[0]! };
  }

  async delete(actor: Actor, id: string) {
    const actorId = actor.userId;
    const result = await this.transactions.run(async (transaction) => {
      const { row: current } = assertCanAccess(
        actor,
        await this.repository.findById(id, transaction),
        'local',
      );
      if (current.lifecycle_phase === 'deleting') {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'Volume deletion is already in progress',
          details: { volumeId: id },
        });
      }
      await lockVolumeQuota(this.pools, current, transaction);
      if (await this.repository.hasAttachments(id, transaction)) {
        throw new ConflictException({
          code: FailureCode.VolumeRequiresUnbind,
          message: 'Detach all volume attachments before deleting the volume',
        });
      }
      const placements = await this.repository.listPlacements(id, transaction);
      if (placements.length === 0) {
        return destroyUntrackedVolume(this.deps, transaction, actorId, current, 'empty_tracking');
      }
      await this.assertServerOnline(transaction, current);
      return beginVolumeDestroy(this.deps, transaction, actorId, current);
    }, VOLUME_TX);
    return acceptedIntent(result.intent);
  }

  /** Destroying a placed volume needs its server: the data lives there. */
  private async assertServerOnline(transaction: Tx, volume: VolumeRow): Promise<void> {
    const server = await transaction.selectFrom('infra.servers')
      .select(['id', 'name', 'status'])
      .where('id', '=', volume.server_id)
      .executeTakeFirst();
    if (!server || server.status !== 'online') {
      throw new ConflictException({
        code: FailureCode.ServerUnreachable,
        message: 'The volume server is unreachable; contact an administrator',
        details: {
          serverId: server?.id ?? volume.server_id,
          serverName: server?.name ?? volume.server_id,
        },
      });
    }
  }
}
