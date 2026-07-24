import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { EntityManager, In } from 'typeorm';
import {
  AgentTaskKind,
  AgentTaskStatus,
  CONTAINER_DELETE_PROXY_DRAIN_MS,
  ContainerPhase,
  ContainerPowerIntent,
  ServerStatus,
  UserStatus,
  parseAgentTaskPayload,
  type ContainerRuntimeAbsentTaskPayload,
  type TaskResultPayload,
} from '@nyabase/common';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import {
  hostnameReuseKey,
  monotonicReuseGuard,
  networkClaimReuseKey,
} from '../common/monotonic-reuse-guard.js';
import { ServerEntity } from '../entities/server.entity.js';
import { HttpProxyBindingEntity } from '../entities/http-proxy-binding.entity.js';
import { HttpHostnameReservationEntity } from '../entities/http-hostname-reservation.entity.js';
import { validateTerminalAgentResult } from './agent-task-result-validator.js';
import { UserEntity } from '../entities/user.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';

/**
 * Applies only the durable control-plane projection of an Agent result.
 * The caller owns the transaction which also terminates the task and releases
 * its locks. Physical effects remain the Agent handler's responsibility.
 */
@Injectable()
export class AgentTaskFinalizerService {
  async applySucceeded(
    manager: EntityManager,
    task: AgentTaskEntity,
    result: unknown,
  ): Promise<void> {
    switch (task.kind) {
      case AgentTaskKind.ContainerCreate:
        await this.finalizeContainerCreate(manager, task, result);
        return;
      case AgentTaskKind.ContainerStart:
      case AgentTaskKind.ContainerRestart:
        await this.finalizeContainerPower(manager, task, ContainerPowerIntent.Running);
        return;
      case AgentTaskKind.ContainerStop:
        await this.finalizeContainerPower(manager, task, ContainerPowerIntent.Stopped);
        return;
      case AgentTaskKind.ContainerDelete:
        await this.finalizeContainerDelete(manager, task);
        return;
      case AgentTaskKind.ContainerRuntimeAbsent:
        await this.finalizeRuntimeAbsent(manager, task);
        return;
      case AgentTaskKind.ContainerSshEnsure:
        await this.finalizeContainerUpdate(manager, task);
        return;
      case AgentTaskKind.DataDirEnsure:
        await this.finalizeDataDirEnsure(manager, task);
        return;
      case AgentTaskKind.DataDirAbsent:
        await this.finalizeDataDirAbsent(manager, task);
        return;
      case AgentTaskKind.RemoteFsEnsure:
        await this.finalizeRemoteFsEnsure(manager, task);
        return;
      case AgentTaskKind.RemoteFsAbsent:
        await this.finalizeRemoteFsAbsent(manager, task);
        return;
      case AgentTaskKind.QuotaEnsure:
        await this.finalizeQuota(manager, task);
        return;
      case AgentTaskKind.ImageEnsurePresent:
        return;
      case AgentTaskKind.ImageEnsureAbsent:
        await this.finalizeImageAbsent(manager, task);
        return;
    }
  }

