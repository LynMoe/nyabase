import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AgentTaskKind,
  AuditAction,
  Capability,
  ContainerStatus,
  LABEL,
  MAX_AGENT_REMOTE_FS_MOUNTS,
  RemoteFsType,
  zRemoteFsParams,
  type RemoteFsMountDto,
  type RemoteFsMountParamsDto,
  type RemoteFsMountStatus,
  type RemoteFsParams,
  type ContainerSnapshot,
} from '@nyabase/common';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { RemoteFsSecretCryptoService } from './remote-fs-secret-crypto.service.js';
import { postCommitBestEffort } from '../common/post-commit.js';
import { MountSourcesService } from '../mount-sources/mount-sources.service.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { assertAgentDataDirCapacity } from '../datadirs/data-dir-capacity.js';

type RemoteFsEnsureScope = 'assign';

@Injectable()
export class RemoteFsMountsService {
  private readonly logger = new Logger(RemoteFsMountsService.name);

  constructor(
    @InjectRepository(RemoteFsMountEntity)
    private mountsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private assignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(ContainerMountEntity)
    private containerMountsRepo: Repository<ContainerMountEntity>,
    @InjectRepository(DataDirectoryEntity)
    private dataDirectoriesRepo: Repository<DataDirectoryEntity>,
    private auditService: AuditService,
    private accessResolver: AccessResolverService,
    private dataSource: DataSource,
    private tasks: AgentTasksService,
    private resourceKeys: ResourceKeyService,
    private agentGateway: AgentGateway,
    private secretCrypto: RemoteFsSecretCryptoService,
    private mountSources: MountSourcesService,
    private proxySnapshots: ProxySnapshotNotifierService,
  ) {}

  async list(serverId?: string): Promise<RemoteFsMountEntity[]> {
    let mounts: RemoteFsMountEntity[];
    if (serverId) {
      const assignments = await this.assignmentsRepo.find({ where: { serverId } });
      if (assignments.length === 0) return [];
      const mountIds = assignments.map((a) => a.remoteFsMountId);
      mounts = await this.mountsRepo.find({ where: { id: In(mountIds) } });
    } else {
      mounts = await this.mountsRepo.find();
    }
    return Promise.all(mounts.map((mount) => this.ensureStoredParamsEncrypted(mount)));
  }

  async findById(id: string): Promise<RemoteFsMountEntity> {
    const m = await this.mountsRepo.findOne({ where: { id } });
    if (!m) throw new NotFoundException(`Remote FS mount ${id} not found`);
    return this.ensureStoredParamsEncrypted(m);
  }

  async getServerIds(mountId: string): Promise<string[]> {
    const assignments = await this.assignmentsRepo.find({ where: { remoteFsMountId: mountId } });
    return assignments.map((a) => a.serverId);
  }

