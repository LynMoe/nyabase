import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentCommandKind,
  AgentCommandStatus,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  HookKind,
  HookStatus,
  OperationKind,
  OperationStatus,
  type ContainerSshServerState,
  type OperationProgressPayload,
} from '@nyabase/common';
import { AgentCommandOutboxEntity } from '../entities/agent-command-outbox.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerRuntimeObservationEntity } from '../entities/container-runtime-observation.entity.js';
import { RuntimeContainerEntity } from '../entities/runtime-container.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { OperationStepEntity } from '../entities/operation-step.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ReconcileTaskEntity } from '../entities/reconcile-task.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { errorMessage } from './operation-retry-policy.js';

export interface DispatchAgentCommandPersistContext {
  operationId: string;
  commandId: string;
  idempotencyKey: string;
}

export interface CreateAgentCommandInput {
  operationKind: OperationKind;
  commandKind: string;
  serverId: string;
  resourceType: string;
  resourceId: string;
  requestedBy: string | null;
  payload: unknown;
  request?: unknown;
  desiredGeneration?: number | null;
  operationStepId?: string | null;
  resourceKey?: string;
  beforePersist?: (
    manager: EntityManager,
    context: DispatchAgentCommandPersistContext,
  ) => Promise<void>;
}

export interface CreatedOperationRef {
  operationId: string;
  commandId: string;
  status: OperationStatus;
}

export interface EnqueueReconcileTaskInput {
  hook: HookKind;
  resourceType: string;
  resourceId: string;
  serverId: string;
  desiredGeneration?: number | null;
  priority?: number;
  result?: unknown;
  operationId?: string | null;
  nextAttemptAt?: Date;
}