  async applyFailed(
    manager: EntityManager,
    task: AgentTaskEntity,
    error: unknown,
    observed?: unknown,
  ): Promise<void> {
    if (this.isNeverDispatchedFailure(task, error, observed)) {
      await this.applyNeverDispatchedFailure(manager, task, error);
      return;
    }
    switch (task.kind) {
      case AgentTaskKind.ContainerCreate: {
        const boundRuntimeId = this.safeObservedRuntimeId(task, observed);
        const runtimeSpecHash = boundRuntimeId
          ? this.string(this.record(this.record(observed)?.safetyRollback)?.runtimeSpecHash)
            ?? this.string(this.record(observed)?.runtimeSpecHash)
          : null;
        if (boundRuntimeId && !this.isSha256(runtimeSpecHash)) {
          throw new Error('container.create failure bound a runtime without its immutable spec hash');
        }
        await this.markContainerFailed(
          manager,
          task,
          ContainerPhase.Failed,
          error,
          boundRuntimeId,
          boundRuntimeId ? this.stringArray(this.record(observed)?.quotaPaths) : [],
          runtimeSpecHash ?? undefined,
        );
        await this.alignContainerPowerFromFailure(manager, task, observed);
        return;
      }
      case AgentTaskKind.ContainerDelete:
        await this.markContainerFailed(manager, task, ContainerPhase.Failed, error);
        await this.alignContainerPowerFromFailure(manager, task, observed);
        return;
      case AgentTaskKind.ContainerStart:
      case AgentTaskKind.ContainerStop:
      case AgentTaskKind.ContainerRestart:
        await this.markContainerFailed(manager, task, ContainerPhase.Failed, error);
        await this.alignContainerPowerFromFailure(manager, task, observed);
        return;
      case AgentTaskKind.ContainerSshEnsure:
        if (this.isPreApplicationSshRuntimeStop(task, error, observed)) {
          // The runtime stopped before SSH convergence touched it. Preserve
          // the durable Running intent and return ownership to report-side
          // power recovery; an actual SSH convergence failure still follows
          // the fail-closed safety-stop branch above.
          await this.finalizeContainerUpdate(manager, task);
          return;
        }
        await this.markContainerFailed(manager, task, ContainerPhase.Failed, error);
        await this.alignContainerPowerFromFailure(manager, task, observed);
        return;
      case AgentTaskKind.ContainerRuntimeAbsent:
        await manager.update(ServerEntity, task.serverId, {
          status: ServerStatus.AgentQuarantined,
        });
        return;
      case AgentTaskKind.DataDirEnsure:
        await this.requireDataDirTaskCurrent(manager, task, 'creating');
        await manager.update(DataDirectoryEntity, task.resourceId, {
          desiredState: 'failed',
          updatedAt: new Date(),
        });
        return;
      case AgentTaskKind.DataDirAbsent:
        await this.requireDataDirTaskCurrent(manager, task, 'removing');
        await manager.update(DataDirectoryEntity, task.resourceId, {
          desiredState: 'failed',
          updatedAt: new Date(),
        });
        return;
      case AgentTaskKind.RemoteFsAbsent:
        await this.requireRemoteFsAssignment(manager, task, 'removing');
        return;
      case AgentTaskKind.RemoteFsEnsure:
        await this.assertRemoteFsTaskCurrent(manager, task);
        await manager.update(RemoteFsServerAssignmentEntity, {
          id: (await this.requireRemoteFsAssignment(manager, task)).id,
        }, {
          desiredState: 'failed',
          lastTaskId: task.id,
        });
        return;
      case AgentTaskKind.QuotaEnsure:
      case AgentTaskKind.ImageEnsurePresent:
      case AgentTaskKind.ImageEnsureAbsent:
        return;
    }
  }

  /**
   * A Backend dispatch failure is the only terminal path which may finalize
   * without decoding the durable physical payload. The persisted task markers
   * prove that no send was attempted, while the shared terminal validator
   * verifies the exact static resource identity and rejects physical claims.
   */
  private isNeverDispatchedFailure(
    task: AgentTaskEntity,
    error: unknown,
    observed: unknown,
  ): boolean {
    if (task.failureStage !== 'dispatch') return false;
    const taskError = this.record(error);
    const observation = this.record(observed);
    if (task.startedAt !== null || task.lastSentAt !== null) {
      throw new Error(`dispatch failure task ${task.id} has evidence of a prior send`);
    }
    if (
      (taskError?.code !== 'DISPATCH_PAYLOAD_INVALID'
        && taskError?.code !== 'AGENT_TASK_NOT_DISPATCHED')
      || typeof taskError.message !== 'string'
      || observation?.applied !== false
      || observation.reason !== 'never_dispatched'
    ) {
      throw new Error(`dispatch failure task ${task.id} has invalid no-effect evidence`);
    }
    const terminalResult = {
      taskId: task.id,
      payloadHash: task.payloadHash,
      status: 'failed',
      error: {
        code: taskError.code,
        message: taskError.message,
        ...(Object.prototype.hasOwnProperty.call(taskError, 'details')
          ? { details: taskError.details }
          : {}),
      },
      observed: observation,
    } satisfies Extract<TaskResultPayload, { status: 'failed' }>;
    validateTerminalAgentResult(task, terminalResult, { source: 'dispatch' });
    return true;
  }