  async create(
    actorId: string,
    dto: {
      name: string;
      displayName?: string;
      description?: string;
      serverIds?: string[];
      type: string;
      options?: string;
      params: RemoteFsParams;
    },
  ): Promise<RemoteFsMountEntity & { taskIds?: string[] }> {
    const serverIds = [...new Set(dto.serverIds ?? [])];
    if (serverIds.length > 1) {
      throw new BadRequestException(
        'Create accepts at most one server; create the mount first, then assign servers one at a time',
      );
    }
    const id = uuidv4();
    const fsType = dto.params.type;
    const hostMountPoint = `/mnt/remote-fs/${id}`;

    // Validate params via zod
    zRemoteFsParams.parse(dto.params);
    const storedParams = this.paramsForStorageCreate(dto.params);

    const mount = this.mountsRepo.create({
      id,
      name: dto.name,
      displayName: dto.displayName ?? null,
      description: dto.description ?? null,
      type: fsType,
      hostMountPoint,
      options: dto.options ?? '',
      params: storedParams,
      desiredState: 'active',
      generation: 1,
      lastTaskId: null,
    });
    const now = new Date();
    mount.createdAt = now;
    mount.updatedAt = now;

    const taskIds = await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager, actorId, [Capability.ManageServers],
      );
      await manager.save(RemoteFsMountEntity, mount);
      const ids: string[] = [];
      for (const serverId of serverIds) {
        await this.assertServerExists(manager, serverId);
        await this.assertServerAssignmentCapacity(manager, serverId);
        const assignment = manager.create(RemoteFsServerAssignmentEntity, {
          id: uuidv4(),
          remoteFsMountId: id,
          serverId,
          desiredState: 'ensuring',
          generation: 1,
          lastTaskId: null,
        });
        await manager.save(RemoteFsServerAssignmentEntity, assignment);
        const task = await this.enqueueMountTask(manager, mount, serverId, actorId, 'assign');
        assignment.lastTaskId = task.taskId;
        await manager.save(RemoteFsServerAssignmentEntity, assignment);
        ids.push(task.taskId);
      }
      return ids;
    });

    this.accessResolver.invalidateAll();
    await postCommitBestEffort(
      'RemoteFS create audit',
      () => this.auditService.log(
        actorId, AuditAction.CreateRemoteFsMount, id, 'remote_fs_mount', this.auditPayload(dto),
      ),
      this.logger,
    );
    return Object.assign(mount, { taskIds });
  }

  async update(
    actorId: string,
    id: string,
    dto: {
      name?: string;
      displayName?: string | null;
      description?: string | null;
    },
  ): Promise<RemoteFsMountEntity & { taskIds?: string[] }> {
    const nextMount = await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager, actorId, [Capability.ManageServers],
      );
      const mount = await manager.findOneBy(RemoteFsMountEntity, { id });
      if (!mount) throw new NotFoundException(`Remote FS mount ${id} not found`);
      if (mount.desiredState !== 'active') {
        throw new ConflictException('Remote FS mount is not active');
      }
      const next = manager.create(RemoteFsMountEntity, {
        ...mount,
        name: dto.name !== undefined ? dto.name : mount.name,
        displayName: dto.displayName !== undefined ? dto.displayName || null : mount.displayName,
        description: dto.description !== undefined ? dto.description : mount.description,
        generation: mount.generation,
      });
      return manager.save(RemoteFsMountEntity, next);
    });

    this.accessResolver.invalidateAll();
    await postCommitBestEffort(
      'RemoteFS update audit',
      () => this.auditService.log(actorId, AuditAction.UpdateRemoteFsMount, id, 'remote_fs_mount', dto),
      this.logger,
    );
    return Object.assign(nextMount, { taskIds: [] });
  }

  toDto(
    mount: RemoteFsMountEntity,
    serverIds: string[],
    serverStatuses?: Record<string, RemoteFsMountStatus>,
  ): RemoteFsMountDto {
    const taskIds = (mount as RemoteFsMountEntity & { taskIds?: string[] }).taskIds;
    return {
      id: mount.id,
      name: mount.name,
      displayName: mount.displayName,
      description: mount.description,
      type: mount.type as RemoteFsParams['type'],
      options: mount.options,
      hostMountPoint: mount.hostMountPoint,
      params: this.paramsForApi(mount.params),
      createdAt: this.toIso(mount.createdAt),
      updatedAt: this.toIso(mount.updatedAt),
      serverIds,
      serverStatuses,
      ...(taskIds ? { taskIds } : {}),
    };
  }

  async remove(actorId: string, id: string): Promise<{ ok: true; taskIds: string[] }> {
    await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager, actorId, [Capability.ManageServers],
      );
      const mount = await manager.findOneBy(RemoteFsMountEntity, { id });
      if (!mount) throw new NotFoundException(`Remote FS mount ${id} not found`);
      await this.assertNotInUse(manager, id);
      const assignmentCount = await manager.count(RemoteFsServerAssignmentEntity, {
        where: { remoteFsMountId: id },
      });
      if (assignmentCount > 0) {
        throw new ConflictException(
          'Unassign every server successfully before deleting the remote FS mount',
        );
      }
      await this.mountSources.deleteSourceInTransaction(manager, {
        sourceKind: 'remote',
        sourceId: id,
      });
      await manager.delete(RemoteFsMountEntity, id);
    });

    this.accessResolver.invalidateAll();
    await postCommitBestEffort(
      'RemoteFS delete audit',
      () => this.auditService.log(actorId, AuditAction.DeleteRemoteFsMount, id, 'remote_fs_mount'),
      this.logger,
    );
    return { ok: true, taskIds: [] };
  }

  // ---------------------------------------------------------------------------
  // Server assignments
  // ---------------------------------------------------------------------------

  async listServerAssignments(mountId: string): Promise<RemoteFsServerAssignmentEntity[]> {
    await this.findById(mountId);
    return this.assignmentsRepo.find({ where: { remoteFsMountId: mountId } });
  }

  async assignServer(
    actorId: string,
    mountId: string,
    serverId: string,
  ): Promise<RemoteFsServerAssignmentEntity & { taskId?: string }> {
    const applied = await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager, actorId, [Capability.ManageServers],
      );
      const mount = await manager.findOneBy(RemoteFsMountEntity, { id: mountId });
      if (!mount) throw new NotFoundException(`Remote FS mount ${mountId} not found`);
      if (mount.desiredState !== 'active') {
        throw new ConflictException('Remote FS mount is not active');
      }
      await this.assertServerExists(manager, serverId);
      const existing = await manager.findOne(RemoteFsServerAssignmentEntity, {
        where: { remoteFsMountId: mountId, serverId },
      });
      if (existing) {
        await this.assertRepairConsumersStopped(manager, mountId, serverId);
      } else {
        await this.assertServerAssignmentCapacity(manager, serverId);
        await assertAgentDataDirCapacity(manager, serverId, {
          includeRemoteMountId: mountId,
        });
      }
      await this.tasks.supersedePendingForResourceInTransaction(manager, {
        serverId,
        resourceType: 'remote_fs_mount',
        resourceId: mountId,
        reason: 'A newer RemoteFS ensure intent replaced this task',
      });
      const assignment = existing ?? manager.create(RemoteFsServerAssignmentEntity, {
        id: uuidv4(),
        remoteFsMountId: mountId,
        serverId,
        generation: 0,
        lastTaskId: null,
      });
      assignment.desiredState = 'ensuring';
      assignment.generation = (assignment.generation ?? 0) + 1;
      await manager.save(RemoteFsServerAssignmentEntity, assignment);
      const created = await this.enqueueMountTask(
        manager,
        mount,
        serverId,
        actorId,
        'assign',
      );
      assignment.lastTaskId = created.taskId;
      await manager.save(RemoteFsServerAssignmentEntity, assignment);
      return { assignment, taskId: created.taskId, created: !existing };
    });
    this.accessResolver.invalidateAll();
    await postCommitBestEffort(
      'RemoteFS assignment audit',
      () => this.auditService.log(
        actorId,
        AuditAction.AssignRemoteFsServer,
        mountId,
        'remote_fs_mount',
        { serverId, repair: !applied.created },
      ),
      this.logger,
    );
    this.proxySnapshots.invalidate(
      `RemoteFS ${mountId} assignment ensure committed on ${serverId}`,
    );
    return Object.assign(applied.assignment, {
      ...(applied.taskId ? { taskId: applied.taskId } : {}),
    });
  }

  async unassignServer(actorId: string, mountId: string, serverId: string): Promise<{ ok: true; taskIds: string[] }> {
    const task = await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager, actorId, [Capability.ManageServers],
      );
      const assignment = await manager.findOne(RemoteFsServerAssignmentEntity, {
        where: { remoteFsMountId: mountId, serverId },
      });
      if (!assignment) return null;
      await this.assertNotInUse(manager, mountId, serverId);
      await this.assertRemoteDataDirsRemainReachable(manager, mountId, serverId);
      await this.tasks.supersedePendingForResourceInTransaction(manager, {
        serverId,
        resourceType: 'remote_fs_mount',
        resourceId: mountId,
        reason: 'A newer RemoteFS absent intent replaced this task',
      });
      assignment.desiredState = 'removing';
      assignment.generation = (assignment.generation ?? 0) + 1;
      await manager.save(RemoteFsServerAssignmentEntity, assignment);
      const created = await this.enqueueRemoveTask(manager, mountId, serverId, actorId);
      await manager.update(RemoteFsServerAssignmentEntity, assignment.id, { lastTaskId: created.taskId });
      return created;
    });
    if (!task) return { ok: true, taskIds: [] };
    this.accessResolver.invalidateAll();
    await postCommitBestEffort(
      'RemoteFS unassignment audit',
      () => this.auditService.log(
        actorId, AuditAction.UnassignRemoteFsServer, mountId, 'remote_fs_mount', { serverId },
      ),
      this.logger,
    );
    return {
      ok: true,
      taskIds: [task.taskId],
    };
  }

  // ---------------------------------------------------------------------------
  // Status projection
  // ---------------------------------------------------------------------------

  async getMountStatuses(mountId: string, serverIds: string[]): Promise<Record<string, RemoteFsMountStatus>> {
    const result: Record<string, RemoteFsMountStatus> = {};
    for (const serverId of serverIds) {
      const status = this.agentGateway.stateCache.getRemoteFsMountStatus(serverId, mountId);
      if (!status) continue;
      result[serverId] = status;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async enqueueMountTask(
    manager: EntityManager,
    mount: RemoteFsMountEntity,
    serverId: string,
    requestedBy: string | null,
    scope: RemoteFsEnsureScope,
  ) {
    const payload = {
      id: mount.id,
      hostMountPoint: mount.hostMountPoint,
      options: mount.options,
      params: mount.params,
    };
    const request = {
      scope,
      mountId: mount.id,
      serverId,
      mount: this.mountDefinition(mount),
    };

    return this.tasks.enqueueInTransaction(manager, {
      kind: AgentTaskKind.RemoteFsEnsure,
      serverId,
      resourceType: 'remote_fs_mount',
      resourceId: mount.id,
      requestedBy,
      payload,
      request,
      resourceKeys: [
        this.resourceKeys.remoteFsAssignment(serverId, mount.id),
        this.resourceKeys.mountSource({
          serverId,
          sourceKind: 'remote',
          sourceId: mount.id,
        }),
      ],
    });
  }

  private async enqueueRemoveTask(
    manager: EntityManager,
    mountId: string,
    serverId: string,
    requestedBy: string | null,
  ) {
    const mount = await manager.findOneByOrFail(RemoteFsMountEntity, { id: mountId });
    return this.tasks.enqueueInTransaction(manager, {
      kind: AgentTaskKind.RemoteFsAbsent,
      serverId,
      resourceType: 'remote_fs_mount',
      resourceId: mountId,
      requestedBy,
      payload: {
        id: mountId,
        hostMountPoint: mount.hostMountPoint,
        options: mount.options,
        params: mount.params,
      },
      request: { scope: 'assignment', mountId, serverId },
      resourceKeys: [
        this.resourceKeys.remoteFsAssignment(serverId, mountId),
        this.resourceKeys.mountSource({
          serverId,
          sourceKind: 'remote',
          sourceId: mountId,
        }),
      ],
    });
  }

  private async assertNotInUse(
    manager: EntityManager,
    mountId: string,
    serverId?: string,
  ): Promise<void> {
    const containerMount = await manager.findOne(ContainerMountEntity, {
      where: {
        sourceKind: 'remote',
        sourceId: mountId,
        ...(serverId ? { serverId } : {}),
      },
    });
    if (containerMount) {
      throw new ConflictException(
        `Remote FS mount is still referenced by container "${containerMount.containerName}"`,
      );
    }
    // A remote DataDir is one global directory on the shared filesystem and
    // intentionally has serverId=NULL. It always blocks deletion of the global
    // mount object. Per-server unassignment is checked separately below so at
    // least one usable assignment remains as its repair/delete control path.
    if (!serverId) {
      const dataDir = await manager.findOne(DataDirectoryEntity, {
        where: { sourceKind: 'remote', sourceId: mountId },
      });
      if (dataDir) {
        throw new ConflictException(
          'Remote FS mount still has data directories; delete those data directories first',
        );
      }
    }
  }

  private async assertRemoteDataDirsRemainReachable(
    manager: EntityManager,
    mountId: string,
    removingServerId: string,
  ): Promise<void> {
    const hasDataDirs = await manager.existsBy(DataDirectoryEntity, {
      sourceKind: 'remote',
      sourceId: mountId,
    });
    if (!hasDataDirs) return;
    const replacementCount = await manager.count(RemoteFsServerAssignmentEntity, {
      where: {
        remoteFsMountId: mountId,
        serverId: Not(removingServerId),
        desiredState: 'active',
      },
    });
    if (replacementCount === 0) {
      throw new ConflictException({
        code: 'REMOTE_FS_LAST_ASSIGNMENT_HAS_DATA_DIRS',
        message: 'Keep another active server assignment until all remote data directories are deleted',
      });
    }
  }

  /**
   * Replacing or recreating a host mount can change the filesystem visible to
   * an already-created bind. Require one current exact stopped observation for
   * every consumer before the assignment transition. The mount-source lock
   * acquired by the Ensure task then prevents a start/restart task from racing
   * the physical mount operation.
   */
  private async assertRepairConsumersStopped(
    manager: EntityManager,
    mountId: string,
    serverId: string,
  ): Promise<void> {
    const references = await manager.find(ContainerMountEntity, {
      where: { sourceKind: 'remote', sourceId: mountId, serverId },
    });
    if (references.length === 0) return;

    const snapshot = this.agentGateway.stateCache.get(serverId);
    if (!this.agentGateway.isOnline(serverId) || !snapshot?.runtimeReady) {
      throw new ConflictException(
        'Remote FS repair requires a current online inventory proving every consumer is stopped',
      );
    }
    const containerIds = [...new Set(references.map((reference) => reference.containerId))];
    const lifecycles = await manager.find(ContainerLifecycleEntity, {
      where: { containerId: In(containerIds) },
    });
    const lifecycleById = new Map(lifecycles.map((lifecycle) => [lifecycle.containerId, lifecycle]));
    const snapshotsByContainerId = new Map<string, ContainerSnapshot[]>();
    for (const runtime of snapshot.containers.values()) {
      const containerId = runtime.labels?.[LABEL.CONTAINER_ID];
      if (!containerId) continue;
      const group = snapshotsByContainerId.get(containerId) ?? [];
      group.push(runtime);
      snapshotsByContainerId.set(containerId, group);
    }
    for (const containerId of containerIds) {
      const lifecycle = lifecycleById.get(containerId);
      const observations = snapshotsByContainerId.get(containerId) ?? [];
      const exact = observations.length === 1 ? observations[0] : null;
      if (
        !lifecycle
        || lifecycle.activeTaskId !== null
        || !lifecycle.boundRuntimeId
        || !exact
        || exact.runtime.runtimeId !== lifecycle.boundRuntimeId
        || exact.status !== ContainerStatus.Exited
      ) {
        throw new ConflictException(
          `Remote FS repair requires container ${containerId} to have one current exact stopped runtime`,
        );
      }
    }
  }

  private async assertServerExists(manager: EntityManager, serverId: string): Promise<void> {
    if (await manager.findOneBy(ServerEntity, { id: serverId })) return;
    throw new NotFoundException(`Server ${serverId} not found`);
  }

  private async assertServerAssignmentCapacity(
    manager: EntityManager,
    serverId: string,
  ): Promise<void> {
    const count = await manager.count(RemoteFsServerAssignmentEntity, { where: { serverId } });
    if (count < MAX_AGENT_REMOTE_FS_MOUNTS) return;
    throw new ConflictException(
      `Server ${serverId} already has the maximum ${MAX_AGENT_REMOTE_FS_MOUNTS} RemoteFS assignments`,
    );
  }

  private mountDefinition(mount: RemoteFsMountEntity): Record<string, unknown> {
    return {
      id: mount.id,
      name: mount.name,
      displayName: mount.displayName,
      description: mount.description,
      type: mount.type,
      hostMountPoint: mount.hostMountPoint,
      options: mount.options,
      params: mount.params,
      generation: mount.generation,
    };
  }

  private paramsForStorageCreate(params: RemoteFsParams): RemoteFsParams {
    if (params.type !== RemoteFsType.CephFs) return params;
    return {
      ...params,
      secret: this.secretCrypto.encrypt(params.secret),
    };
  }

  private async ensureStoredParamsEncrypted(mount: RemoteFsMountEntity): Promise<RemoteFsMountEntity> {
    if (mount.params.type !== RemoteFsType.CephFs) return mount;
    if (!mount.params.secret || this.secretCrypto.isEncrypted(mount.params.secret)) return mount;
    throw new Error(`Remote FS mount ${mount.id} contains an unencrypted CephFS secret`);
  }

  private paramsForApi(params: RemoteFsParams): RemoteFsMountParamsDto {
    if (params.type !== RemoteFsType.CephFs) return params;
    const { secret, ...publicParams } = params;
    return {
      ...publicParams,
      secretConfigured: Boolean(secret && secret.trim().length > 0),
    };
  }

  private auditPayload<T extends { params?: RemoteFsParams }>(dto: T): T {
    if (!dto.params || dto.params.type !== RemoteFsType.CephFs) return dto;
    const { secret, ...publicParams } = dto.params;
    return {
      ...dto,
      params: {
        ...publicParams,
        secretConfigured: typeof secret === 'string' && secret.trim().length > 0,
      },
    } as T;
  }

  private toIso(value: Date | string): string {
    if (value instanceof Date) return value.toISOString();
    return new Date(value).toISOString();
  }
}