@Injectable()
export class OperationOrchestratorService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(OperationEntity)
    private operationsRepo: Repository<OperationEntity>,
    @InjectRepository(OperationStepEntity)
    private stepsRepo: Repository<OperationStepEntity>,
    @InjectRepository(AgentCommandOutboxEntity)
    private outboxRepo: Repository<AgentCommandOutboxEntity>,
    @InjectRepository(ReconcileTaskEntity)
    private reconcileTasksRepo: Repository<ReconcileTaskEntity>,
  ) {}

  async createAgentCommand(input: CreateAgentCommandInput): Promise<CreatedOperationRef> {
    const now = new Date();
    const operationId = uuidv4();
    const commandId = uuidv4();
    const idempotencyKey = [
      input.operationKind,
      input.serverId,
      input.resourceType,
      input.resourceId,
      operationId,
    ].join(':');
    const context: DispatchAgentCommandPersistContext = {
      operationId,
      commandId,
      idempotencyKey,
    };

    await runSerializedTransaction(this.dataSource, async (manager) => {
      if (input.beforePersist) {
        await input.beforePersist(manager, context);
      }

      await manager.save(
        OperationEntity,
        manager.create(OperationEntity, {
          id: operationId,
          idempotencyKey,
          kind: input.operationKind,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          serverId: input.serverId,
          requestedBy: input.requestedBy,
          status: OperationStatus.Queued,
          request: input.request ?? {
            commandKind: input.commandKind,
            payload: input.payload,
          },
          result: null,
          lastError: null,
          attempts: 0,
          startedAt: null,
          completedAt: null,
        }),
      );

      await manager.save(
        AgentCommandOutboxEntity,
        manager.create(AgentCommandOutboxEntity, {
          id: commandId,
          operationId,
          operationStepId: input.operationStepId ?? null,
          serverId: input.serverId,
          resourceKey: input.resourceKey ?? `${input.resourceType}:${input.serverId}:${input.resourceId}`,
          commandKind: input.commandKind,
          idempotencyKey,
          desiredGeneration: input.desiredGeneration ?? null,
          payload: input.payload,
          status: AgentCommandStatus.Pending,
          attempts: 0,
          lastError: null,
          nextAttemptAt: now,
          leaseHolderId: null,
          leaseExpiresAt: null,
          sentAt: null,
          completedAt: null,
        }),
      );
    });

    return {
      operationId,
      commandId,
      status: OperationStatus.Queued,
    };
  }

  async enqueueReconcileTask(input: EnqueueReconcileTaskInput): Promise<ReconcileTaskEntity> {
    return this.reconcileTasksRepo.save(
      this.reconcileTasksRepo.create({
        id: uuidv4(),
        operationId: input.operationId ?? null,
        hook: input.hook,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        serverId: input.serverId,
        desiredGeneration: input.desiredGeneration ?? null,
        status: HookStatus.Pending,
        priority: input.priority ?? 0,
        nextAttemptAt: input.nextAttemptAt ?? new Date(),
        attempts: 0,
        lastError: null,
        result: input.result ?? null,
      }),
    );
  }

  async markCommandSent(command: AgentCommandOutboxEntity): Promise<void> {
    const now = new Date();
    await runSerializedTransaction(this.dataSource, async (manager) => {
      await manager.update(AgentCommandOutboxEntity, command.id, {
        status: AgentCommandStatus.Sent,
        attempts: () => 'attempts + 1',
        sentAt: command.sentAt ?? now,
      });
      await manager.update(OperationEntity, command.operationId, {
        status: OperationStatus.WaitingAgent,
        startedAt: now,
        attempts: () => 'attempts + 1',
      });
      if (command.operationStepId) {
        await manager.update(OperationStepEntity, command.operationStepId, {
          status: HookStatus.WaitingAgent,
          startedAt: now,
          attempts: () => 'attempts + 1',
        });
      }
    });
  }

  async markCommandSucceeded(
    command: AgentCommandOutboxEntity,
    result: unknown,
  ): Promise<void> {
    const completedAt = new Date();
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const currentCommand = await manager.findOneByOrFail(AgentCommandOutboxEntity, {
        id: command.id,
      });
      if ([
        AgentCommandStatus.Succeeded,
        AgentCommandStatus.Failed,
        AgentCommandStatus.Cancelled,
      ].includes(currentCommand.status)) {
        return;
      }
      const operation = await manager.findOneByOrFail(OperationEntity, {
        id: currentCommand.operationId,
      });
      await this.applyDomainSuccess(manager, operation, currentCommand, result);

      await manager.update(AgentCommandOutboxEntity, currentCommand.id, {
        status: AgentCommandStatus.Succeeded,
        lastError: null,
        leaseHolderId: null,
        leaseExpiresAt: null,
        completedAt,
      });
      const storedResult = result === undefined ? null : result;
      operation.status = OperationStatus.Succeeded;
      operation.result = storedResult;
      operation.lastError = null;
      operation.completedAt = completedAt;
      await manager.save(OperationEntity, operation);
      if (currentCommand.operationStepId) {
        const step = await manager.findOneBy(OperationStepEntity, {
          id: currentCommand.operationStepId,
        });
        if (step) {
          step.status = HookStatus.Succeeded;
          step.result = storedResult;
          step.lastError = null;
          step.completedAt = completedAt;
          await manager.save(OperationStepEntity, step);
        }
      }
      const reconcileTasks = await manager.findBy(ReconcileTaskEntity, {
        operationId: operation.id,
      });
      for (const task of reconcileTasks) {
        task.status = HookStatus.Succeeded;
        task.result = storedResult;
        task.lastError = null;
      }
      if (reconcileTasks.length > 0) {
        await manager.save(ReconcileTaskEntity, reconcileTasks);
      }
    });
  }

  async markCommandFailed(
    command: AgentCommandOutboxEntity,
    error: unknown,
  ): Promise<void> {
    const completedAt = new Date();
    const lastError = errorMessage(error);
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const currentCommand = await manager.findOneByOrFail(AgentCommandOutboxEntity, {
        id: command.id,
      });
      if ([
        AgentCommandStatus.Succeeded,
        AgentCommandStatus.Failed,
        AgentCommandStatus.Cancelled,
      ].includes(currentCommand.status)) {
        return;
      }
      const operation = await manager.findOneByOrFail(OperationEntity, {
        id: currentCommand.operationId,
      });
      await this.applyDomainFailure(manager, operation, currentCommand, error);

      await manager.update(AgentCommandOutboxEntity, currentCommand.id, {
        status: AgentCommandStatus.Failed,
        lastError,
        leaseHolderId: null,
        leaseExpiresAt: null,
        completedAt,
      });
      await manager.update(OperationEntity, operation.id, {
        status: OperationStatus.Failed,
        lastError,
        completedAt,
      });
      if (currentCommand.operationStepId) {
        await manager.update(OperationStepEntity, currentCommand.operationStepId, {
          status: HookStatus.Failed,
          lastError,
          completedAt,
        });
      }
      await manager.update(ReconcileTaskEntity, { operationId: operation.id }, {
        status: HookStatus.Failed,
        lastError,
      });
    });
  }

  async recordProgress(progress: OperationProgressPayload): Promise<void> {
    const command = await this.outboxRepo.findOne({ where: { id: progress.commandId } });
    if (!command) return;
    if ([
      AgentCommandStatus.Succeeded,
      AgentCommandStatus.Failed,
      AgentCommandStatus.Cancelled,
    ].includes(command.status)) {
      return;
    }

    if (progress.status === 'succeeded') {
      const operation = await this.operationsRepo.findOneBy({ id: command.operationId });
      if (operation && this.shouldWaitForCommandAck(operation, progress.data)) {
        await this.recordNonTerminalProgress(command, {
          commandStatus: AgentCommandStatus.Running,
          operationStatus: OperationStatus.Running,
          hookStatus: HookStatus.Running,
          lastError: progress.error ?? null,
        });
        return;
      }
      await this.markCommandSucceeded(command, progress.data);
      return;
    }
    if (progress.status === 'not_applicable') {
      await this.markCommandSucceeded(command, {
        status: 'not_applicable',
        step: progress.step,
        data: progress.data ?? null,
      });
      return;
    }
    if (progress.status === 'failed') {
      await this.markCommandFailed(command, progress.error ?? 'Agent command failed');
      return;
    }

    const operationStatus = progress.status === 'waiting_observed'
      ? OperationStatus.WaitingObserved
      : OperationStatus.Running;
    const hookStatus = progress.status === 'waiting_observed'
      ? HookStatus.WaitingObserved
      : HookStatus.Running;
    const commandStatus = progress.status === 'accepted'
      ? AgentCommandStatus.Sent
      : AgentCommandStatus.Running;

    await this.recordNonTerminalProgress(command, {
      commandStatus,
      operationStatus,
      hookStatus,
      lastError: progress.error ?? null,
    });
  }

  private async recordNonTerminalProgress(
    command: AgentCommandOutboxEntity,
    update: {
      commandStatus: AgentCommandStatus;
      operationStatus: OperationStatus;
      hookStatus: HookStatus;
      lastError: string | null;
    },
  ): Promise<void> {
    await runSerializedTransaction(this.dataSource, async (manager) => {
      await manager.update(AgentCommandOutboxEntity, command.id, {
        status: update.commandStatus,
        lastError: update.lastError,
      });
      await manager.update(OperationEntity, command.operationId, {
        status: update.operationStatus,
        lastError: update.lastError,
      });
      if (command.operationStepId) {
        await manager.update(OperationStepEntity, command.operationStepId, {
          status: update.hookStatus,
          lastError: update.lastError,
        });
      }
    });
  }

  private shouldWaitForCommandAck(
    operation: OperationEntity,
    progressData: unknown,
  ): boolean {
    switch (operation.kind) {
      case OperationKind.ContainerCreate:
        return !this.resultString(progressData, 'runtimeId');
      default:
        return false;
    }
  }


  async applyOperationTerminalRepair(
    manager: EntityManager,
    operation: OperationEntity,
    command: AgentCommandOutboxEntity,
  ): Promise<void> {
    await this.applyDomainSuccess(manager, operation, command, operation.result);
  }

  private async applyDomainSuccess(
    manager: EntityManager,
    operation: OperationEntity,
    command: AgentCommandOutboxEntity,
    result: unknown,
  ): Promise<void> {
    switch (operation.kind) {
      case OperationKind.ContainerCreate:
        await this.applyContainerCreateSuccess(manager, operation, result);
        break;
      case OperationKind.ContainerStart:
        await this.applyContainerPowerSuccess(manager, operation, command, ContainerPowerIntent.Running);
        break;
      case OperationKind.ContainerStop:
        await this.applyContainerPowerSuccess(manager, operation, command, ContainerPowerIntent.Stopped);
        break;
      case OperationKind.ContainerRestart:
        await this.applyContainerPowerSuccess(manager, operation, command, ContainerPowerIntent.Running);
        break;
      case OperationKind.ContainerDelete:
        await this.applyContainerDeleteSuccess(manager, operation);
        break;
      case OperationKind.ContainerUpdateMounts:
        await this.applyContainerUpdateSuccess(manager, operation, command);
        break;
      case OperationKind.ContainerEnableSsh:
      case OperationKind.ContainerReconcileSsh:
        await this.applyContainerUpdateSuccess(manager, operation, command);
        await this.applyContainerSshObservationSuccess(manager, operation, command, result);
        break;
      case OperationKind.DataDirDelete:
        await manager.delete(DataDirectoryEntity, operation.resourceId);
        break;
      default:
        if (command.commandKind === AgentCommandKind.DiskRemove) {
          await this.applyDataDiskRemoveSuccess(manager, operation);
          break;
        }
        if (command.commandKind === AgentCommandKind.RemoteFsRemove) {
          await this.applyRemoteFsRemoveSuccess(manager, operation);
          break;
        }
        await this.applyHookSuccess(manager, operation, command, result);
        break;
    }
  }

  private async applyDomainFailure(
    manager: EntityManager,
    operation: OperationEntity,
    _command: AgentCommandOutboxEntity,
    _error: unknown,
  ): Promise<void> {
    switch (operation.kind) {
      case OperationKind.ContainerCreate:
        await this.applyContainerFailure(manager, operation, ContainerPhase.Failed, _error);
        await manager.delete(GpuAllocationEntity, { containerId: operation.resourceId });
        break;
      case OperationKind.ContainerDelete:
        await this.applyContainerFailure(manager, operation, ContainerPhase.Active, _error);
        await manager.update(ContainerEntity, operation.resourceId, { deletedAt: null });
        break;
      case OperationKind.ContainerStart:
      case OperationKind.ContainerStop:
      case OperationKind.ContainerRestart:
      case OperationKind.ContainerUpdateMounts:
      case OperationKind.ContainerEnableSsh:
      case OperationKind.ContainerReconcileSsh:
        await this.applyContainerFailure(manager, operation, ContainerPhase.Active, _error);
        break;
      case OperationKind.DataDirCreate:
        await manager.delete(DataDirectoryEntity, operation.resourceId);
        break;
      case OperationKind.DataDirDelete:
        await manager.update(DataDirectoryEntity, operation.resourceId, {
          desiredState: 'active',
        });
        break;
      default:
        if (_command.commandKind === AgentCommandKind.DiskRemove) {
          await manager.update(DataDiskEntity, operation.resourceId, {
            desiredState: 'active',
          });
        }
        if (_command.commandKind === AgentCommandKind.RemoteFsRemove) {
          await this.restoreRemoteFsRemoveFailure(manager, operation);
        }
        break;
    }
  }

  private async applyContainerCreateSuccess(
    manager: EntityManager,
    operation: OperationEntity,
    result: unknown,
  ): Promise<void> {
    const runtimeId = this.resultString(result, 'runtimeId');
    const ip = this.resultString(result, 'ip');
    if (runtimeId) {
      await manager.upsert(RuntimeContainerEntity, manager.create(RuntimeContainerEntity, {
        id: `${operation.serverId}:${runtimeId}`,
        serverId: operation.serverId,
        runtimeId,
        containerId: operation.resourceId,
        ownerId: operation.requestedBy,
        ownerNumericId: null,
        status: ContainerStatus.Running,
        specGenerationSeen: null,
        ip: ip ?? null,
        labelsJson: { 'nyabase.containerId': operation.resourceId },
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        stale: false,
      }), ['serverId', 'runtimeId']);
    }
    await manager.update(ContainerLifecycleEntity, operation.resourceId, {
      phase: ContainerPhase.Active,
      boundRuntimeId: runtimeId ?? null,
      activeOperationId: null,
      lastTransitionAt: new Date(),
      failureReason: null,
      failureCode: null,
    });
  }

  private async applyContainerPowerSuccess(
    manager: EntityManager,
    operation: OperationEntity,
    command: AgentCommandOutboxEntity,
    intent: ContainerPowerIntent,
  ): Promise<void> {
    const now = new Date();
    await manager.update(ContainerDesiredSpecEntity, { containerId: operation.resourceId }, {
      powerIntent: intent,
      updatedAt: now,
    });
    await manager.update(ContainerLifecycleEntity, operation.resourceId, {
      phase: ContainerPhase.Active,
      activeOperationId: null,
      lastTransitionAt: now,
      failureReason: null,
      failureCode: null,
    });
    await this.refreshRuntimeAfterSuccessfulCommand(manager, operation, command, {
      status: intent === ContainerPowerIntent.Running
        ? ContainerStatus.Running
        : ContainerStatus.Exited,
      observedAt: now,
    });
  }

  private async applyContainerUpdateSuccess(
    manager: EntityManager,
    operation: OperationEntity,
    command: AgentCommandOutboxEntity,
  ): Promise<void> {
    const now = new Date();
    await manager.update(ContainerLifecycleEntity, operation.resourceId, {
      phase: ContainerPhase.Active,
      activeOperationId: null,
      lastTransitionAt: now,
      failureReason: null,
      failureCode: null,
    });
    await this.refreshRuntimeAfterSuccessfulCommand(manager, operation, command, {
      observedAt: now,
    });
  }

  private async refreshRuntimeAfterSuccessfulCommand(
    manager: EntityManager,
    operation: OperationEntity,
    command: AgentCommandOutboxEntity,
    update: { status?: ContainerStatus; observedAt: Date },
  ): Promise<void> {
    const payload = this.recordValue(command.payload);
    const runtimeId = this.nonEmptyString(payload?.runtimeId);
    const criteria = runtimeId
      ? { serverId: operation.serverId, runtimeId }
      : { containerId: operation.resourceId };

    await manager.update(RuntimeContainerEntity, criteria, {
      ...(update.status ? { status: update.status } : {}),
      stale: false,
      lastSeenAt: update.observedAt,
    });
  }

  private async applyContainerSshObservationSuccess(
    manager: EntityManager,
    operation: OperationEntity,
    command: AgentCommandOutboxEntity,
    result: unknown,
  ): Promise<void> {
    const sshServer = this.sshServerState(result);
    if (!sshServer) return;

    const now = new Date();
    const payload = this.recordValue(command.payload);
    const runtimeId = this.nonEmptyString(payload?.runtimeId);
    if (!runtimeId) return;

    const runtime = await manager.findOne(RuntimeContainerEntity, {
      where: { serverId: operation.serverId, runtimeId },
      order: { lastSeenAt: 'DESC' },
    });
    const existing = await manager.findOne(ContainerRuntimeObservationEntity, {
      where: {
        serverId: operation.serverId,
        dockerId: runtimeId,
        stale: false,
      },
      order: { lastSeenAt: 'DESC' },
    });

    await manager.upsert(ContainerRuntimeObservationEntity, manager.create(ContainerRuntimeObservationEntity, {
      id: existing?.id ?? `${operation.serverId}:${runtimeId}:latest`,
      serverId: operation.serverId,
      containerId: operation.resourceId,
      dockerId: runtimeId,
      reportSeq: existing?.reportSeq ?? 0,
      status: runtime?.status ?? existing?.status ?? ContainerStatus.Running,
      stats: existing?.stats ?? null,
      sshServer,
      labels: existing?.labels ?? runtime?.labelsJson ?? {},
      labelsValid: existing?.labelsValid ?? true,
      specGenerationSeen: existing?.specGenerationSeen ?? runtime?.specGenerationSeen ?? null,
      firstSeenAt: existing?.firstSeenAt ?? runtime?.firstSeenAt ?? now,
      lastSeenAt: now,
      missingSince: null,
      stale: false,
    }), ['id']);
  }

  private sshServerState(value: unknown): ContainerSshServerState | null {
    const record = this.recordValue(value);
    if (!record) return null;
    if (record.enabled !== true) return null;
    if (record.user !== 'root') return null;
    if (record.port !== 22) return null;
    const status = this.nonEmptyString(record.status);
    if (!status || !['disabled', 'container_stopped', 'running', 'error', 'unknown'].includes(status)) return null;
    return {
      enabled: true,
      status: status as ContainerSshServerState['status'],
      user: 'root',
      port: 22,
      ...(typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0 ? { pid: record.pid } : {}),
      ...(typeof record.keyHash === 'string' ? { keyHash: record.keyHash } : {}),
      ...(typeof record.lastReconciledAt === 'number' ? { lastReconciledAt: record.lastReconciledAt } : {}),
      ...(typeof record.lastError === 'string' ? { lastError: record.lastError } : {}),
    };
  }

  private async applyContainerFailure(
    manager: EntityManager,
    operation: OperationEntity,
    phase: ContainerPhase,
    error: unknown,
  ): Promise<void> {
    await manager.update(ContainerLifecycleEntity, operation.resourceId, {
      phase,
      activeOperationId: null,
      lastTransitionAt: new Date(),
      failureReason: errorMessage(error),
      failureCode: 'operation_failed',
    });
  }

  private async applyContainerDeleteSuccess(
    manager: EntityManager,
    operation: OperationEntity,
  ): Promise<void> {
    await manager.update(ContainerLifecycleEntity, operation.resourceId, {
      phase: ContainerPhase.Deleted,
      activeOperationId: null,
      lastTransitionAt: new Date(),
      failureReason: null,
      failureCode: null,
    });
    await manager.update(ContainerEntity, operation.resourceId, {
      deletedAt: new Date(),
    });
    await manager.update(ContainerDesiredSpecEntity, { containerId: operation.resourceId }, {
      powerIntent: ContainerPowerIntent.Stopped,
      updatedAt: new Date(),
    });
    await manager.update(RuntimeContainerEntity, { containerId: operation.resourceId }, {
      stale: true,
      lastSeenAt: new Date(),
    });
    await manager.delete(ContainerMountEntity, { containerId: operation.resourceId });
    await manager.delete(GpuAllocationEntity, { containerId: operation.resourceId });
  }

  private async applyDataDiskRemoveSuccess(
    manager: EntityManager,
    operation: OperationEntity,
  ): Promise<void> {
    await manager.delete(DataDiskEntity, operation.resourceId);
    await manager.delete(MountSourceGrantEntity, {
      sourceKind: 'local',
      sourceId: operation.resourceId,
    });
  }

  private async applyRemoteFsRemoveSuccess(
    manager: EntityManager,
    operation: OperationEntity,
  ): Promise<void> {
    const request = this.requestRecord(operation);
    const scope = request.scope === 'assignment' ? 'assignment' : 'mount';
    if (scope === 'assignment') {
      await manager.delete(RemoteFsServerAssignmentEntity, {
        remoteFsMountId: operation.resourceId,
        serverId: operation.serverId,
      });
      return;
    }

    await manager.delete(RemoteFsServerAssignmentEntity, {
      remoteFsMountId: operation.resourceId,
    });
    await manager.delete(MountSourceGrantEntity, {
      sourceKind: 'remote',
      sourceId: operation.resourceId,
    });
    await manager.delete(RemoteFsMountEntity, operation.resourceId);
  }

  private async restoreRemoteFsRemoveFailure(
    manager: EntityManager,
    operation: OperationEntity,
  ): Promise<void> {
    const request = this.requestRecord(operation);
    const scope = request.scope === 'assignment' ? 'assignment' : 'mount';
    if (scope === 'assignment') {
      await manager.update(RemoteFsServerAssignmentEntity, {
        remoteFsMountId: operation.resourceId,
        serverId: operation.serverId,
      }, {
        desiredState: 'active',
      });
      return;
    }
    await manager.update(RemoteFsMountEntity, operation.resourceId, {
      desiredState: 'active',
    });
    await manager.update(RemoteFsServerAssignmentEntity, {
      remoteFsMountId: operation.resourceId,
    }, {
      desiredState: 'active',
    });
  }

  private async applyHookSuccess(
    _manager: EntityManager,
    _operation: OperationEntity,
    _command: AgentCommandOutboxEntity,
    _result: unknown,
  ): Promise<void> {
    return;
  }

  private async saveTask(
    manager: EntityManager,
    input: EnqueueReconcileTaskInput,
  ): Promise<void> {
    await manager.save(
      ReconcileTaskEntity,
      manager.create(ReconcileTaskEntity, {
        id: uuidv4(),
        operationId: input.operationId ?? null,
        hook: input.hook,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        serverId: input.serverId,
        desiredGeneration: input.desiredGeneration ?? null,
        status: HookStatus.Pending,
        priority: input.priority ?? 0,
        nextAttemptAt: input.nextAttemptAt ?? new Date(),
        attempts: 0,
        lastError: null,
        result: input.result ?? null,
      }),
    );
  }

  private async upsertQuotaDesired(
    manager: EntityManager,
    input: {
      serverId: string;
      userId: string;
      numericUserId: number | null;
      limitBytes: number;
      operationId: string;
    },
  ): Promise<void> {
    if (!input.userId) return;
    const existing = await manager.findOne(QuotaDesiredEntity, {
      where: { serverId: input.serverId, userId: input.userId },
    });
    await manager.save(
      QuotaDesiredEntity,
      manager.create(QuotaDesiredEntity, {
        id: existing?.id ?? uuidv4(),
        serverId: input.serverId,
        userId: input.userId,
        numericUserId: input.numericUserId,
        limitBytes: input.limitBytes,
        source: 'grant',
        generation: (existing?.generation ?? 0) + 1,
        lastOperationId: input.operationId,
      }),
    );
  }

  private requestRecord(operation: OperationEntity): Record<string, unknown> {
    return this.recordValue(operation.request) ?? {};
  }

  private recordValue(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private resultString(result: unknown, key: string): string | null {
    const record = this.recordValue(result);
    const value = record?.[key];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private numberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
}