  private async applyNeverDispatchedFailure(
    manager: EntityManager,
    task: AgentTaskEntity,
    error: unknown,
  ): Promise<void> {
    switch (task.kind) {
      case AgentTaskKind.ContainerCreate:
      case AgentTaskKind.ContainerStart:
      case AgentTaskKind.ContainerStop:
      case AgentTaskKind.ContainerRestart:
      case AgentTaskKind.ContainerDelete:
      case AgentTaskKind.ContainerSshEnsure:
        // Lifecycle ownership is sufficient here: the Backend never sent a
        // physical command, so there is no runtime binding or power state to
        // infer from the corrupt payload.
        await this.markNeverDispatchedContainerFailed(manager, task, error);
        return;
      case AgentTaskKind.ContainerRuntimeAbsent:
        await manager.update(ServerEntity, task.serverId, {
          status: ServerStatus.AgentQuarantined,
        });
        return;
      case AgentTaskKind.DataDirEnsure:
        await this.markNeverDispatchedDataDirFailed(manager, task, 'creating');
        return;
      case AgentTaskKind.DataDirAbsent:
        await this.markNeverDispatchedDataDirFailed(manager, task, 'removing');
        return;
      case AgentTaskKind.RemoteFsAbsent:
        // Assignment ownership and its transition state live outside the
        // encrypted payload, so the normal failure convergence remains safe.
        await this.requireRemoteFsAssignment(manager, task, 'removing');
        return;
      case AgentTaskKind.RemoteFsEnsure:
        // The request snapshot and assignment row are durable control-plane
        // identity. Validate both before exposing the assignment as failed.
        await this.assertRemoteFsTaskCurrent(manager, task);
        await manager.update(RemoteFsServerAssignmentEntity, {
          id: (await this.requireRemoteFsAssignment(manager, task)).id,
        }, {
          desiredState: 'failed',
          lastTaskId: task.id,
        });
        return;
      case AgentTaskKind.QuotaEnsure: {
        // Quota has no failure-state column, but still require exact task
        // ownership before the worker terminates the task and releases its lock.
        const quota = await manager.findOne(QuotaDesiredEntity, {
          where: { serverId: task.serverId, userId: task.resourceId },
        });
        if (!quota || quota.lastTaskId !== task.id) {
          throw new Error(`quota.ensure task ${task.id} no longer owns its durable projection`);
        }
        return;
      }
      case AgentTaskKind.ImageEnsurePresent:
      case AgentTaskKind.ImageEnsureAbsent:
        // Image pulls intentionally have no per-server durable projection; the
        // task itself is the user-visible outcome and the resource lock is the
        // only ownership record.
        return;
    }
  }

  private async finalizeContainerCreate(
    manager: EntityManager,
    task: AgentTaskEntity,
    result: unknown,
  ): Promise<void> {
    const runtimeId = this.resultString(result, 'runtimeId');
    if (!runtimeId) throw new Error('container.create result is missing runtimeId');
    const runtimeSpecHash = this.resultString(result, 'runtimeSpecHash');
    if (!this.isSha256(runtimeSpecHash)) {
      throw new Error('container.create result is missing immutable runtimeSpecHash');
    }
    const quotaPaths = this.stringArray(this.record(result)?.quotaPaths);
    if (quotaPaths.length !== 2) {
      throw new Error('container.create result is missing immutable quota paths');
    }
    const { lifecycle } = await this.requireContainerTaskCurrent(manager, task);
    const payload = this.record(task.payloadJson) ?? {};
    const assignedIp = this.string(payload.assignedIp);
    const reservation = await manager.findOneBy(NetworkAddressClaimEntity, {
      ownerKind: 'container',
      ownerId: task.resourceId,
    });
    const activeClaims = assignedIp
      ? await manager.find(NetworkAddressClaimEntity, {
        where: { address: assignedIp, state: 'active' },
      })
      : [];
    if (
      !assignedIp
      || !reservation
      || reservation.serverId !== task.serverId
      || reservation.networkKey.length === 0
      || reservation.address !== assignedIp
      || reservation.state !== 'active'
      || activeClaims.length !== 1
      || activeClaims[0]?.id !== reservation.id
    ) {
      throw new Error(`container.create task ${task.id} has no matching active IP reservation`);
    }
    const now = new Date();
    if (lifecycle.boundRuntimeId && lifecycle.boundRuntimeId !== runtimeId) {
      throw new Error(`container.create task ${task.id} conflicts with its durable runtime binding`);
    }
    await manager.update(ContainerLifecycleEntity, task.resourceId, {
      phase: ContainerPhase.Active,
      boundRuntimeId: runtimeId,
      quotaPathsJson: quotaPaths,
      runtimeSpecHash,
      activeTaskId: null,
      lastTransitionAt: now,
      failureReason: null,
      failureCode: null,
    });
  }

  private async finalizeContainerPower(
    manager: EntityManager,
    task: AgentTaskEntity,
    intent: ContainerPowerIntent,
  ): Promise<void> {
    await this.requireContainerTaskCurrent(manager, task);
    const now = new Date();
    await manager.update(ContainerDesiredSpecEntity, { containerId: task.resourceId }, {
      powerIntent: intent,
      updatedAt: now,
    });
    await manager.update(ContainerLifecycleEntity, task.resourceId, {
      phase: ContainerPhase.Active,
      activeTaskId: null,
      lastTransitionAt: now,
      failureReason: null,
      failureCode: null,
    });
  }

