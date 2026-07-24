import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ServersService } from '../servers/servers.service.js';
import { UsersService } from '../users/users.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import {
  AgentTaskKind,
  AuditAction,
  Capability,
  DataDirDto,
  type UserDataDirDto,
  remoteFsSourceIdentity,
} from '@nyabase/common';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { postCommitBestEffort } from '../common/post-commit.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { exactLocalDisk } from '../mount-sources/utils.js';
import { assertAgentDataDirCapacity } from './data-dir-capacity.js';

@Injectable()
export class DataDirsService {
  private readonly logger = new Logger(DataDirsService.name);

  constructor(
    @InjectRepository(DataDirectoryEntity)
    private dataDirRepo: Repository<DataDirectoryEntity>,
    @InjectRepository(ContainerMountEntity)
    private containerMountsRepo: Repository<ContainerMountEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsMountsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private remoteFsAssignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(QuotaDesiredEntity)
    private quotaDesiredRepo: Repository<QuotaDesiredEntity>,
    private serversService: ServersService,
    private usersService: UsersService,
    private auditService: AuditService,
    private tasks: AgentTasksService,
    private resourceKeys: ResourceKeyService,
    private agentGateway: AgentGateway,
    private accessResolver: AccessResolverService,
  ) {}

  /** Compute the host path for a directory (single-layer layout: {mountPoint}/{name}) */
  private async computeHostPath(serverId: string, sourceKind: 'local' | 'remote', sourceId: string, resourceId: string): Promise<string> {
    if (sourceKind === 'local') {
      const disk = this.agentGateway.stateCache.get(serverId)?.disks.find((d) => d.diskId === sourceId);
      return disk ? this.physicalDataDirPath(disk.mountPoint, resourceId) : resourceId;
    }
    const rfs = await this.remoteFsMountsRepo.findOne({ where: { id: sourceId } });
    return rfs ? this.physicalDataDirPath(rfs.hostMountPoint, resourceId) : resourceId;
  }

  async listDirs(userId: string, serverId: string): Promise<DataDirDto[]> {
    const server = await this.serversService.findById(serverId).catch(() => null);
    const serverName = server?.name ?? serverId;

    // Fetch local dirs for this server's agent-configured sources.
    const disks = this.agentGateway.stateCache.get(serverId)?.disks ?? [];
    const diskIds = disks.map((d) => d.diskId);
    const mountPointMap = new Map(disks.map((d) => [d.diskId, d.mountPoint]));

    // Fetch remote dirs for mounts assigned to this server
    const assignments = await this.remoteFsAssignmentsRepo.find({
      where: { serverId, desiredState: 'active' },
    });
    const remoteIds = assignments.map((a) => a.remoteFsMountId);
    const remoteMountPointMap = new Map<string, string>();
    if (remoteIds.length > 0) {
      const mounts = await this.remoteFsMountsRepo.find({ where: { id: In(remoteIds) } });
      for (const m of mounts) remoteMountPointMap.set(m.id, m.hostMountPoint);
    }

    if (diskIds.length === 0 && remoteIds.length === 0) return [];
    const rows = await this.dataDirRepo.find({
      where: [
        ...(diskIds.length > 0 ? [{
          userId,
          sourceKind: 'local' as const,
          serverId,
          sourceId: In(diskIds),
        }] : []),
        ...(remoteIds.length > 0 ? [{
          userId,
          sourceKind: 'remote' as const,
          sourceId: In(remoteIds),
        }] : []),
      ],
    });

    return rows.map((row) => {
      const mountPoint = row.sourceKind === 'local'
        ? (mountPointMap.get(row.sourceId) ?? '')
        : (remoteMountPointMap.get(row.sourceId) ?? '');
      return {
        id: row.id,
        resourceId: row.id,
        userId: row.userId,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        name: row.name,
        hostPath: this.physicalDataDirPath(mountPoint, row.id),
        serverId,
        serverName,
        desiredState: row.desiredState,
        generation: row.generation,
        lastTaskId: row.lastTaskId,
      };
    });
  }

  async listUserDirs(userId: string, serverId: string): Promise<UserDataDirDto[]> {
    return (await this.listDirs(userId, serverId)).map(({ hostPath: _hostPath, ...row }) => row);
  }

