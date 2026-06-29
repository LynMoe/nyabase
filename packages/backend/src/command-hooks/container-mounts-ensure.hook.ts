import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AgentCommandKind,
  CommandHookName,
  ContainerStatus,
  OperationKind,
  type ContainerMountSpec,
} from '@nyabase/common';
import { Repository } from 'typeorm';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { ResourceKeyService } from '../operations/resource-key.service.js';
import type { CommandHook, CommandHookContext } from './command-hook.types.js';
import {
  desiredMounts,
  expectedMountSpecs,
  removedMountPaths,
  runtimeIdFromResult,
  runtimeIdFromSnapshot,
} from './container-hook-utils.js';

const MOUNT_OPERATION_KINDS = new Set<OperationKind>([
  OperationKind.ContainerCreate,
  OperationKind.ContainerStart,
  OperationKind.ContainerRestart,
  OperationKind.ContainerUpdateMounts,
]);

@Injectable()
export class ContainerMountsEnsureHook implements CommandHook {
  readonly name = CommandHookName.ContainerMountsEnsure;

  constructor(
    @InjectRepository(ContainerDesiredSpecEntity)
    private desiredRepo: Repository<ContainerDesiredSpecEntity>,
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
    @InjectRepository(DataDirectoryEntity)
    private dataDirsRepo: Repository<DataDirectoryEntity>,
    @InjectRepository(DataDiskEntity)
    private dataDisksRepo: Repository<DataDiskEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private remoteFsAssignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    private resourceKeyService: ResourceKeyService,
    private agentGateway: AgentGateway,
  ) {}

  async appliesTo(context: CommandHookContext): Promise<boolean> {
    if (context.resourceType !== 'container') return false;
    if (!MOUNT_OPERATION_KINDS.has(context.operationKind)) return false;
    const mounts = await this.mountsFromContext(context);
    if (mounts.length === 0) return false;
    if (context.operationKind === OperationKind.ContainerCreate) return true;
    if (context.operationKind === OperationKind.ContainerStart || context.operationKind === OperationKind.ContainerRestart) return true;
    const runtime = this.agentGateway.stateCache.getContainerByContainerId(context.serverId, context.resourceId);
    return runtime?.status === ContainerStatus.Running;
  }

  async resourceKeys(context: CommandHookContext): Promise<string[]> {
    const [mounts, ownerId] = await Promise.all([
      this.mountsFromContext(context),
      this.ownerId(context),
    ]);
    const keys = [this.resourceKeyService.container(context.resourceId)];
    for (const mount of mounts) {
      keys.push(this.resourceKeyService.dataDir({
        serverId: context.serverId,
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
        userId: ownerId,
        name: mount.dirName,
      }));
      keys.push(this.resourceKeyService.mountSource({
        serverId: context.serverId,
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
      }));
    }
    return keys;
  }

  async buildCommand(context: CommandHookContext) {
    const runtimeId = runtimeIdFromResult(context.mainResult)
      ?? this.runtimeIdFromPayload(context.payload)
      ?? runtimeIdFromSnapshot(this.agentGateway.stateCache.getContainerByContainerId(context.serverId, context.resourceId));
    if (!runtimeId) return null;

    const expected = expectedMountSpecs(context.payload) ?? await this.toAgentMountSpecs(context);
    if (expected.length === 0) return null;
    return {
      commandKind: AgentCommandKind.RuntimeContainerMountsApply,
      payload: {
        runtimeId,
        expected,
        toRemove: removedMountPaths(context.payload) ?? [],
      },
    };
  }

  async mergeResult(_context: CommandHookContext, _result: unknown): Promise<void> {
    return;
  }