  private async finalizeContainerUpdate(
    manager: EntityManager,
    task: AgentTaskEntity,
  ): Promise<void> {
    await this.requireContainerTaskCurrent(manager, task);
    await manager.update(ContainerLifecycleEntity, task.resourceId, {
      phase: ContainerPhase.Active,
      activeTaskId: null,
      lastTransitionAt: new Date(),
      failureReason: null,
      failureCode: null,
    });
  }

  private async markContainerFailed(
    manager: EntityManager,
    task: AgentTaskEntity,
    phase: ContainerPhase,
    error: unknown,
    boundRuntimeId?: string,
    quotaPaths: string[] = [],
    runtimeSpecHash?: string,
  ): Promise<void> {
    await this.requireContainerTaskCurrent(manager, task);
    await manager.update(ContainerLifecycleEntity, task.resourceId, {
      phase,
      ...(boundRuntimeId ? { boundRuntimeId } : {}),
      ...(quotaPaths.length === 2 ? { quotaPathsJson: quotaPaths } : {}),
      ...(runtimeSpecHash ? { runtimeSpecHash } : {}),
      activeTaskId: null,
      lastTransitionAt: new Date(),
      failureReason: this.errorMessage(error),
      failureCode: this.string(this.record(error)?.code) ?? 'task_failed',
    });
  }

  private async markNeverDispatchedContainerFailed(
    manager: EntityManager,
    task: AgentTaskEntity,
    error: unknown,
  ): Promise<void> {
    await this.requireContainerTaskCurrent(manager, task, false);
    await manager.update(ContainerLifecycleEntity, task.resourceId, {
      phase: ContainerPhase.Failed,
      activeTaskId: null,
      lastTransitionAt: new Date(),
      failureReason: this.errorMessage(error),
      failureCode: this.string(this.record(error)?.code) ?? 'DISPATCH_PAYLOAD_INVALID',
    });
  }

  private async markNeverDispatchedDataDirFailed(
    manager: EntityManager,
    task: AgentTaskEntity,
    desiredState: 'creating' | 'removing',
  ): Promise<void> {
    await this.requireDataDirTaskCurrent(manager, task, desiredState, false);
    await manager.update(DataDirectoryEntity, task.resourceId, {
      desiredState: 'failed',
      updatedAt: new Date(),
    });
  }

  private safeObservedRuntimeId(task: AgentTaskEntity, observed: unknown): string | undefined {
    const record = this.record(observed);
    if (!record || Array.isArray(record.runtimeIds)) return undefined;
    const rollback = this.record(record.safetyRollback);
    if (rollback && Array.isArray(rollback.runtimeIds)) return undefined;
    const barrier = rollback ?? record;
    if (record.applied === false || barrier.applied === false || barrier.present === false) return undefined;
    if (
      barrier.running !== false
      || this.string(barrier.containerId) !== task.resourceId
      || this.string(barrier.serverId) !== task.serverId
    ) return undefined;
    return this.string(barrier.runtimeId) ?? undefined;
  }

  private async alignContainerPowerFromFailure(
    manager: EntityManager,
    task: AgentTaskEntity,
    observed: unknown,
  ): Promise<void> {
    const record = this.record(observed);
    if (!record || Array.isArray(record.runtimeIds)) return;
    const rollback = this.record(record.safetyRollback);
    if (rollback && Array.isArray(rollback.runtimeIds)) return;
    const barrier = rollback ?? record;
    const containerId = this.string(barrier.containerId) ?? this.string(record.containerId);
    if (containerId !== task.resourceId) return;
    let powerIntent: ContainerPowerIntent | null = null;
    if (barrier.present === false) powerIntent = ContainerPowerIntent.Stopped;
    else if (barrier.running === false) powerIntent = ContainerPowerIntent.Stopped;
    else if (barrier.running === true) powerIntent = ContainerPowerIntent.Running;
    if (!powerIntent) return;
    await manager.update(ContainerDesiredSpecEntity, { containerId: task.resourceId }, {
      powerIntent,
      updatedAt: new Date(),
    });
  }