  async createDir(
    actorId: string,
    userId: string,
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    name: string,
    uid: number,
    authorizationKind: 'owner' | 'admin' = 'owner',
  ) {
    // Validate source exists on this server
    let sourceIdentity: string;
    if (sourceKind === 'local') {
      const disk = this.agentGateway.stateCache.get(serverId)?.disks.find((d) => d.diskId === sourceId);
      if (!disk) throw new NotFoundException(`Disk ${sourceId} not found on server ${serverId}`);
      sourceIdentity = disk.sourceIdentity;
    } else {
      const assignment = await this.remoteFsAssignmentsRepo.findOne({
        where: { remoteFsMountId: sourceId, serverId, desiredState: 'active' },
      });
      if (!assignment) {
        throw new ConflictException(`Remote FS mount ${sourceId} is not ready on server ${serverId}`);
      }
      const mount = await this.remoteFsMountsRepo.findOne({ where: { id: sourceId, desiredState: 'active' } });
      if (!mount) throw new NotFoundException(`Remote FS mount ${sourceId} is not active`);
      sourceIdentity = remoteFsSourceIdentity(mount.params);
    }

    const numericMap = await this.usersService.getNumericIdsByUserIds([userId]);
    const numericUserId = numericMap.get(userId);
    if (numericUserId == null) throw new Error(`numericId not found for user ${userId}`);
    const quotaDesired = await this.quotaDesiredRepo.findOneBy({ serverId, userId });
    if (
      !quotaDesired
      || !quotaDesired.lastTaskId
      || quotaDesired.numericUserId !== numericUserId
    ) {
      throw new ConflictException('User quota has no durable desired state on this server');
    }

    const existing = await this.dataDirRepo.findOne({
      where: {
        sourceKind,
        sourceId,
        name,
        ...(sourceKind === 'local' ? { serverId } : {}),
      },
    });
    if (existing) {
      throw new ConflictException(`Directory "${name}" already exists on this source`);
    }

    const dataDirId = uuidv4();
    const createDataDirPayload = {
      resourceId: dataDirId,
      generation: 1,
      diskId: sourceId,
      sourceIdentity,
      quotaRequired: sourceKind === 'local',
      uid,
      numericUserId,
      quotaGeneration: quotaDesired.generation,
      diskBytes: quotaDesired.limitBytes,
    };
    const task = await this.tasks.enqueue({
      kind: AgentTaskKind.DataDirEnsure,
      serverId,
      resourceType: 'datadir',
      resourceId: dataDirId,
      requestedBy: actorId,
      payload: createDataDirPayload,
      resourceKeys: [
        this.resourceKeys.dataDir({ serverId, sourceKind, sourceId, name }),
        this.resourceKeys.mountSource({ serverId, sourceKind, sourceId }),
        this.resourceKeys.quota(serverId, userId),
      ],
      request: {
        id: dataDirId,
        userId,
        serverId,
        sourceKind,
        sourceId,
        sourceIdentity,
        name,
        uid,
      },
      beforeCommit: async (manager, context) => {
        if (authorizationKind === 'admin') {
          await this.accessResolver.assertActorCapabilitiesInTransaction(
            manager, actorId, [Capability.ManageContainersAny],
          );
        }
        const authorized = await this.accessResolver.hasMountSourceAccessInTransaction(
          manager,
          userId,
          serverId,
          { kind: sourceKind, id: sourceId },
          sourceKind === 'local' ? sourceIdentity : undefined,
        );
        if (!authorized) {
          throw new ConflictException('Mount source authorization changed while preparing the data directory');
        }
        const duplicate = await manager.findOne(DataDirectoryEntity, {
          where: {
            sourceKind,
            sourceId,
            name,
            ...(sourceKind === 'local' ? { serverId } : {}),
          },
        });
        if (duplicate) throw new ConflictException(`Directory "${name}" already exists on this source`);
        if (sourceKind === 'local') {
          await assertAgentDataDirCapacity(manager, serverId, { additionalRows: 1 });
        } else {
          // One shared remote row becomes visible to every durable assignment,
          // not only to the Server chosen to execute its creation task.
          const assignedServers = await manager.find(RemoteFsServerAssignmentEntity, {
            where: { remoteFsMountId: sourceId },
          });
          for (const affectedServerId of new Set([
            serverId,
            ...assignedServers.map((assignment) => assignment.serverId),
          ])) {
            await assertAgentDataDirCapacity(manager, affectedServerId, {
              additionalRows: 1,
            });
          }
        }
        if (sourceKind === 'remote') {
          const mount = await manager.findOneBy(RemoteFsMountEntity, {
            id: sourceId,
            desiredState: 'active',
          });
          if (!mount || remoteFsSourceIdentity(mount.params) !== sourceIdentity) {
            throw new ConflictException(`Remote FS mount ${sourceId} physical identity changed`);
          }
        }
        const freshQuota = await manager.findOne(QuotaDesiredEntity, {
          where: { serverId, userId },
        });
        if (
          !freshQuota
          || !freshQuota.lastTaskId
          || freshQuota.generation !== quotaDesired.generation
          || freshQuota.numericUserId !== numericUserId
          || freshQuota.limitBytes !== quotaDesired.limitBytes
        ) {
          throw new ConflictException('User quota changed while preparing the data directory; retry');
        }
        await manager.save(DataDirectoryEntity, manager.create(DataDirectoryEntity, {
          id: dataDirId,
          userId,
          sourceKind,
          sourceId,
          name,
          sourceIdentity,
          serverId: sourceKind === 'local' ? serverId : null,
          uid,
          desiredState: 'creating',
          generation: 1,
          lastTaskId: context.taskId,
        }));
      },
    });

    await postCommitBestEffort(
      'DataDir create audit',
      () => this.auditService.log(actorId, AuditAction.CreateDataDir, dataDirId, 'datadir', {
        userId,
        serverId,
        sourceKind,
        sourceId,
        path: `${serverId}/${sourceId}/${name}`,
        taskId: task.taskId,
      }),
      this.logger,
    );

    const hostPath = await this.computeHostPath(serverId, sourceKind, sourceId, dataDirId);
    return {
      id: dataDirId,
      resourceId: dataDirId,
      serverId,
      sourceKind,
      sourceId,
      name,
      hostPath,
      taskId: task.taskId,
    };
  }

