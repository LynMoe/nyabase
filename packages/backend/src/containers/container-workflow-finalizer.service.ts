import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AgentTaskKind,
  AgentTaskStatus,
  CONTAINER_DELETE_PROXY_DRAIN_MS,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  ServerStatus,
  parseAgentTaskPayload,
  type ContainerRuntimeAbsentTaskPayload,
} from '@nyabase/common';
import type { Transaction } from 'kysely';
import { isDeepStrictEqual } from 'node:util';
import {
  monotonicReuseGuard,
  networkClaimReuseKey,
} from '../common/monotonic-reuse-guard.js';
import {
  WorkflowFinalizerRegistry,
  type WorkflowTerminalResult,
} from '../agent-tasks/workflow-finalizer.registry.js';
import type {
  WorkflowFinalizerOutcome,
  WorkflowTaskRecord,
} from '../agent-tasks/workflow.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import {
  ContainerControlRepository,
  type ContainerAggregate,
  type ContainerSshRouteRecord,
} from './container-control.repository.js';

const KINDS = [
  AgentTaskKind.ContainerCreate,
  AgentTaskKind.ContainerStart,
  AgentTaskKind.ContainerStop,
  AgentTaskKind.ContainerRestart,
  AgentTaskKind.ContainerDelete,
  AgentTaskKind.ContainerRuntimeAbsent,
  AgentTaskKind.ContainerSshEnsure,
] as const;

/**
 * Canonical Container projection side of the Workflow terminal barrier.
 *
 * The Workflow worker invokes this handler after terminal result evidence is
 * durable. Projection, task terminalization and claim release share the same
 * PostgreSQL transaction, so a crash can expose neither half of the outcome.
 */