  private isPreApplicationSshRuntimeStop(
    task: AgentTaskEntity,
    error: unknown,
    observed: unknown,
  ): boolean {
    if (this.string(this.record(error)?.code) !== 'container_ssh_runtime_stopped') return false;
    const record = this.record(observed);
    const rollback = this.record(record?.safetyRollback);
    const payload = this.record(task.payloadJson);
    if (
      !record
      || record.applied !== false
      || record.running !== false
      || !rollback
      || rollback.running !== false
      || Array.isArray(record.runtimeIds)
      || Array.isArray(rollback.runtimeIds)
    ) return false;
    const runtimeId = this.string(payload?.runtimeId);
    if (
      !runtimeId
      || this.string(payload?.containerId) !== task.resourceId
    ) return false;
    return this.string(record.containerId) === task.resourceId
      && this.string(record.serverId) === task.serverId
      && this.string(record.runtimeId) === runtimeId
      && this.string(rollback.containerId) === task.resourceId
      && this.string(rollback.serverId) === task.serverId
      && this.string(rollback.runtimeId) === runtimeId;
  }

  private async finalizeContainerDelete(manager: EntityManager, task: AgentTaskEntity): Promise<void> {
    const { container } = await this.requireContainerTaskCurrent(manager, task);
    const reservation = await manager.findOneBy(NetworkAddressClaimEntity, {
      ownerKind: 'container',
      ownerId: task.resourceId,
    });
    if (
      !reservation
      || reservation.serverId !== container.serverId
      || reservation.networkKey.length === 0
      || reservation.state !== 'active'
    ) {
      throw new Error(`container.delete task ${task.id} has no matching active IP reservation`);
    }
    const reusableAt = new Date(Date.now() + CONTAINER_DELETE_PROXY_DRAIN_MS);
    monotonicReuseGuard.arm(networkClaimReuseKey(reservation.id));
    await manager.update(NetworkAddressClaimEntity, reservation.id, {
      state: 'releasing',
      reusableAt,
    });
    const bindings = await manager.find(HttpProxyBindingEntity, {
      where: { containerId: task.resourceId },
    });
    for (const binding of bindings) {
      const hostname = await manager.findOneBy(HttpHostnameReservationEntity, {
        hostname: binding.hostname,
      });
      if (
        !hostname
        || hostname.state !== 'active'
        || hostname.bindingId !== binding.id
        || hostname.ownerId !== binding.ownerId
      ) {
        throw new Error(`container.delete task ${task.id} has no matching hostname reservation`);
      }
      await manager.update(HttpHostnameReservationEntity, binding.hostname, {
        state: 'releasing',
        bindingId: null,
        reusableAt,
      });
      monotonicReuseGuard.arm(hostnameReuseKey(binding.hostname));
    }
    // A successful Agent delete is proof that the exact physical runtime and
    // quota paths are absent. There is no second tombstone lifecycle: the
    // container row is the aggregate root and database cascades remove its
    // desired/lifecycle/mount/GPU/SSH/HTTP projections atomically. The terminal
    // AgentTask remains as the durable success record.
    await manager.delete(ContainerEntity, task.resourceId);
  }

  private async finalizeRuntimeAbsent(manager: EntityManager, task: AgentTaskEntity): Promise<void> {
    const payload = parseAgentTaskPayload(
      AgentTaskKind.ContainerRuntimeAbsent,
      task.payloadJson,
    ) as ContainerRuntimeAbsentTaskPayload;
    const claims = await manager.find(NetworkAddressClaimEntity, {
      where: {
        ownerKind: 'runtime_cleanup',
        ownerId: task.resourceId,
        serverId: task.serverId,
        state: 'active',
      },
    });
    if (!claims.some((claim) => claim.address === payload.observedIp)) {
      throw new Error(
        `runtime cleanup task ${task.id} has no active claim for its observed address`,
      );
    }
    const expectedIdentity = this.runtimeCleanupIdentity(payload);
    for (const claim of claims) {
      const claimPayload = parseAgentTaskPayload(
        AgentTaskKind.ContainerRuntimeAbsent,
        claim.cleanupPayloadJson,
      ) as ContainerRuntimeAbsentTaskPayload;
      if (
        claim.address !== claimPayload.observedIp
        || !isDeepStrictEqual(this.runtimeCleanupIdentity(claimPayload), expectedIdentity)
      ) {
        throw new Error(
          `runtime cleanup task ${task.id} conflicts with address claim ${claim.id}`,
        );
      }
    }
    const reusableAt = new Date(Date.now() + CONTAINER_DELETE_PROXY_DRAIN_MS);
    for (const claim of claims) {
      monotonicReuseGuard.arm(networkClaimReuseKey(claim.id));
      await manager.update(NetworkAddressClaimEntity, claim.id, {
        state: 'releasing',
        reusableAt,
      });
    }
  }