  async deleteDir(
    actorId: string,
    userId: string,
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    name: string,
    authorizationKind: 'owner' | 'admin' = 'owner',
  ) {
    const row = await this.dataDirRepo.findOne({
      where: {
        sourceKind,
        sourceId,
        name,
        userId,
        ...(sourceKind === 'local' ? { serverId } : {}),
      },
    });
    if (!row) throw new NotFoundException(`Data directory "${name}" not found`);

    await this.assertNotReferencedByContainer(serverId, sourceKind, sourceId, userId, name);

    const numericMap = await this.usersService.getNumericIdsByUserIds([userId]);
    const numericUserId = numericMap.get(userId);
    if (numericUserId == null) throw new Error(`numericId not found for user ${userId}`);
    const nextGeneration = (row.generation ?? 0) + 1;
    const deleteDataDirPayload = {
      resourceId: row.id,
      generation: nextGeneration,
      diskId: sourceId,
      sourceIdentity: row.sourceIdentity,
      numericUserId,
    };

    const task = await this.tasks.enqueue({
      kind: AgentTaskKind.DataDirAbsent,
      serverId,
      resourceType: 'datadir',
      resourceId: row.id,
      requestedBy: actorId,
      payload: deleteDataDirPayload,
      resourceKeys: [
        this.resourceKeys.dataDir({ serverId, sourceKind, sourceId, name }),
        this.resourceKeys.mountSource({ serverId, sourceKind, sourceId }),
        this.resourceKeys.quota(serverId, userId),
      ],
      request: { userId, sourceKind, sourceId, sourceIdentity: row.sourceIdentity, name },
      beforeCommit: async (manager, context) => {
        if (authorizationKind === 'admin') {
          await this.accessResolver.assertActorCapabilitiesInTransaction(
            manager, actorId, [Capability.ManageContainersAny],
          );
        }
        const fresh = await manager.findOneBy(DataDirectoryEntity, { id: row.id });
        if (
          !fresh
          || (fresh.desiredState !== 'active' && fresh.desiredState !== 'failed')
          || fresh.generation !== row.generation
          || fresh.userId !== userId
          || fresh.sourceKind !== sourceKind
          || fresh.sourceId !== sourceId
          || fresh.sourceIdentity !== row.sourceIdentity
          || fresh.name !== name
          || (sourceKind === 'local' && fresh.serverId !== serverId)
        ) {
          throw new ConflictException('Data directory changed while preparing deletion; retry');
        }
        await this.assertNotReferencedByContainer(
          serverId,
          sourceKind,
          sourceId,
          userId,
          name,
          manager,
        );
        await this.assertDeletionSourceReady(manager, serverId, fresh);
        if (authorizationKind === 'owner') {
          const authorized = await this.accessResolver.hasMountSourceAccessInTransaction(
            manager,
            userId,
            serverId,
            { kind: sourceKind, id: sourceId },
            sourceKind === 'local' ? row.sourceIdentity : undefined,
          );
          if (!authorized) {
            throw new ConflictException(
              'Mount source authorization changed while preparing data directory deletion',
            );
          }
        }
        await manager.update(DataDirectoryEntity, row.id, {
          desiredState: 'removing',
          generation: nextGeneration,
          lastTaskId: context.taskId,
        });
      },
    });

    await postCommitBestEffort(
      'DataDir delete audit',
      () => this.auditService.log(actorId, AuditAction.DeleteDataDir, row.id, 'datadir', {
        userId,
        serverId,
        sourceKind,
        sourceId,
        name,
        path: `${serverId}/${sourceId}/${name}`,
        taskId: task.taskId,
      }),
      this.logger,
    );
    return {
      ok: true,
      taskId: task.taskId,
      status: task.status,
    };
  }

