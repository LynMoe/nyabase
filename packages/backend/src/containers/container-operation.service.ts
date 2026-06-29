import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentCommandKind,
  ContainerPhase,
  ContainerPowerIntent,
  OperationKind,
  OperationRefResponse,
  OperationStatus,
} from '@nyabase/common';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { OperationsService } from '../operations/operations.service.js';
import { ResourceKeyService } from '../operations/resource-key.service.js';

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
    private operations: OperationsService,
    private resourceKeys: ResourceKeyService,
    @InjectRepository(OperationEntity)
    private operationsRepo: Repository<OperationEntity>,
  ) {}

  async createContainerOperation(
    manager: EntityManager,
    input: ContainerOperationRequest,
  ): Promise<OperationRefResponse> {
    const ref = await this.operations.enqueueCommandInTransaction(manager, {
      kind: input.kind,
      commandKind: input.commandKind,
      serverId: input.serverId,
      resourceType: 'container',
      resourceId: input.containerId,
      requestedBy: input.requestedBy,
      request: input.request,
      payload: input.payload,
      baseResourceKeys: [this.resourceKeys.container(input.containerId)],
      unlockReportKind: 'state',
      beforeCommit: async (operationManager, context) => {
        if (input.beforeSave) {
          await input.beforeSave(operationManager, context.operationId, context.commandId);
        }
        const now = new Date();
        await operationManager.update(ContainerLifecycleEntity, input.containerId, {
          phase: input.phase,
          activeOperationId: context.operationId,
          lastTransitionAt: now,
          failureReason: null,
          failureCode: null,
        });
        if (input.powerIntent) {
          await operationManager.update(ContainerDesiredSpecEntity, { containerId: input.containerId }, {
            powerIntent: input.powerIntent,
            updatedAt: now,
          });
        }
      },
    });
    return { ok: true, operationId: ref.operationId, status: ref.status };
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
      const commandId = uuidv4();
      const container = await manager.findOneByOrFail(ContainerEntity, { id: containerId });
      await manager.save(OperationEntity, manager.create(OperationEntity, {
        id: operationId,
        kind: OperationKind.ContainerDelete,
        resourceType: 'container',
        resourceId: containerId,
        serverId: container.serverId,
        requestedBy,
        commandId,
        commandKind: AgentCommandKind.RuntimeContainerDelete,
        resourceKeysJson: [this.resourceKeys.container(containerId)],
        unlockReportKind: null,
        status: OperationStatus.Succeeded,
        requestJson: { action: 'delete', localOnly: true },
        payloadJson: null,
        hookPlanJson: [],
        hookResultsJson: [],
        resultJson: { localOnly: true },
        lastError: null,
        startedAt: now,
        commandCompletedAt: now,
        completedAt: now,
      }));
      await manager.update(ContainerLifecycleEntity, containerId, {
        phase: ContainerPhase.Deleted,
        activeOperationId: null,
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