  private runtimeCleanupIdentity(payload: ContainerRuntimeAbsentTaskPayload): unknown {
    return {
      runtimeId: payload.runtimeId,
      containerId: payload.containerId,
      serverId: payload.serverId,
      specGeneration: payload.specGeneration,
      runtimeSpecHash: payload.runtimeSpecHash,
      quotaPaths: payload.quotaPaths,
    };
  }

  private async finalizeDataDirEnsure(manager: EntityManager, task: AgentTaskEntity): Promise<void> {
    await this.requireDataDirTaskCurrent(manager, task, 'creating');
    await manager.update(DataDirectoryEntity, task.resourceId, {
      desiredState: 'active',
      updatedAt: new Date(),
    });
  }

  private async finalizeDataDirAbsent(manager: EntityManager, task: AgentTaskEntity): Promise<void> {
    await this.requireDataDirTaskCurrent(manager, task, 'removing');
    await manager.delete(DataDirectoryEntity, task.resourceId);
  }

  private async requireContainerTaskCurrent(
    manager: EntityManager,
    task: AgentTaskEntity,
    validatePayload = true,
  ): Promise<{
    container: ContainerEntity;
    desired: ContainerDesiredSpecEntity;
    lifecycle: ContainerLifecycleEntity;
  }> {
    const [container, desired, lifecycle] = await Promise.all([
      manager.findOneBy(ContainerEntity, { id: task.resourceId }),
      manager.findOneBy(ContainerDesiredSpecEntity, { containerId: task.resourceId }),
      manager.findOneBy(ContainerLifecycleEntity, { containerId: task.resourceId }),
    ]);
    if (!container || !desired || !lifecycle) {
      throw new Error(`container task ${task.id} durable projection is missing`);
    }
    if (
      container.serverId !== task.serverId
      || desired.containerId !== task.resourceId
      || lifecycle.containerId !== task.resourceId
    ) {
      throw new Error(`container task ${task.id} no longer matches its durable resource`);
    }
    if (lifecycle.activeTaskId !== task.id) {
      throw new Error(`container task ${task.id} no longer owns the durable lifecycle`);
    }
    const expectedPhase = task.kind === AgentTaskKind.ContainerCreate
      ? ContainerPhase.Provisioning
      : task.kind === AgentTaskKind.ContainerDelete
        ? ContainerPhase.Deleting
        : ContainerPhase.Updating;
    if (lifecycle.phase !== expectedPhase) {
      throw new Error(
        `container task ${task.id} lifecycle is ${lifecycle.phase}, expected ${expectedPhase}`,
      );
    }
    if (validatePayload) {
      const payload = this.record(task.payloadJson) ?? {};
      if (this.string(payload.containerId) !== task.resourceId) {
        throw new Error(`container task ${task.id} payload identity no longer matches its resource`);
      }
      if (task.kind === AgentTaskKind.ContainerCreate) {
        const generation = this.number(payload.specGeneration);
        if (generation === null || desired.generation !== generation) {
          throw new Error(`container.create task ${task.id} no longer owns its desired generation`);
        }
      }
    }
    return { container, desired, lifecycle };
  }

  private async requireDataDirTaskCurrent(
    manager: EntityManager,
    task: AgentTaskEntity,
    desiredState: 'creating' | 'removing',
    validatePayload = true,
  ): Promise<DataDirectoryEntity> {
    const row = await manager.findOneBy(DataDirectoryEntity, { id: task.resourceId });
    if (!row) throw new Error(`datadir task ${task.id} durable projection is missing`);
    if (
      row.lastTaskId !== task.id
      || row.desiredState !== desiredState
      || (row.sourceKind === 'local' && row.serverId !== task.serverId)
    ) {
      throw new Error(`datadir task ${task.id} no longer owns its durable projection`);
    }
    if (!validatePayload) return row;
    const payload = this.record(task.payloadJson) ?? {};
    const generation = this.number(payload.generation);
    if (
      generation === null
      || row.generation !== generation
      || this.string(payload.resourceId) !== task.resourceId
      || this.string(payload.diskId) !== row.sourceId
      || this.string(payload.sourceIdentity) !== row.sourceIdentity
    ) {
      throw new Error(`datadir task ${task.id} no longer owns its durable generation`);
    }
    if (desiredState === 'creating' && row.sourceKind === 'local') {
      const quotaGeneration = this.number(payload.quotaGeneration);
      const numericUserId = this.number(payload.numericUserId);
      const diskBytes = this.number(payload.diskBytes);
      const quota = await manager.findOne(QuotaDesiredEntity, {
        where: { serverId: task.serverId, userId: row.userId },
      });
      if (
        !quota
        || !quota.lastTaskId
        || quotaGeneration === null
        || numericUserId === null
        || diskBytes === null
        || quota.generation !== quotaGeneration
        || quota.numericUserId !== numericUserId
        || quota.limitBytes !== diskBytes
      ) {
        throw new Error(`datadir task ${task.id} no longer matches durable quota intent`);
      }
    }
    return row;
  }