  private async assertNotReferencedByContainer(
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    userId: string,
    dirName: string,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager?.getRepository(ContainerMountEntity) ?? this.containerMountsRepo;
    const mount = await repo.findOne({
      where: {
        sourceKind,
        sourceId,
        userId,
        dirName,
        ...(sourceKind === 'local' ? { serverId } : {}),
      },
    });
    if (mount) throw new ConflictException(`Data directory "${dirName}" is referenced by a container`);
  }

  /**
   * A delete task is only safe on an Agent that currently exposes the exact
   * physical source captured by the directory reservation. The route-level
   * authorization read is deliberately insufficient: a RemoteFS assignment
   * may finish unmounting between that read and durable task admission.
   */
  private async assertDeletionSourceReady(
    manager: EntityManager,
    serverId: string,
    row: DataDirectoryEntity,
  ): Promise<void> {
    if (row.sourceKind === 'local') {
      const snapshot = this.agentGateway.stateCache.get(serverId);
      const disk = snapshot && snapshot.helloAt !== null
        ? exactLocalDisk(snapshot.disks, row.sourceId)
        : null;
      if (!disk || disk.sourceIdentity !== row.sourceIdentity) {
        throw new ConflictException({
          code: 'DATA_DIRECTORY_SOURCE_NOT_READY',
          message: 'The exact local data source is no longer ready on this server',
        });
      }
      return;
    }

    const [assignment, mount] = await Promise.all([
      manager.findOneBy(RemoteFsServerAssignmentEntity, {
        remoteFsMountId: row.sourceId,
        serverId,
        desiredState: 'active',
      }),
      manager.findOneBy(RemoteFsMountEntity, {
        id: row.sourceId,
        desiredState: 'active',
      }),
    ]);
    if (
      !assignment
      || !mount
      || remoteFsSourceIdentity(mount.params) !== row.sourceIdentity
    ) {
      throw new ConflictException({
        code: 'DATA_DIRECTORY_SOURCE_NOT_READY',
        message: 'The exact remote data source is no longer assigned to this server',
      });
    }
  }

  private physicalDataDirPath(root: string, resourceId: string): string {
    return `${root.replace(/\/+$/, '')}/.nyabase/dirs/${resourceId}/data`;
  }

}