@Injectable()
export class ContainerWorkflowFinalizerService
implements OnModuleInit, OnModuleDestroy {
  private unregister: Array<() => void> = [];

  constructor(
    private readonly registry: WorkflowFinalizerRegistry,
    private readonly containers: ContainerControlRepository,
  ) {}

  onModuleInit(): void {
    this.unregister = KINDS.map((kind) => this.registry.register(
      kind,
      (transaction, task, result) => this.finalize(
        transaction,
        task,
        result,
      ),
    ));
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregister.splice(0)) unregister();
  }

  private async finalize(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
    terminal: WorkflowTerminalResult,
  ): Promise<WorkflowFinalizerOutcome> {
    const kind = task.kind as AgentTaskKind;
    if (!KINDS.includes(kind as typeof KINDS[number])) {
      throw new Error(`Unsupported Container Workflow finalizer ${task.kind}`);
    }
    if (terminal.status === 'succeeded') {
      await this.applySucceeded(transaction, task, kind, terminal.result);
      return {
        status: AgentTaskStatus.Succeeded,
        result: terminal.result,
        releaseClaims: true,
      };
    }
    await this.applyFailed(
      transaction,
      task,
      kind,
      terminal.error,
      terminal.observed,
    );
    return {
      status: AgentTaskStatus.Failed,
      error: terminal.error,
      failureStage: 'agent',
      releaseClaims: true,
    };
  }

  private async applySucceeded(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
    kind: AgentTaskKind,
    result: unknown,
  ): Promise<void> {
    if (kind === AgentTaskKind.ContainerRuntimeAbsent) {
      await this.finalizeRuntimeAbsent(transaction, task);
      return;
    }
    const container = await this.requireCurrent(transaction, task, kind);
    switch (kind) {
      case AgentTaskKind.ContainerCreate: {
        const payload = this.payload(kind, task.payload);
        const evidence = this.record(result);
        const runtimeId = this.nonEmptyString(evidence?.runtimeId);
        const runtimeSpecHash = this.nonEmptyString(evidence?.runtimeSpecHash);
        const quotaPaths = this.stringArray(evidence?.quotaPaths);
        if (
          !runtimeId
          || !runtimeSpecHash
          || !/^[a-f0-9]{64}$/u.test(runtimeSpecHash)
          || quotaPaths.length !== 2
        ) throw new Error(`container.create task ${task.id} lacks immutable runtime evidence`);
        const claim = await this.containers.networkClaimForContainer(
          container.id,
          transaction,
        );
        if (
          !claim
          || claim.serverId !== task.serverId
          || claim.state !== 'active'
          || claim.address !== payload.assignedIp
        ) throw new Error(`container.create task ${task.id} has no matching active IP reservation`);
        await this.transition(container, {
          lifecyclePhase: ContainerPhase.Active,
          observedGeneration: container.desiredGeneration,
          boundRuntimeId: runtimeId,
          quotaPaths,
          runtimeSpecHash,
          activeTaskId: null,
          failureReason: null,
          failureCode: null,
        }, transaction);
        await this.projectSshEvidence(
          transaction,
          container,
          runtimeId,
          claim.address,
          evidence?.ssh,
        );
        return;
      }
      case AgentTaskKind.ContainerStart:
      case AgentTaskKind.ContainerRestart: {
        const payload = this.payload(kind, task.payload);
        await this.transition(container, {
          lifecyclePhase: ContainerPhase.Active,
          powerIntent: ContainerPowerIntent.Running,
          activeTaskId: null,
          failureReason: null,
          failureCode: null,
        }, transaction);
        const claim = await this.containers.networkClaimForContainer(
          container.id,
          transaction,
        );
        await this.projectSshEvidence(
          transaction,
          container,
          payload.runtimeId,
          claim?.address ?? null,
          this.record(result)?.ssh,
        );
        return;
      }
      case AgentTaskKind.ContainerStop: {
        const payload = this.payload(kind, task.payload);
        await this.transition(container, {
          lifecyclePhase: ContainerPhase.Active,
          powerIntent: ContainerPowerIntent.Stopped,
          activeTaskId: null,
          failureReason: null,
          failureCode: null,
        }, transaction);
        const existing = (await this.containers.routes(
          [container.id],
          transaction,
        )).get(container.id);
        if (existing && existing.runtimeId === payload.runtimeId) {
          await this.containers.upsertRoute({
            ...existing,
            runtimeStatus: ContainerStatus.Exited,
            sshStatus: 'container_stopped',
            lastError: null,
            observedAt: new Date(),
          }, transaction);
        }
        return;
      }
      case AgentTaskKind.ContainerSshEnsure: {
        const payload = this.payload(kind, task.payload);
        await this.transition(container, {
          lifecyclePhase: ContainerPhase.Active,
          activeTaskId: null,
          failureReason: null,
          failureCode: null,
        }, transaction);
        const claim = await this.containers.networkClaimForContainer(
          container.id,
          transaction,
        );
        await this.projectSshEvidence(
          transaction,
          container,
          payload.runtimeId,
          claim?.address ?? null,
          this.record(result)?.ssh,
        );
        return;
      }
      case AgentTaskKind.ContainerDelete: {
        const claim = await this.containers.networkClaimForContainer(
          container.id,
          transaction,
        );
        if (
          !claim
          || claim.serverId !== container.serverId
          || claim.state !== 'active'
        ) throw new Error(`container.delete task ${task.id} has no matching active IP reservation`);
        const reusableAt = await this.containers.networkClaimReuseDeadline(
          CONTAINER_DELETE_PROXY_DRAIN_MS,
          transaction,
        );
        if (!await this.containers.markNetworkClaimReleasing(
          container.id,
          reusableAt,
          transaction,
        )) throw new Error(`container.delete task ${task.id} lost its active IP reservation`);
        monotonicReuseGuard.arm(networkClaimReuseKey(claim.id));
        if (!await this.containers.delete(container.id, container.revision, transaction)) {
          throw new Error(`container.delete task ${task.id} lost its revision fence`);
        }
        return;
      }
      default:
        throw new Error(`Unsupported Container success finalizer ${kind}`);
    }
  }

  private async applyFailed(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
    kind: AgentTaskKind,
    error: unknown,
    observed: unknown,
  ): Promise<void> {
    if (kind === AgentTaskKind.ContainerRuntimeAbsent) {
      await transaction.updateTable('infra.servers').set({
        status: ServerStatus.AgentQuarantined,
        quarantine_code: 'RUNTIME_CLEANUP_FAILED',
        quarantine_message: this.errorMessage(error),
      }).where('id', '=', task.serverId).executeTakeFirstOrThrow();
      return;
    }
    const container = await this.requireCurrent(
      transaction,
      task,
      kind,
      false,
    );
    if (
      kind === AgentTaskKind.ContainerSshEnsure
      && this.isPreApplicationSshRuntimeStop(task, error, observed)
    ) {
      await this.transition(container, {
        lifecyclePhase: ContainerPhase.Active,
        activeTaskId: null,
        failureReason: null,
        failureCode: null,
      }, transaction);
      return;
    }
    const patch: Parameters<ContainerControlRepository['transition']>[2] = {
      lifecyclePhase: ContainerPhase.Failed,
      activeTaskId: null,
      failureReason: this.errorMessage(error),
      failureCode: this.nonEmptyString(this.record(error)?.code) ?? 'task_failed',
    };
    if (kind === AgentTaskKind.ContainerCreate) {
      const boundRuntimeId = this.safeObservedRuntimeId(task, observed);
      if (boundRuntimeId) {
        const observation = this.record(observed);
        const rollback = this.record(observation?.safetyRollback);
        const hash = this.nonEmptyString(rollback?.runtimeSpecHash)
          ?? this.nonEmptyString(observation?.runtimeSpecHash);
        const quotaPaths = this.stringArray(observation?.quotaPaths);
        if (!hash || !/^[a-f0-9]{64}$/u.test(hash) || quotaPaths.length !== 2) {
          throw new Error(
            'container.create failure bound a runtime without immutable recovery evidence',
          );
        }
        patch.boundRuntimeId = boundRuntimeId;
        patch.runtimeSpecHash = hash;
        patch.quotaPaths = quotaPaths;
      }
    }
    const observedPower = this.observedPower(task, observed);
    if (observedPower) patch.powerIntent = observedPower;
    await this.transition(container, patch, transaction);
    if (observedPower === ContainerPowerIntent.Stopped) {
      const route = (await this.containers.routes(
        [container.id],
        transaction,
      )).get(container.id);
      if (route) {
        await this.containers.upsertRoute({
          ...route,
          runtimeStatus: ContainerStatus.Exited,
          sshStatus: 'container_stopped',
          lastError: this.errorMessage(error),
          observedAt: new Date(),
        }, transaction);
      }
    }
  }

  private async requireCurrent(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
    kind: AgentTaskKind,
    validatePayload = true,
  ): Promise<ContainerAggregate> {
    const container = await this.containers.lock(task.resourceId, transaction);
    if (!container || container.serverId !== task.serverId) {
      throw new Error(`container task ${task.id} durable projection is missing`);
    }
    if (container.activeTaskId !== task.id) {
      throw new Error(`container task ${task.id} no longer owns its durable projection`);
    }
    const expectedPhase = kind === AgentTaskKind.ContainerCreate
      ? ContainerPhase.Provisioning
      : kind === AgentTaskKind.ContainerDelete
        ? ContainerPhase.Deleting
        : ContainerPhase.Updating;
    if (container.lifecyclePhase !== expectedPhase) {
      throw new Error(
        `container task ${task.id} phase is ${container.lifecyclePhase}, expected ${expectedPhase}`,
      );
    }
    if (validatePayload) {
      const payload = this.payload(kind, task.payload);
      if (this.nonEmptyString(payload.containerId) !== task.resourceId) {
        throw new Error(`container task ${task.id} payload identity changed`);
      }
      if (
        kind === AgentTaskKind.ContainerCreate
        && payload.specGeneration !== container.desiredGeneration
      ) throw new Error(`container.create task ${task.id} lost its desired generation`);
    }
    return container;
  }

  private async transition(
    container: ContainerAggregate,
    patch: Parameters<ContainerControlRepository['transition']>[2],
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    if (!await this.containers.transition(
      container.id,
      container.revision,
      patch,
      transaction,
    )) throw new Error(`Container ${container.id} lost its revision fence`);
  }

  private async finalizeRuntimeAbsent(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
  ): Promise<void> {
    const payload = this.payload(
      AgentTaskKind.ContainerRuntimeAbsent,
      task.payload,
    ) as ContainerRuntimeAbsentTaskPayload;
    if (
      task.resourceId !== payload.runtimeId
      || task.serverId !== payload.serverId
    ) throw new Error(`runtime cleanup task ${task.id} durable identity changed`);
    const claim = (await this.containers.runtimeCleanupClaims(
      task.serverId,
      transaction,
    )).find((candidate) =>
      candidate.ownerId === payload.runtimeId
      && candidate.state === 'active');
    if (
      !claim
      || claim.address !== payload.observedIp
      || !isDeepStrictEqual(
        this.runtimeCleanupIdentity(
          parseAgentTaskPayload(
            AgentTaskKind.ContainerRuntimeAbsent,
            claim.cleanupPayload,
          ) as ContainerRuntimeAbsentTaskPayload,
        ),
        this.runtimeCleanupIdentity(payload),
      )
    ) throw new Error(`runtime cleanup task ${task.id} has no matching active claim`);
    const reusableAt = await this.containers.networkClaimReuseDeadline(
      CONTAINER_DELETE_PROXY_DRAIN_MS,
      transaction,
    );
    const released = await this.containers.markRuntimeCleanupReleasing(
      payload.runtimeId,
      task.serverId,
      reusableAt,
      transaction,
    );
    if (!released || released.id !== claim.id) {
      throw new Error(`runtime cleanup task ${task.id} lost its claim fence`);
    }
    monotonicReuseGuard.arm(networkClaimReuseKey(claim.id));
  }

  private async projectSshEvidence(
    transaction: Transaction<NyabaseDatabase>,
    container: ContainerAggregate,
    runtimeId: string,
    ip: string | null,
    value: unknown,
  ): Promise<void> {
    const ssh = this.record(value);
    if (!ssh) return;
    const status = this.nonEmptyString(ssh.status);
    if (
      status !== 'disabled'
      && status !== 'container_stopped'
      && status !== 'running'
      && status !== 'error'
      && status !== 'unknown'
    ) return;
    const route: ContainerSshRouteRecord = {
      containerId: container.id,
      serverId: container.serverId,
      runtimeId,
      macvlanIp: ip,
      runtimeStatus: status === 'container_stopped'
        ? ContainerStatus.Exited
        : ContainerStatus.Running,
      sshStatus: status,
      appliedInternalKeyGeneration: this.integer(ssh.appliedKeyGeneration),
      containerHostKeyFingerprint:
        this.nonEmptyString(ssh.hostKeyFingerprint),
      lastError: this.nonEmptyString(ssh.lastError),
      observedAt: new Date(),
    };
    await this.containers.upsertRoute(route, transaction);
  }

  private payload(kind: AgentTaskKind, value: unknown): Record<string, any> {
    return parseAgentTaskPayload(kind, value) as Record<string, any>;
  }

  private safeObservedRuntimeId(
    task: WorkflowTaskRecord,
    observed: unknown,
  ): string | null {
    const record = this.record(observed);
    if (!record || Array.isArray(record.runtimeIds)) return null;
    const rollback = this.record(record.safetyRollback);
    if (rollback && Array.isArray(rollback.runtimeIds)) return null;
    const barrier = rollback ?? record;
    if (
      record.applied === false
      || barrier.applied === false
      || barrier.present === false
      || barrier.running !== false
      || barrier.containerId !== task.resourceId
      || barrier.serverId !== task.serverId
    ) return null;
    return this.nonEmptyString(barrier.runtimeId);
  }

  private observedPower(
    task: WorkflowTaskRecord,
    observed: unknown,
  ): ContainerPowerIntent | null {
    const record = this.record(observed);
    if (!record || Array.isArray(record.runtimeIds)) return null;
    const rollback = this.record(record.safetyRollback);
    if (rollback && Array.isArray(rollback.runtimeIds)) return null;
    const barrier = rollback ?? record;
    const containerId = this.nonEmptyString(barrier.containerId)
      ?? this.nonEmptyString(record.containerId);
    if (containerId !== task.resourceId) return null;
    if (barrier.present === false || barrier.running === false) {
      return ContainerPowerIntent.Stopped;
    }
    return barrier.running === true ? ContainerPowerIntent.Running : null;
  }

  private isPreApplicationSshRuntimeStop(
    task: WorkflowTaskRecord,
    error: unknown,
    observed: unknown,
  ): boolean {
    if (this.nonEmptyString(this.record(error)?.code)
      !== 'container_ssh_runtime_stopped') return false;
    const record = this.record(observed);
    const rollback = this.record(record?.safetyRollback);
    const payload = this.record(task.payload);
    const runtimeId = this.nonEmptyString(payload?.runtimeId);
    return Boolean(
      record
      && rollback
      && runtimeId
      && record.applied === false
      && record.running === false
      && rollback.running === false
      && !Array.isArray(record.runtimeIds)
      && !Array.isArray(rollback.runtimeIds)
      && payload?.containerId === task.resourceId
      && record.containerId === task.resourceId
      && record.serverId === task.serverId
      && record.runtimeId === runtimeId
      && rollback.containerId === task.resourceId
      && rollback.serverId === task.serverId
      && rollback.runtimeId === runtimeId
    );
  }

  private runtimeCleanupIdentity(payload: ContainerRuntimeAbsentTaskPayload) {
    return {
      runtimeId: payload.runtimeId,
      containerId: payload.containerId,
      serverId: payload.serverId,
      specGeneration: payload.specGeneration,
      runtimeSpecHash: payload.runtimeSpecHash,
      quotaPaths: payload.quotaPaths,
    };
  }

  private record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      && value.every((item): item is string => typeof item === 'string')
      ? [...value]
      : [];
  }

  private integer(value: unknown): number | null {
    return Number.isInteger(value) ? value as number : null;
  }

  private errorMessage(error: unknown): string {
    return this.nonEmptyString(this.record(error)?.message)
      ?? (error instanceof Error ? error.message : String(error));
  }
}