  private async finalizeRemoteFsEnsure(manager: EntityManager, task: AgentTaskEntity): Promise<void> {
    await this.assertRemoteFsTaskCurrent(manager, task);
    const assignment = await this.requireRemoteFsAssignment(manager, task);
    await manager.update(RemoteFsServerAssignmentEntity, assignment.id, {
      desiredState: 'active',
      lastTaskId: task.id,
    });
  }

  private async finalizeRemoteFsAbsent(manager: EntityManager, task: AgentTaskEntity): Promise<void> {
    const request = this.record(task.requestJson) ?? {};
    if (request.scope !== 'assignment') {
      throw new Error('remote_fs.absent only supports assignment scope');
    }
    const assignment = await this.requireRemoteFsAssignment(manager, task, 'removing');
    await manager.delete(RemoteFsServerAssignmentEntity, assignment.id);
  }

  private async finalizeImageAbsent(manager: EntityManager, task: AgentTaskEntity): Promise<void> {
    const image = await manager.findOneBy(ImageEntity, { id: task.resourceId });
    if (!image || !image.deleting) {
      throw new Error(`image cleanup task ${task.id} has no durable deleting owner`);
    }
    const request = this.record(task.requestJson) ?? {};
    const generation = this.number(request.cleanupGeneration);
    if (
      generation === null
      || generation !== image.cleanupGeneration
      || this.string(request.dockerRef) !== image.dockerImage
    ) {
      throw new Error(`image cleanup task ${task.id} no longer owns its durable generation`);
    }
    const unresolved = await manager.createQueryBuilder(AgentTaskEntity, 'candidate')
      .where('candidate.kind = :kind', { kind: AgentTaskKind.ImageEnsureAbsent })
      .andWhere('candidate.resource_type = :resourceType', { resourceType: 'image' })
      .andWhere('candidate.resource_id = :resourceId', { resourceId: image.id })
      .andWhere('candidate.id != :taskId', { taskId: task.id })
      .andWhere('candidate.status != :succeeded', { succeeded: AgentTaskStatus.Succeeded })
      // SQLite extracts only the scalar generation. Never materialize every
      // Server cleanup task's potentially large payload/request/result rows.
      // A malformed generation cannot be proven old, so it blocks deletion.
      // A valid older generation is unrelated; only the current generation
      // must converge successfully on every Server before the image row drops.
      .andWhere(`COALESCE(
        CASE WHEN json_valid(candidate.request_json) = 1 THEN
          CASE WHEN json_type(candidate.request_json, '$.cleanupGeneration') = 'integer'
            THEN json_extract(candidate.request_json, '$.cleanupGeneration')
            ELSE NULL
          END
        ELSE NULL END,
        :generation
      ) = :generation`, { generation })
      .getExists();
    if (!unresolved) await manager.remove(ImageEntity, image);
  }

  private async assertRemoteFsTaskCurrent(
    manager: EntityManager,
    task: AgentTaskEntity,
  ): Promise<void> {
    const request = this.record(task.requestJson) ?? {};
    if (request.scope !== 'assign') {
      throw new Error('remote_fs.ensure only supports assignment scope');
    }
    const expected = this.record(request.mount);
    if (!expected) throw new Error('remote_fs.ensure finalizer is missing mount spec');
    const current = await manager.findOneBy(RemoteFsMountEntity, { id: task.resourceId });
    if (!current || current.desiredState !== 'active') {
      throw new Error(`remote_fs.ensure mount ${task.resourceId} is missing or inactive`);
    }
    const samePhysicalSpec =
      this.string(expected.type) === current.type
      && this.string(expected.hostMountPoint) === current.hostMountPoint
      && (typeof expected.options === 'string' ? expected.options : '') === current.options
      && this.number(expected.generation) === current.generation
      && isDeepStrictEqual(expected.params, current.params);
    if (!samePhysicalSpec) {
      throw new Error(`remote_fs.ensure mount ${task.resourceId} generation or physical spec changed`);
    }
  }

