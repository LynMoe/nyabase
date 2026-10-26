import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AuditAction,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  FailureCode,
  IntentKind,
  IntentResourceType,
  type ContainerDto,
  type CreateContainerRequest,
  type CreateExecSessionRequest,
  type ListScope,
  type IntentAcceptedDto,
  type PatchContainerLimitsRequest,
  type PatchContainerRootSizeRequest,
  type VolumeAttachmentDto,
  Role,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { nullableNumber, numberValue } from '../platform/domain-utils.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { lockOwnerServerQuota } from '../platform/persistence-pg/advisory-locks.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { resolveServerAccess, type ServerAccess } from '../iam/effective-access.js';
import { assertListScope, isSystemActor, type Actor, requireUserId } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import { acceptedIntent } from '../reconcile/accepted-intent.js';
import { DESPITE_ATTENTION_FIELD, IntentRepository } from '../reconcile/intent.repository.js';
import { ConsoleSessionService } from './console-session.service.js';
import { ContainerSshConvergenceService } from './container-ssh.js';
import {
  ACCESS_LAPSE_STOP_REASON,
  ContainerControlRepository,
  type ContainerRow,
} from './container-control.repository.js';
import { VolumeAttachmentsService } from '../volumes/volume-attachments.service.js';
import { assertClaimsGranted, mutateGpuContainer } from '../gpu/admit.js';
import { GpuClaimsRepository } from '../gpu/gpu-claims.repository.js';
import { assertRootCapacity, ContainerCreateService } from './container-create.service.js';
import { ContainerDtoAssembler } from './container-dtos.js';
import {
  assertCanAccess,
  assertMemoryGrant,
  assertContainerName,
  assertCreateNumbers,
  checkRootResize,
  containerStatus,
  createContainerIntent,
  rootShrinkReservation,
  type ContainerAccess,
} from './container-rules.js';
import { assertActorRole } from '../iam/administration.js';

type ContainerAction = 'start' | 'stop' | 'restart' | 'delete';
type DesiredValues = Parameters<ContainerControlRepository['updateDesired']>[2];

/** Phases in which a container can still be running: the access-lapse stop applies. */
const STOPPABLE_PHASES: ReadonlySet<string> = new Set([ContainerPhase.Active, ContainerPhase.Provisioning]);

function auditActionFor(action: ContainerAction): AuditAction {
  switch (action) {
    case 'start': return AuditAction.StartContainer;
    case 'stop': return AuditAction.StopContainer;
    case 'restart': return AuditAction.RestartContainer;
    case 'delete': return AuditAction.DeleteContainer;
  }
}

/**
 * Container API operations: the user-facing commands, authorised per actor.
 * Admission lives in ContainerCreateService and DTO assembly in
 * ContainerDtoAssembler (both built from the same collaborators).
 */
@Injectable()
export class ContainerControlService {
  constructor(
    private readonly transactions: PgTransactionManager,
    private readonly repository: ContainerControlRepository,
    private readonly access: AccessResolverService,
    private readonly intents: IntentRepository,
    private readonly consoleSessions: ConsoleSessionService,
    private readonly audit: AuditService,
    private readonly sshConvergence: ContainerSshConvergenceService,
    private readonly volumes: VolumeAttachmentsService,
    private readonly gpuClaims: GpuClaimsRepository,
    private readonly dtos: ContainerDtoAssembler,
    private readonly creator: ContainerCreateService,
  ) {}

  async list(
    actor: Actor,
    filters: { scope?: ListScope; serverId?: string } = {},
  ): Promise<ContainerDto[]> {
    const scope = filters.scope ?? 'mine';
    assertListScope(actor, scope, Role.Operator);
    const rows = await this.repository.list({
      ownerId: scope === 'mine' ? requireUserId(actor) : undefined,
      serverId: filters.serverId,
    });
    return this.dtos.toContainerDtos(rows);
  }

  async get(actor: Actor, containerId: string, scope: ListScope = 'mine'): Promise<ContainerDto> {
    const row = await this.requireContainer(containerId);
    assertCanAccess(actor, row, scope);
    return (await this.dtos.toContainerDtos([row]))[0]!;
  }

