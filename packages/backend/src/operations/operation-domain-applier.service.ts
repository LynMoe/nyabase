import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  AgentCommandKind,
  ContainerPhase,
  ContainerPowerIntent,
  OperationKind,
} from '@nyabase/common';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';

@Injectable()
export class OperationDomainApplierService {
  async applySuccess(
    manager: EntityManager,
    operation: OperationEntity,
    result: unknown,
  ): Promise<void> {
    switch (operation.kind) {
      case OperationKind.ContainerCreate:
        await this.applyContainerCreateSuccess(manager, operation, result);
        return;
      case OperationKind.ContainerStart:
        await this.applyContainerPowerSuccess(manager, operation, ContainerPowerIntent.Running);
        return;
      case OperationKind.ContainerStop:
        await this.applyContainerPowerSuccess(manager, operation, ContainerPowerIntent.Stopped);
        return;
      case OperationKind.ContainerRestart:
        await this.applyContainerPowerSuccess(manager, operation, ContainerPowerIntent.Running);
        return;
      case OperationKind.ContainerDelete:
        await this.applyContainerDeleteSuccess(manager, operation);
        return;
      case OperationKind.ContainerUpdateMounts:
      case OperationKind.ContainerReconcileSsh:
        await this.applyContainerUpdateSuccess(manager, operation);
        return;
      case OperationKind.DataDirDelete:
        await manager.delete(DataDirectoryEntity, operation.resourceId);
        return;
      default:
        if (operation.commandKind === AgentCommandKind.DiskRemove) {
          await this.applyDataDiskRemoveSuccess(manager, operation);
          return;
        }
        if (operation.commandKind === AgentCommandKind.RemoteFsRemove) {
          await this.applyRemoteFsRemoveSuccess(manager, operation);
        }
    }
  }

  async applyFailure(
    manager: EntityManager,
    operation: OperationEntity,
    error: unknown,
  ): Promise<void> {
    switch (operation.kind) {
      case OperationKind.ContainerCreate:
        await this.applyContainerFailure(manager, operation, ContainerPhase.Failed, error);
        await manager.delete(GpuAllocationEntity, { containerId: operation.resourceId });
        await manager.delete(ContainerMountEntity, { containerId: operation.resourceId });
        await manager.delete(ContainerLifecycleEntity, { containerId: operation.resourceId });
        await manager.delete(ContainerDesiredSpecEntity, { containerId: operation.resourceId });
        await manager.delete(ContainerEntity, operation.resourceId);
        return;
      case OperationKind.ContainerDelete:
        await this.applyContainerFailure(manager, operation, ContainerPhase.Active, error);
        await manager.update(ContainerEntity, operation.resourceId, { deletedAt: null });
        return;
      case OperationKind.ContainerStart:
      case OperationKind.ContainerStop:
      case OperationKind.ContainerRestart:
      case OperationKind.ContainerUpdateMounts:
      case OperationKind.ContainerReconcileSsh:
        await this.applyContainerFailure(manager, operation, ContainerPhase.Active, error);
        return;
      case OperationKind.DataDirCreate:
        await manager.delete(DataDirectoryEntity, operation.resourceId);
        return;
      case OperationKind.DataDirDelete:
        await manager.update(DataDirectoryEntity, operation.resourceId, {
          desiredState: 'active',
        });
        return;
      default:
        if (operation.commandKind === AgentCommandKind.DiskRemove) {
          await manager.update(DataDiskEntity, operation.resourceId, {
            desiredState: 'active',
          });
        }
        if (operation.commandKind === AgentCommandKind.RemoteFsRemove) {
          await this.restoreRemoteFsRemoveFailure(manager, operation);
        }
    }
  }

  private async applyContainerCreateSuccess(
    manager: EntityManager,
    operation: OperationEntity,
    result: unknown,
  ): Promise<void> {
    const runtimeId = this.resultString(result, 'runtimeId');
    await manager.update(ContainerLifecycleEntity, operation.resourceId, {
      phase: ContainerPhase.Active,
      boundRuntimeId: runtimeId ?? null,
      activeOperationId: operation.id,
      lastTransitionAt: new Date(),
      failureReason: null,
      failureCode: null,
    });
  }

  private async applyContainerPowerSuccess(
    manager: EntityManager,
    operation: OperationEntity,
    intent: ContainerPowerIntent,
  ): Promise<void> {
    const now = new Date();
    await manager.update(ContainerDesiredSpecEntity, { containerId: operation.resourceId }, {
      powerIntent: intent,
      updatedAt: now,
    });
    await manager.update(ContainerLifecycleEntity, operation.resourceId, {
      phase: ContainerPhase.Active,
      activeOperationId: operation.id,
      lastTransitionAt: now,
      failureReason: null,
      failureCode: null,
    });
  }

  private async applyContainerUpdateSuccess(
    manager: EntityManager,
    operation: OperationEntity,
  ): Promise<void> {
    await manager.update(ContainerLifecycleEntity, operation.resourceId, {
      phase: ContainerPhase.Active,
      activeOperationId: operation.id,
      lastTransitionAt: new Date(),
      failureReason: null,
      failureCode: null,
    });
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
      failureReason: this.errorMessage(error),
      failureCode: 'operation_failed',
    });
  }

  private async applyContainerDeleteSuccess(
    manager: EntityManager,
    operation: OperationEntity,
  ): Promise<void> {
    const now = new Date();
    await manager.update(ContainerLifecycleEntity, operation.resourceId, {
      phase: ContainerPhase.Deleted,
      activeOperationId: operation.id,
      lastTransitionAt: now,
      failureReason: null,
      failureCode: null,
    });
    await manager.update(ContainerEntity, operation.resourceId, {
      deletedAt: now,
    });
    await manager.update(ContainerDesiredSpecEntity, { containerId: operation.resourceId }, {
      powerIntent: ContainerPowerIntent.Stopped,
      updatedAt: now,
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
    const request = this.recordValue(operation.requestJson) ?? {};
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
    const request = this.recordValue(operation.requestJson) ?? {};
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

  private resultString(result: unknown, key: string): string | null {
    const record = this.recordValue(result);
    const value = record?.[key];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private recordValue(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
