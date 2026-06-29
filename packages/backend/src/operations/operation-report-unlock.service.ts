import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { OperationKind, OperationStatus } from '@nyabase/common';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { ResourceLockService } from './resource-lock.service.js';

@Injectable()
export class OperationReportUnlockService {
  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => AgentGateway))
    private agentGateway: AgentGateway,
    private resourceLocks: ResourceLockService,
    @InjectRepository(OperationEntity)
    private operationsRepo: Repository<OperationEntity>,
  ) {}

  async onStateReport(serverId: string, observedAt: number): Promise<number> {
    return this.unlockForReport(serverId, 'state', observedAt);
  }

  async onDataDirReport(serverId: string, observedAt: number): Promise<number> {
    return this.unlockForReport(serverId, 'data_dir', observedAt);
  }

  private async unlockForReport(
    serverId: string,
    reportKind: 'state' | 'data_dir',
    observedAt: number,
  ): Promise<number> {
    const operations = await this.operationsRepo.find({
      where: {
        serverId,
        status: OperationStatus.WaitingReport,
        unlockReportKind: reportKind,
      },
      order: { commandCompletedAt: 'ASC', id: 'ASC' },
    });
    const eligible = operations.filter((operation) =>
      this.isNewerReport(operation, observedAt)
      && this.reportCovers(operation),
    );
    if (eligible.length === 0) return 0;

    const now = new Date();
    return runSerializedTransaction(this.dataSource, async (manager) => {
      let unlocked = 0;
      for (const operation of eligible) {
        const current = await manager.findOneBy(OperationEntity, { id: operation.id });
        if (!current || current.status !== OperationStatus.WaitingReport) continue;
        if (!this.isNewerReport(current, observedAt) || !this.reportCovers(current)) continue;
        current.status = OperationStatus.Succeeded;
        current.completedAt = now;
        current.lastError = null;
        await manager.save(OperationEntity, current);
        await this.releaseDomainActiveOperation(manager, current);
        await this.resourceLocks.releaseOperation(current.id, manager);
        unlocked += 1;
      }
      return unlocked;
    });
  }

  private isNewerReport(operation: OperationEntity, observedAt: number): boolean {
    const completedAt = operation.commandCompletedAt?.getTime();
    return typeof completedAt === 'number' && observedAt > completedAt;
  }

  private reportCovers(operation: OperationEntity): boolean {
    const primaryKeyCovered = this.primaryResourceCovered(operation);
    return operation.resourceKeysJson.every((key) =>
      this.resourceCovered(operation, key, primaryKeyCovered),
    );
  }

  private primaryResourceCovered(operation: OperationEntity): boolean {
    if (operation.resourceType === 'container') {
      return this.resourceCovered(operation, `container:${operation.resourceId}`, false);
    }
    if (operation.resourceType === 'datadir') {
      return true;
    }
    return true;
  }

  private resourceCovered(
    operation: OperationEntity,
    resourceKey: string,
    primaryKeyCovered: boolean,
  ): boolean {
    if (resourceKey.startsWith('container:')) {
      const containerId = resourceKey.slice('container:'.length);
      if (operation.kind === OperationKind.ContainerDelete && containerId === operation.resourceId) {
        return !this.agentGateway.stateCache.getContainerByContainerId(operation.serverId, containerId);
      }
      return Boolean(this.agentGateway.stateCache.getContainerByContainerId(operation.serverId, containerId));
    }

    if (resourceKey.startsWith('datadir:')) {
      if (operation.unlockReportKind === 'state' && operation.resourceType === 'container') {
        return primaryKeyCovered;
      }
      const parsed = this.parseDataDirKey(resourceKey);
      if (!parsed) return false;
      const exists = this.agentGateway.stateCache.getDataDirs(operation.serverId).some((dir) =>
        dir.sourceKind === parsed.sourceKind
        && dir.sourceId === parsed.sourceId
        && dir.name === parsed.name,
      );
      if (operation.kind === OperationKind.DataDirDelete) return !exists;
      return exists;
    }

    if (resourceKey.startsWith('mount_source:')) {
      if (operation.unlockReportKind === 'state' && operation.resourceType === 'container') {
        return primaryKeyCovered;
      }
      const parsed = this.parseMountSourceKey(resourceKey);
      if (!parsed) return false;
      if (parsed.sourceKind === 'remote') {
        return Boolean(this.agentGateway.stateCache.getRemoteFsMountStatus(operation.serverId, parsed.sourceId));
      }
      return this.agentGateway.stateCache.get(operation.serverId)?.disks.some((disk) => disk.diskId === parsed.sourceId) === true;
    }

    if (resourceKey.startsWith('remote_fs_assignment:')) {
      const [, serverId, remoteFsMountId] = resourceKey.split(':');
      if (serverId !== operation.serverId) return false;
      if (operation.commandKind === 'remote_fs.remove') {
        return !this.agentGateway.stateCache.getRemoteFsMountStatus(operation.serverId, remoteFsMountId);
      }
      return Boolean(this.agentGateway.stateCache.getRemoteFsMountStatus(operation.serverId, remoteFsMountId));
    }

    if (resourceKey.startsWith('disk:')) {
      const [, serverId, diskId] = resourceKey.split(':');
      if (serverId !== operation.serverId) return false;
      if (operation.commandKind === 'disk.remove') {
        return !this.agentGateway.stateCache.get(operation.serverId)?.disks.some((disk) => disk.diskId === diskId);
      }
      return this.agentGateway.stateCache.get(operation.serverId)?.disks.some((disk) => disk.diskId === diskId) === true;
    }

    if (resourceKey.startsWith('quota:')) {
      const [, serverId, userId] = resourceKey.split(':');
      return serverId === operation.serverId
        && this.agentGateway.stateCache.get(operation.serverId)?.xfsProjects.some((project) => project.userId === userId) === true;
    }

    if (resourceKey.startsWith('image:')) {
      const [, serverId, imageId] = resourceKey.split(':');
      const request = operation.requestJson && typeof operation.requestJson === 'object' && !Array.isArray(operation.requestJson)
        ? operation.requestJson as Record<string, unknown>
        : {};
      const payload = operation.payloadJson && typeof operation.payloadJson === 'object' && !Array.isArray(operation.payloadJson)
        ? operation.payloadJson as Record<string, unknown>
        : {};
      const dockerRef = typeof payload.dockerRef === 'string'
        ? payload.dockerRef
        : typeof request.dockerRef === 'string'
        ? request.dockerRef
        : null;
      return serverId === operation.serverId
        && imageId === operation.resourceId
        && (!dockerRef || this.agentGateway.stateCache.hasImage(operation.serverId, dockerRef));
    }

    return true;
  }

  private async releaseDomainActiveOperation(
    manager: import('typeorm').EntityManager,
    operation: OperationEntity,
  ): Promise<void> {
    if (operation.resourceType !== 'container') return;
    await manager.update(ContainerLifecycleEntity, {
      containerId: operation.resourceId,
      activeOperationId: operation.id,
    }, {
      activeOperationId: null,
      lastTransitionAt: new Date(),
    });
  }

  private parseDataDirKey(resourceKey: string): {
    serverId: string;
    sourceKind: 'local' | 'remote';
    sourceId: string;
    userId: string;
    name: string;
  } | null {
    const parts = resourceKey.split(':');
    if (parts.length !== 6) return null;
    const [, serverId, sourceKind, sourceId, userId, name] = parts;
    if (sourceKind !== 'local' && sourceKind !== 'remote') return null;
    return { serverId, sourceKind, sourceId, userId, name };
  }

  private parseMountSourceKey(resourceKey: string): {
    serverId: string;
    sourceKind: 'local' | 'remote';
    sourceId: string;
  } | null {
    const parts = resourceKey.split(':');
    if (parts.length !== 4) return null;
    const [, serverId, sourceKind, sourceId] = parts;
    if (sourceKind !== 'local' && sourceKind !== 'remote') return null;
    return { serverId, sourceKind, sourceId };
  }
}