  private async requireRemoteFsAssignment(
    manager: EntityManager,
    task: AgentTaskEntity,
    desiredState?: 'ensuring' | 'active' | 'removing' | 'failed',
  ): Promise<RemoteFsServerAssignmentEntity> {
    const assignment = await manager.findOne(RemoteFsServerAssignmentEntity, {
      where: { remoteFsMountId: task.resourceId, serverId: task.serverId },
    });
    if (!assignment || assignment.lastTaskId !== task.id) {
      throw new Error(`remote_fs assignment for task ${task.id} is missing or superseded`);
    }
    if (desiredState && assignment.desiredState !== desiredState) {
      throw new Error(
        `remote_fs assignment for task ${task.id} is ${assignment.desiredState}, expected ${desiredState}`,
      );
    }
    return assignment;
  }

  private async finalizeQuota(manager: EntityManager, task: AgentTaskEntity): Promise<void> {
    const payload = this.record(task.payloadJson) ?? {};
    const generation = this.number(payload.generation);
    const numericUserId = this.number(payload.numericUserId);
    const limitBytes = this.number(payload.diskBytes);
    if (generation === null || numericUserId === null || limitBytes === null) {
      throw new Error('quota.ensure finalizer is missing generation, numericUserId, or diskBytes');
    }
    const existing = await manager.findOne(QuotaDesiredEntity, {
      where: { serverId: task.serverId, userId: task.resourceId },
    });
    if (
      !existing
      || existing.lastTaskId !== task.id
      || existing.generation !== generation
      || existing.numericUserId !== numericUserId
      || existing.limitBytes !== limitBytes
    ) {
      throw new Error(`quota.ensure task ${task.id} no longer matches its durable desired generation`);
    }
    await this.finalizeDeletingUserAfterQuota(manager, task);
  }

  private async finalizeDeletingUserAfterQuota(
    manager: EntityManager,
    currentTask: AgentTaskEntity,
  ): Promise<void> {
    const user = await manager.findOneBy(UserEntity, { id: currentTask.resourceId });
    if (user?.status !== UserStatus.Deleting) return;

    const [container, dataDir, desiredQuotas] = await Promise.all([
      manager.findOneBy(ContainerEntity, { ownerId: user.id }),
      manager.findOneBy(DataDirectoryEntity, { userId: user.id }),
      manager.find(QuotaDesiredEntity, { where: { userId: user.id } }),
    ]);
    if (container || dataDir) {
      throw new Error(`deleting user ${user.id} acquired a resource during quota drain`);
    }
    if (desiredQuotas.some((desired) => desired.limitBytes !== 0 || !desired.lastTaskId)) return;

    const otherTaskIds = desiredQuotas
      .map((desired) => desired.lastTaskId!)
      .filter((taskId) => taskId !== currentTask.id);
    const otherTasks = otherTaskIds.length === 0
      ? []
      : await manager.find(AgentTaskEntity, {
          select: {
            id: true,
            status: true,
            kind: true,
            resourceType: true,
            resourceId: true,
            serverId: true,
            payloadJson: true,
          },
          where: { id: In(otherTaskIds) },
        });
    const taskById = new Map(otherTasks.map((task) => [task.id, task]));
    taskById.set(currentTask.id, currentTask);

    for (const desired of desiredQuotas) {
      const proof = taskById.get(desired.lastTaskId!);
      if (!proof) throw new Error(`deleting user ${user.id} is missing quota proof ${desired.lastTaskId}`);
      const isCurrent = proof.id === currentTask.id;
      if (!isCurrent && proof.status !== AgentTaskStatus.Succeeded) return;
      const payload = this.record(proof.payloadJson);
      if (
        proof.kind !== AgentTaskKind.QuotaEnsure
        || proof.resourceType !== 'quota'
        || proof.resourceId !== user.id
        || proof.serverId !== desired.serverId
        || this.number(payload?.generation) !== desired.generation
        || this.number(payload?.numericUserId) !== desired.numericUserId
        || this.number(payload?.diskBytes) !== 0
      ) {
        throw new Error(`deleting user ${user.id} has mismatched quota proof ${proof.id}`);
      }
    }

    // The initial delete request already removes both key classes when it
    // enters Deleting. Repeat idempotently for upgrade-era Deleting rows before
    // the same transaction makes the terminal tombstone visible.
    await manager.delete(SshPublicKeyEntity, { userId: user.id });
    await manager.delete(UserInternalSshKeyEntity, { userId: user.id });
    await manager.delete(QuotaDesiredEntity, { userId: user.id });
    await manager.update(UserEntity, user.id, { status: UserStatus.Deleted });
  }

  private resultString(result: unknown, key: string): string | null {
    return this.string(this.record(result)?.[key]);
  }

  private record(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private string(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private number(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    const record = this.record(error);
    return this.string(record?.message) ?? String(error);
  }

  private isSha256(value: string | null): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }
}
