import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentCommandKind,
  AgentCommandStatus,
  ContainerPhase,
  ContainerPowerIntent,
  OperationKind,
  OperationRefResponse,
  OperationStatus,
} from '@nyabase/common';
import { AgentCommandOutboxEntity } from '../entities/agent-command-outbox.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { OperationStepEntity } from '../entities/operation-step.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';

export interface ContainerOperationRequest {
  containerId: string;
  serverId: string;
  requestedBy: string | null;
  kind: OperationKind;
  commandKind: AgentCommandKind;
  request: unknown;
  payload: unknown;
  phase: ContainerPhase;
  powerIntent?: ContainerPowerIntent;
  beforeSave?: (manager: EntityManager, operationId: string, commandId: string) => Promise<void>;
}

@Injectable()
export class ContainerOperationService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(OperationEntity)
    private operationsRepo: Repository<OperationEntity>,
  ) {}

  async createContainerOperation(
    manager: EntityManager,
    input: ContainerOperationRequest,
  ): Promise<OperationRefResponse> {
    const now = new Date();
    const operationId = uuidv4();
    const stepId = uuidv4();
    const commandId = uuidv4();
    if (input.beforeSave) {
      await input.beforeSave(manager, operationId, commandId);
    }
    const operation = manager.create(OperationEntity, {
      id: operationId,
      idempotencyKey: `${input.kind}:${input.containerId}:${operationId}`,
      kind: input.kind,
      resourceType: 'container',
      resourceId: input.containerId,
      serverId: input.serverId,
      requestedBy: input.requestedBy,
      status: OperationStatus.Queued,
      request: input.request,
      result: null,
      lastError: null,
      attempts: 0,
      startedAt: null,
      completedAt: null,
    });
    const step = manager.create(OperationStepEntity, {
      id: stepId,
      operationId,
      stepKey: 'dispatch-runtime-command',
      sequence: 1,
      hook: null,
      status: 'pending' as OperationStepEntity['status'],
      desiredGeneration: null,
      commandId,
      attempts: 0,
      lastError: null,
      result: null,
      startedAt: null,
      completedAt: null,
    });
    const command = manager.create(AgentCommandOutboxEntity, {
      id: commandId,
      operationId,
      operationStepId: stepId,
      serverId: input.serverId,
      resourceKey: `container:${input.containerId}`,
      commandKind: input.commandKind,
      idempotencyKey: `${input.commandKind}:${input.containerId}:${operationId}`,
      desiredGeneration: null,
      payload: input.payload,
      status: AgentCommandStatus.Pending,
      attempts: 0,
      lastError: null,
      nextAttemptAt: now,
      leaseHolderId: null,
      leaseExpiresAt: null,
      sentAt: null,
      completedAt: null,
    });

    await manager.save(OperationEntity, operation);
    await manager.save(OperationStepEntity, step);
    await manager.save(AgentCommandOutboxEntity, command);
    await manager.update(ContainerLifecycleEntity, input.containerId, {
      phase: input.phase,
      activeOperationId: operationId,
      lastTransitionAt: now,
      failureReason: null,
      failureCode: null,
    });
    if (input.powerIntent) {
      await manager.update(ContainerDesiredSpecEntity, { containerId: input.containerId }, {
        powerIntent: input.powerIntent,
        updatedAt: now,
      });
    }
    return { ok: true, operationId, status: OperationStatus.Queued };
  }

  async enqueueExistingContainerAction(
    input: Omit<ContainerOperationRequest, 'serverId'> & { serverId?: string },
  ): Promise<OperationRefResponse> {
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const container = await manager.findOneByOrFail(ContainerEntity, { id: input.containerId });
      return this.createContainerOperation(manager, { ...input, serverId: input.serverId ?? container.serverId });
    });
  }

  async completeLocalContainerDelete(containerId: string, requestedBy: string | null): Promise<OperationRefResponse> {
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const now = new Date();
      const operationId = uuidv4();
      const container = await manager.findOneByOrFail(ContainerEntity, { id: containerId });
      await manager.save(OperationEntity, manager.create(OperationEntity, {
        id: operationId,
        idempotencyKey: `${OperationKind.ContainerDelete}:local:${containerId}:${operationId}`,
        kind: OperationKind.ContainerDelete,
        resourceType: 'container',
        resourceId: containerId,
        serverId: container.serverId,
        requestedBy,
        status: OperationStatus.Succeeded,
        request: { action: 'delete', localOnly: true },
        result: { localOnly: true },
        lastError: null,
        attempts: 0,
        startedAt: now,
        completedAt: now,
      }));
      await manager.update(ContainerLifecycleEntity, containerId, {
        phase: ContainerPhase.Deleted,
        activeOperationId: null,
        runtimeConfirmation: null,
        lastTransitionAt: now,
        failureReason: null,
        failureCode: null,
      });
      await manager.update(ContainerEntity, containerId, {
        deletedAt: now,
      });
      await manager.update(ContainerDesiredSpecEntity, { containerId }, {
        powerIntent: ContainerPowerIntent.Stopped,
        updatedAt: now,
      });
      await manager.delete(ContainerMountEntity, { containerId });
      await manager.delete(GpuAllocationEntity, { containerId });
      return { ok: true, operationId, status: OperationStatus.Succeeded };
    });
  }

  async get(operationId: string): Promise<OperationEntity | null> {
    return this.operationsRepo.findOneBy({ id: operationId });
  }
}