  async create(
    actor: Actor,
    request: CreateContainerRequest,
  ): Promise<IntentAcceptedDto> {
    assertContainerName(request.name);
    assertCreateNumbers(request);
    const id = randomUUID();
    const result = await this.transactions.run(
      (transaction) => this.creator.admit(transaction, actor, request, id),
      { isolationLevel: 'serializable', maxAttempts: 5 },
    );
    return acceptedIntent(result.intent);
  }

  async repairSsh(
    actor: Actor,
    containerId: string,
    scope: ListScope = 'mine',
  ): Promise<{ woken: boolean }> {
    const row = await this.requireContainer(containerId);
    assertCanAccess(actor, row, scope);
    if (row.lifecycle_phase !== 'active') {
      throw new ConflictException({
        code: FailureCode.InvalidInput,
        message: 'SSH repair requires an active container',
      });
    }
    return this.sshConvergence.repairContainer(containerId);
  }

  async updateLimits(
    actor: Actor,
    containerId: string,
    input: PatchContainerLimitsRequest,
    scope: ListScope = 'mine',
  ): Promise<IntentAcceptedDto> {
    if (!Number.isSafeInteger(input.memBytes) || input.memBytes <= 0) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Container memory must be a positive safe integer',
      });
    }
    return this.updateDesired(actor, scope, containerId, {
      mem_bytes: input.memBytes,
    }, { operation: 'limits' }, AuditAction.UpdateContainerLimits, async (transaction, current, grant) => {
      // Only a running container's increase can push running memory over the
      // grant; a stopped one is checked when it starts.
      if (!grant || current.power_intent !== ContainerPowerIntent.Running
        || input.memBytes <= numberValue(current.mem_bytes)) return;
      await lockOwnerServerQuota(transaction, current.owner_id, current.server_id);
      assertMemoryGrant(grant, input.memBytes, await this.repository.sumRunningMemBytes({
        ownerId: current.owner_id,
        serverId: current.server_id,
        excludeContainerId: current.id,
      }, transaction));
    });
  }

  async resizeRoot(
    actor: Actor,
    containerId: string,
    input: PatchContainerRootSizeRequest,
    scope: ListScope = 'mine',
  ): Promise<IntentAcceptedDto> {
    const size = input.sizeBytes;
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Root size must be a positive safe integer',
      });
    }
    return this.updateDesired(
      actor,
      scope,
      containerId,
      (locked) => ({
        root_size_bytes: size,
        root_size_pending_bytes: null,
        root_shrink_reserved_bytes: rootShrinkReservation(locked, size).reservedBytes,
      }),
      { operation: 'root_resize', sizeBytes: size },
      AuditAction.ResizeContainerRoot,
      (transaction, locked, grant) => this.validateRootResize(transaction, locked, size, grant),
    );
  }

  async mutateGpus(
    actor: Actor,
    containerId: string,
    payload: unknown,
    scope: ListScope = 'mine',
  ): Promise<IntentAcceptedDto> {
    return this.transactions.run(async (transaction) => {
      const current = await this.repository.lock(containerId, transaction);
      if (!current) throw new NotFoundException('Container not found');
      const access = assertCanAccess(actor, current, scope);
      if (current.lifecycle_phase === ContainerPhase.Deleting) {
        throw new ConflictException({
          code: FailureCode.InstanceBusy,
          message: 'A deleting container cannot be modified',
        });
      }
      if (access === 'admin') await this.assertAdminInTransaction(transaction, actor);
      // Share-locks the server row: a concurrent GPU disable waits for this write.
      const enabled = await this.gpuClaims.lockEnabled(current.server_id, transaction);
      if (!enabled) {
        throw new ConflictException({
          code: FailureCode.GpuNotEnabled,
          message: 'GPU is not enabled on this server',
        });
      }
      const route = await this.repository.currentRoute(containerId, transaction);
      const observedStatus = containerStatus(
        route?.instance_status,
        current.power_intent as ContainerPowerIntent,
      );
      let grantPciAddresses: readonly string[] = [];
      if (access === 'owner') {
        const grant = await this.requireLiveGrant(transaction, actor, current);
        grantPciAddresses = grant.gpuPciAddresses;
      }
      const mutated = await mutateGpuContainer({
        serverId: current.server_id,
        actor: { userId: requireUserId(actor), admin: access !== 'owner' },
        grantPciAddresses,
        claims: this.gpuClaims.forContainer(current.server_id, containerId, transaction),
        health: this.gpuClaims.health(current.server_id, transaction),
        containerId,
        observedStatus: observedStatus === 'creating' ? 'unknown' : observedStatus,
        currentState: current.gpu_state,
        payload,
        enabled,
      });
      const updated = await this.repository.updateDesired(
        containerId,
        current.revision,
        { gpu_state: mutated.state },
        transaction,
      );
      if (!updated) throw new ConflictException({ code: FailureCode.RevisionConflict });
      const intent = await createContainerIntent(this.intents, {
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId: containerId,
        serverId: current.server_id,
        requestedBy: actor.userId,
        targetRevision: updated.revision,
        request: mutated.requestSummary,
      }, transaction);
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.UpdateContainerGpu,
        containerId,
        'container',
        mutated.requestSummary,
      );
      return { intent, serverId: current.server_id };
    }, { isolationLevel: 'serializable', maxAttempts: 5 }).then((result) => acceptedIntent(result.intent));
  }

  /** Attachments of a container the caller was already authorised to see. */
  async listVolumes(
    actor: Actor,
    containerId: string,
    scope: ListScope = 'mine',
  ): Promise<VolumeAttachmentDto[]> {
    assertCanAccess(actor, await this.requireContainer(containerId), scope);
    return this.volumes.listForContainer(containerId, 'local');
  }

  async listSharedVolumes(
    actor: Actor,
    containerId: string,
    scope: ListScope = 'mine',
  ): Promise<VolumeAttachmentDto[]> {
    assertCanAccess(actor, await this.requireContainer(containerId), scope);
    return this.volumes.listForContainer(containerId, 'shared');
  }

  async getStats(actor: Actor, containerId: string, scope: ListScope = 'mine') {
    const row = await this.requireContainer(containerId);
    assertCanAccess(actor, row, scope);
    return this.stats(row);
  }

  async createExecSession(
    actor: Actor,
    containerId: string,
    request: CreateExecSessionRequest,
    scope: ListScope = 'mine',
  ): Promise<{ sessionId: string; consoleUrl: string; expiresAt: string }> {
    if (actor.userId === null) {
      throw new ForbiddenException('Container console admission needs a signed-in user');
    }
    const row = await this.requireContainer(containerId);
    assertCanAccess(actor, row, scope);
    let access: ContainerAccess = 'owner';
    await this.transactions.run(async (transaction) => {
      const current = await this.repository.lock(containerId, transaction);
      if (!current) throw new NotFoundException('Container not found');
      access = assertCanAccess(actor, current, scope);
      await this.enforceInTransaction(transaction, actor, current, access);
      const currentRoute = await this.repository.currentRoute(containerId, transaction);
      if (
        containerStatus(currentRoute?.instance_status, current.power_intent as ContainerPowerIntent)
        !== ContainerStatus.Running
      ) {
        throw new ConflictException({ code: FailureCode.InstanceBusy, message: 'Container is not running' });
      }
      return currentRoute;
    });
    const session = await this.consoleSessions.create(
      actor.userId,
      actor.authVersion,
      containerId,
      request,
      access !== 'owner',
    );
    try {
      await this.transactions.run(async (transaction) => {
        await this.audit.append(transaction, actor.userId, AuditAction.CreateExecSession, containerId, 'container', {
          tty: request.tty,
          cols: request.cols,
          rows: request.rows,
        });
      });
    } catch (error) {
      this.consoleSessions.release(session.sessionId);
      throw error;
    }
    return session;
  }

  async action(
    actor: Actor,
    containerId: string,
    action: ContainerAction,
    scope: ListScope = 'mine',
  ): Promise<IntentAcceptedDto> {
    return this.transactions.run(
      (transaction) => this.actionInTransaction(transaction, actor, containerId, action, scope),
      {
        // Only the owner's start admission (running memory) relies on
        // serializable. Expiry/system stops must not lose to concurrent
        // reconcile observation writes, and the administrator override
        // (`scope=all`, which admits nothing) must read the role re-check
        // after the IAM lock wait, not from a snapshot taken before it.
        isolationLevel: isSystemActor(actor) || scope === 'all' ? 'read committed' : 'serializable',
        maxAttempts: 5,
      },
    );
  }

  /**
   * The access-lapse stop, the counterpart of `forceDetach`. A container meant
   * to run is stopped as by `action('stop')`. One whose stop did not take
   * effect (desired stopped, instance last observed running: say the stop hit
   * the busy-strike limit and parked the container, which the full scan then
   * skips) is stopped again once `lapseStopRedriveDue` holds, keeping
   * `needs_attention` so a container that keeps refusing stays visible. Every
   * intent runs despite the attention (`runsDespiteAttention`); success clears
   * it. Returns null when the container is gone, deleting or nothing is due.
   */
  async enforceStop(actor: Actor, containerId: string): Promise<IntentAcceptedDto | null> {
    return this.transactions.run(async (transaction) => {
      const current = await this.repository.lock(containerId, transaction);
      if (!current || !STOPPABLE_PHASES.has(current.lifecycle_phase)) return null;
      const redrive = current.power_intent !== ContainerPowerIntent.Running;
      if (redrive && !await this.repository.lapseStopRedriveDue(containerId, transaction)) return null;
      return this.actionInTransaction(transaction, actor, containerId, 'stop', 'all', { enforcement: { redrive } });
    }, { isolationLevel: 'read committed', maxAttempts: 5 });
  }

  /**
   * `action` in the caller's transaction. The access-lapse purge queues its
   * deletes in the transaction that re-checked coverage under the IAM lock.
   * `enforcement` marks an access-lapse stop (`enforceStop`).
   */
  async actionInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    actor: Actor,
    containerId: string,
    action: ContainerAction,
    scope: ListScope = 'mine',
    options: { readonly enforcement?: { readonly redrive: boolean } } = {},
  ): Promise<IntentAcceptedDto> {
    const current = await this.repository.lock(containerId, transaction);
    if (!current) throw new NotFoundException('Container not found');
    const access = assertCanAccess(actor, current, scope);
    // Stopping or deleting only shrinks what the owner uses, so it needs no
    // current coverage: an owner in the grace period can still do both.
    const grant = await this.enforceInTransaction(
      transaction,
      actor,
      current,
      access,
      action === 'stop' || action === 'delete' ? 'optional' : 'required',
    );
    // A restart of a container whose stop is not yet observed also flips the
    // intent back to running, so it is admitted exactly like a start.
    if (grant && (action === 'start' || action === 'restart')
      && current.power_intent !== ContainerPowerIntent.Running) {
      await this.admitStart(transaction, current, grant);
    }
    if (access === 'owner' && (action === 'start' || action === 'restart')) {
      await this.access.assertAttachedStorageCoveredInTransaction(
        transaction,
        current.owner_id,
        containerId,
      );
    }
    if (action !== 'delete' && current.lifecycle_phase === ContainerPhase.Deleting) {
      throw new ConflictException({
        code: FailureCode.InstanceBusy,
        message: 'A deleting container cannot receive power actions',
      });
    }
    const route = action === 'restart'
      ? await this.repository.currentRoute(containerId, transaction)
      : undefined;
    if (action === 'restart'
      && containerStatus(route?.instance_status, current.power_intent as ContainerPowerIntent)
        !== ContainerStatus.Running) {
      throw new ConflictException({
        code: FailureCode.InstanceBusy,
        message: 'Restart requires a running container',
      });
    }
    if (action === 'start' || action === 'restart') {
      const detaching = await this.repository.findDetachingAttachment(containerId, transaction);
      if (detaching) {
        throw new ConflictException({
          code: FailureCode.InstanceBusy,
          message: '等待卸载完成后再启动',
          details: { containerId, attachmentId: detaching.id },
        });
      }
    }
    const nextPhase = action === 'delete' ? ContainerPhase.Deleting : current.lifecycle_phase;
    const nextPower = action === 'stop'
      ? ContainerPowerIntent.Stopped
      : action === 'start' || action === 'restart'
        ? ContainerPowerIntent.Running
        : ContainerPowerIntent.Stopped;
    const { enforcement } = options;
    const updated = await this.repository.updateDesired(
      containerId,
      Number(current.revision),
      {
        lifecycle_phase: nextPhase,
        power_intent: nextPower,
        failure_code: null,
        failure_reason: null,
        ...(enforcement?.redrive ? { needs_attention: current.needs_attention } : {}),
      },
      transaction,
    );
    if (!updated) throw new ConflictException({ code: FailureCode.RevisionConflict });
    // A deleting container keeps its GPU claims until its row (and so its
    // instance) is gone: a slow or parked delete must not hand the card on.
    if (nextPhase === ContainerPhase.Failed) {
      await this.gpuClaims.releaseContainerClaims(containerId, transaction);
    }
    const kind = action === 'delete'
      ? IntentKind.ContainerDelete
      : action === 'restart' || action === 'start' || action === 'stop'
        ? IntentKind.ContainerPower
        : IntentKind.ContainerUpdate;
    const intent = await createContainerIntent(this.intents, {
      kind,
      resourceType: IntentResourceType.Container,
      resourceId: containerId,
      serverId: current.server_id,
      requestedBy: actor.userId,
      targetRevision: updated.revision,
      baseline: action === 'restart'
        ? {
          startedAt: route?.instance_started_at
            ? new Date(route.instance_started_at).toISOString()
            : null,
        }
        : undefined,
      request: {
        action,
        operation: action,
        ...(enforcement
          ? {
            reason: ACCESS_LAPSE_STOP_REASON,
            [DESPITE_ATTENTION_FIELD]: true,
            ...(enforcement.redrive ? { redrive: true } : {}),
          }
          : {}),
      },
    }, transaction);
    await this.audit.append(transaction, actor.userId, auditActionFor(action), containerId, 'container');
    return acceptedIntent(intent);
  }

  private async updateDesired(
    actor: Actor,
    scope: ListScope,
    containerId: string,
    values: DesiredValues | ((current: ContainerRow) => DesiredValues),
    request: Record<string, unknown>,
    action: AuditAction,
    validate?: (
      transaction: Transaction<NyabaseDatabase>,
      current: ContainerRow,
      /** The owner's live server grant; null for administrators and the system. */
      grant: ServerAccess | null,
    ) => Promise<void>,
  ): Promise<IntentAcceptedDto> {
    const result = await this.transactions.run(async (transaction) => {
      const current = await this.repository.lock(containerId, transaction);
      if (!current) throw new NotFoundException('Container not found');
      const access = assertCanAccess(actor, current, scope);
      if (current.lifecycle_phase === ContainerPhase.Deleting) {
        throw new ConflictException({
          code: FailureCode.InstanceBusy,
          message: 'A deleting container cannot be modified',
        });
      }
      const grant = await this.enforceInTransaction(transaction, actor, current, access);
      await validate?.(transaction, current, grant);
      const desired = typeof values === 'function' ? values(current) : values;
      const updated = await this.repository.updateDesired(
        containerId,
        current.revision,
        desired,
        transaction,
      );
      if (!updated) throw new ConflictException({ code: FailureCode.RevisionConflict });
      if (desired.lifecycle_phase === ContainerPhase.Failed) {
        await this.gpuClaims.releaseContainerClaims(containerId, transaction);
      }
      const intent = await createContainerIntent(this.intents, {
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId: containerId,
        serverId: current.server_id,
        requestedBy: actor.userId,
        targetRevision: updated.revision,
        request,
      }, transaction);
      await this.audit.append(transaction, actor.userId, action, containerId, 'container', request);
      return { intent, serverId: current.server_id };
    }, { isolationLevel: 'serializable', maxAttempts: 5 });
    return acceptedIntent(result.intent);
  }


  /**
   * A stopped -> running transition raises the owner's running memory and
   * revives the container's GPU claims; both must fit the current grant.
   */
  private async admitStart(
    transaction: Transaction<NyabaseDatabase>,
    current: ContainerRow,
    grant: ServerAccess,
  ): Promise<void> {
    await lockOwnerServerQuota(transaction, current.owner_id, current.server_id);
    assertMemoryGrant(grant, numberValue(current.mem_bytes), await this.repository.sumRunningMemBytes({
      ownerId: current.owner_id,
      serverId: current.server_id,
      excludeContainerId: current.id,
    }, transaction));
    assertClaimsGranted(
      grant.gpuPciAddresses,
      await this.gpuClaims.listForContainer(current.id, transaction),
    );
  }

  /** Re-checks the operator role against the database inside the transaction. */
  private async assertAdminInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    actor: Actor,
  ): Promise<void> {
    await assertActorRole(transaction, requireUserId(actor), Role.Operator);
  }

  /** The owner must hold current coverage of the container's server. */
  private async requireLiveGrant(
    transaction: Transaction<NyabaseDatabase>,
    actor: Actor,
    container: { server_id: string },
  ): Promise<ServerAccess> {
    const grant = await resolveServerAccess(transaction, requireUserId(actor), container.server_id);
    if (!grant) throw new ForbiddenException('Server access was revoked');
    return grant;
  }

  /**
   * Owners must still hold a live server grant (unless `coverage` is
   * `optional`, for actions that never grow usage), administrators must still
   * hold the role; the system needs neither. Returns the owner's grant.
   */
  private async enforceInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    actor: Actor,
    container: { server_id: string },
    level: ContainerAccess,
    coverage: 'required' | 'optional' = 'required',
  ): Promise<ServerAccess | null> {
    if (level === 'admin') await this.assertAdminInTransaction(transaction, actor);
    if (level !== 'owner') return null;
    if (coverage === 'optional') {
      return resolveServerAccess(transaction, requireUserId(actor), container.server_id);
    }
    return this.requireLiveGrant(transaction, actor, container);
  }

  /**
   * Validate a root-disk resize against the image minimum, the storage grant,
   * pool capacity (growth) or the shrink safety rules (shrink), under the
   * container row lock the caller already holds.
   */
  private async validateRootResize(
    transaction: Transaction<NyabaseDatabase>,
    locked: ContainerRow,
    size: number,
    grant: ServerAccess | null,
  ): Promise<void> {
    if (locked.root_size_pending_bytes !== null) {
      throw new ConflictException({
        code: FailureCode.RootQuotaPending,
        message: 'A previous root quota change is still pending',
        details: { containerId: locked.id },
      });
    }
    const image = await transaction.selectFrom('infra.images')
      .select('min_root_size_bytes')
      .where('id', '=', locked.image_id)
      .forUpdate()
      .executeTakeFirst();
    const minimum = image?.min_root_size_bytes === null || image?.min_root_size_bytes === undefined
      ? 0
      : numberValue(image.min_root_size_bytes);
    if (size < minimum) {
      throw new ConflictException({
        code: FailureCode.RootSizeBelowImageMinimum,
        message: 'Root size is below the image minimum',
        details: {
          imageId: locked.image_id,
          requestedBytes: size,
          minimumBytes: minimum,
        },
      });
    }
    const current = numberValue(locked.root_size_bytes);
    if (size === current) return;
    if (size > current) {
      // Re-growing within an unapplied shrink's reservation costs nothing.
      const { committedDeltaBytes } = rootShrinkReservation(locked, size);
      await assertRootCapacity(
        this.repository,
        transaction,
        locked.owner_id,
        locked.server_id,
        locked.root_pool_id,
        committedDeltaBytes,
        grant?.diskBytes ?? null,
      );
      return;
    }
    const pool = await transaction.selectFrom('infra.storage_pools')
      .select(['resize_family', 'quota_effective'])
      .where('id', '=', locked.root_pool_id)
      .where('registered', '=', true)
      .forUpdate()
      .executeTakeFirst();
    if (!pool) {
      throw new ConflictException({
        code: FailureCode.StoragePoolExhausted,
        message: 'The root storage pool is no longer usable',
        details: { poolId: locked.root_pool_id },
      });
    }
    if (pool.resize_family === 'quota_online' && pool.quota_effective !== true) {
      throw new ConflictException({
        code: FailureCode.StoragePoolQuotaIneffective,
        message: 'The root storage pool cannot enforce root quotas',
        details: { poolId: locked.root_pool_id },
      });
    }
    const route = await this.repository.currentRoute(locked.id, transaction);
    const failure = checkRootResize({
      containerId: locked.id,
      requestedBytes: size,
      currentBytes: current,
      usedBytes: nullableNumber(locked.root_used_bytes),
      resizeFamily: pool.resize_family,
      observedStatus: containerStatus(
        route?.instance_status,
        locked.power_intent as ContainerPowerIntent,
      ),
    });
    if (failure) throw new ConflictException(failure);
  }

  private async requireContainer(id: string): Promise<ContainerRow> {
    const row = await this.repository.find(id);
    if (!row) throw new NotFoundException('Container not found');
    return row;
  }

  private async stats(row: ContainerRow): Promise<{
    containerId: string;
    stats: null;
    ts: number;
    lastObservedAt: string;
  }> {
    const route = await this.repository.currentRoute(row.id);
    const observedAt = route?.observed_at ? new Date(route.observed_at) : new Date();
    return {
      containerId: row.id,
      stats: null,
      ts: observedAt.getTime(),
      lastObservedAt: observedAt.toISOString(),
    };
  }
}