  private async ownerId(context: CommandHookContext): Promise<string> {
    const request = context.request && typeof context.request === 'object' && !Array.isArray(context.request)
      ? context.request as Record<string, unknown>
      : {};
    const payload = context.payload && typeof context.payload === 'object' && !Array.isArray(context.payload)
      ? context.payload as Record<string, unknown>
      : {};
    const fromPayload = payload.ownerId ?? request.ownerId;
    if (typeof fromPayload === 'string' && fromPayload.trim() !== '') return fromPayload;
    const container = await this.containersRepo.findOneBy({ id: context.resourceId });
    if (container?.ownerId) return container.ownerId;
    return String(context.requestedBy ?? '');
  }

  private runtimeIdFromPayload(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const value = (payload as Record<string, unknown>).runtimeId;
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private async toAgentMountSpecs(context: CommandHookContext): Promise<ContainerMountSpec[]> {
    const ownerId = await this.ownerId(context);
    const result: ContainerMountSpec[] = [];
    for (const mount of await this.mountsFromContext(context)) {
      const hostPath = await this.resolveHostPath(context.serverId, mount.sourceKind, mount.sourceId, mount.dirName, ownerId);
      result.push({
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
        userId: ownerId,
        dirName: mount.dirName,
        hostPath,
        containerPath: mount.containerPath,
      });
    }
    return result;
  }

  private async resolveHostPath(
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    dirName: string,
    userId: string,
  ): Promise<string> {
    const dataDir = await this.dataDirsRepo.findOneBy({
      sourceKind,
      sourceId,
      name: dirName,
      userId,
      desiredState: 'active',
    });
    if (!dataDir) throw new Error(`Data directory ${sourceKind}:${sourceId}:${userId}:${dirName} not found`);

    if (sourceKind === 'local') {
      const disk = await this.dataDisksRepo.findOneBy({ id: sourceId, serverId, desiredState: 'active' });
      if (!disk) throw new Error(`Data disk ${sourceId} not found on server ${serverId}`);
      return this.joinHostPath(disk.mountPoint, dirName);
    }

    const assignment = await this.remoteFsAssignmentsRepo.findOneBy({
      remoteFsMountId: sourceId,
      serverId,
      desiredState: 'active',
    });
    if (!assignment) throw new Error(`Remote FS mount ${sourceId} not assigned to server ${serverId}`);
    const remote = await this.remoteFsRepo.findOneBy({ id: sourceId, desiredState: 'active' });
    if (!remote) throw new Error(`Remote FS mount ${sourceId} not found`);
    return this.joinHostPath(remote.hostMountPoint, dirName);
  }

  private joinHostPath(root: string, dirName: string): string {
    return `${root.replace(/\/+$/, '')}/${dirName}`;
  }

  private async mountsFromContext(context: CommandHookContext) {
    const request = context.request && typeof context.request === 'object' && !Array.isArray(context.request)
      ? context.request as Record<string, unknown>
      : {};
    const requestMounts = Array.isArray(request.mounts)
      ? request.mounts
      : Array.isArray(request.dataDirs)
      ? request.dataDirs
      : null;
    if (requestMounts) {
      return requestMounts.map((mount, index) => {
        const record = mount && typeof mount === 'object' && !Array.isArray(mount)
          ? mount as Record<string, unknown>
          : {};
        return {
          id: typeof record.id === 'string'
            ? record.id
            : `${record.sourceKind}:${record.sourceId}:${record.dirName}:${index}`,
          sourceKind: record.sourceKind === 'remote' ? 'remote' as const : 'local' as const,
          sourceId: String(record.sourceId ?? ''),
          dirName: String(record.dirName ?? ''),
          containerPath: String(record.containerPath ?? ''),
        };
      });
    }

    const expected = expectedMountSpecs(context.payload);
    if (expected) {
      return expected.map((mount, index) => ({
        id: `${mount.sourceKind}:${mount.sourceId}:${mount.dirName}:${index}`,
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
        dirName: mount.dirName,
        containerPath: mount.containerPath,
      }));
    }

    const desired = await this.desiredRepo.findOneBy({ containerId: context.resourceId });
    return desiredMounts(desired);
  }
}
