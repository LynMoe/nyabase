import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentTaskKind,
  AuditAction,
  Capability,
  ContainerStatus,
  LABEL,
  MAX_AGENT_REMOTE_FS_MOUNTS,
  MAX_PLATFORM_REMOTE_FS_MOUNTS,
  RemoteFsType,
  zRemoteFsParams,
  type ContainerSnapshot,
  type RemoteFsMountDto,
  type RemoteFsMountParamsDto,
  type RemoteFsMountStatus,
  type RemoteFsParams,
} from '@nyabase/common';
import type { Transaction } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  RemoteFsMountRecord,
  RemoteFsServerAssignmentRecord,
} from '../domain/domain-records.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { MountSourcesService } from '../mount-sources/mount-sources.service.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { StorageRepository } from '../storage/storage.repository.js';
import { assertAgentDataDirCapacity } from '../datadirs/data-dir-capacity.js';
import { RemoteFsSecretCryptoService } from './remote-fs-secret-crypto.service.js';

@Injectable()
export class RemoteFsMountsService {
  constructor(
    private readonly storage: StorageRepository,
    private readonly transactions: PgTransactionManager,
    private readonly auditService: AuditService,
    private readonly accessResolver: AccessResolverService,
    private readonly workflow: WorkflowEnqueuePort,
    private readonly resourceKeys: ResourceKeyService,
    private readonly agentGateway: AgentGateway,
    private readonly secretCrypto: RemoteFsSecretCryptoService,
    private readonly mountSources: MountSourcesService,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
  ) {}

  async list(serverId?: string): Promise<RemoteFsMountRecord[]> {
    const mounts = serverId
      ? await this.storage.listRemoteFsMountsByServer(serverId)
      : await this.storage.listRemoteFsMounts();
    return Promise.all(mounts.map((mount) => this.ensureStoredParamsEncrypted(mount)));
  }

  async listWithServerIds(serverId?: string): Promise<Array<{
    mount: RemoteFsMountRecord;
    serverIds: string[];
  }>> {
    const mounts = await this.list(serverId);
    const assignments = await this.storage.listAssignmentsForMountIds(
      mounts.map((mount) => mount.id),
    );
    const serverIdsByMount = new Map<string, string[]>();
    for (const assignment of assignments) {
      const ids = serverIdsByMount.get(assignment.remoteFsMountId) ?? [];
      ids.push(assignment.serverId);
      serverIdsByMount.set(assignment.remoteFsMountId, ids);
    }
    return mounts.map((mount) => ({
      mount,
      serverIds: serverIdsByMount.get(mount.id) ?? [],
    }));
  }

  async findById(id: string): Promise<RemoteFsMountRecord> {
    const mount = await this.storage.findRemoteFsMount(id);
    if (!mount) throw new NotFoundException(`Remote FS mount ${id} not found`);
    return this.ensureStoredParamsEncrypted(mount);
  }

  async getServerIds(mountId: string): Promise<string[]> {
    return (await this.storage.listAssignmentsForMount(mountId))
      .map((assignment) => assignment.serverId);
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
  ): Promise<RemoteFsMountRecord & { taskIds?: string[] }> {
    const serverIds = [...new Set(dto.serverIds ?? [])];
    if (serverIds.length > 1) {
      throw new BadRequestException(
        'Create accepts at most one server; create the mount first, then assign servers one at a time',
      );
    }
    zRemoteFsParams.parse(dto.params);
    const id = uuidv4();
    const storedParams = this.paramsForStorageCreate(dto.params);
    const applied = await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageServers],
      );
      await this.storage.lockRemoteFsMountCapacity(transaction);
      if (
        await this.storage.countRemoteFsMounts(transaction)
        >= MAX_PLATFORM_REMOTE_FS_MOUNTS
      ) {
        throw new ConflictException({
          code: 'REMOTE_FS_CAPACITY_REACHED',
          message:
            `At most ${MAX_PLATFORM_REMOTE_FS_MOUNTS} RemoteFS mounts are supported`,
        });
      }
      const mount = await this.storage.insertRemoteFsMount({
        id,
        name: dto.name,
        displayName: dto.displayName ?? null,
        description: dto.description ?? null,
        type: dto.params.type,
        hostMountPoint: `/mnt/remote-fs/${id}`,
        options: dto.options ?? '',
        params: storedParams,
      }, transaction);
      const taskIds: string[] = [];
      for (const serverId of serverIds) {
        await this.assertServerExists(transaction, serverId);
        await this.assertServerAssignmentCapacity(transaction, serverId);
        const assignment = await this.storage.insertAssignment({
          id: uuidv4(),
          mountId: id,
          serverId,
          desiredState: 'ensuring',
          generation: 1,
          lastTaskId: null,
        }, transaction);
        const task = await this.enqueueMountTask(
          transaction,
          mount,
          serverId,
          actorId,
          async (taskTransaction, taskId) => {
            const transitioned = await this.storage.transitionAssignment(
              assignment.id,
              1,
              ['ensuring'],
              { desiredState: 'ensuring', generation: 1, lastTaskId: taskId },
              taskTransaction,
            );
            if (!transitioned) {
              throw new ConflictException('Remote FS assignment changed during creation');
            }
          },
        );
        taskIds.push(task.taskId);
      }
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.CreateRemoteFsMount,
        id,
        'remote_fs_mount',
        this.auditPayload(dto),
      );
      return { mount, taskIds };
    });
    await this.accessResolver.authorizationCommitted();
    return Object.assign(applied.mount, { taskIds: applied.taskIds });
  }

  async update(
    actorId: string,
    id: string,
    dto: {
      name?: string;
      displayName?: string | null;
      description?: string | null;
    },
  ): Promise<RemoteFsMountRecord & { taskIds?: string[] }> {
    const mount = await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageServers],
      );
      const current = await this.storage.findRemoteFsMount(id, transaction);
      if (!current) throw new NotFoundException(`Remote FS mount ${id} not found`);
      if (current.desiredState !== 'active') {
        throw new ConflictException('Remote FS mount is not active');
      }
      const updated = await this.storage.updateActiveRemoteFsMountMetadata(
        id,
        {
          name: dto.name,
          displayName: dto.displayName === undefined
            ? undefined
            : dto.displayName || null,
          description: dto.description,
        },
        transaction,
      );
      if (!updated) throw new ConflictException('Remote FS mount changed; retry');
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.UpdateRemoteFsMount,
        id,
        'remote_fs_mount',
        dto,
      );
      return updated;
    });
    await this.accessResolver.authorizationCommitted();
    return Object.assign(mount, { taskIds: [] });
  }

  toDto(
    mount: RemoteFsMountRecord,
    serverIds: string[],
    serverStatuses?: Record<string, RemoteFsMountStatus>,
  ): RemoteFsMountDto {
    const taskIds = (mount as RemoteFsMountRecord & { taskIds?: string[] }).taskIds;
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

  async remove(
    actorId: string,
    id: string,
  ): Promise<{ ok: true; taskIds: string[] }> {
    await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageServers],
      );
      if (!await this.storage.findRemoteFsMount(id, transaction)) {
        throw new NotFoundException(`Remote FS mount ${id} not found`);
      }
      await this.assertNotInUse(transaction, id);
      if ((await this.storage.listAssignmentsForMount(id, transaction)).length > 0) {
        throw new ConflictException(
          'Unassign every server successfully before deleting the remote FS mount',
        );
      }
      await this.mountSources.deleteSourceInTransaction(
        transaction,
        { sourceKind: 'remote', sourceId: id },
      );
      if (!await this.storage.deleteRemoteFsMount(id, transaction)) {
        throw new ConflictException('Remote FS mount changed while deleting');
      }
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.DeleteRemoteFsMount,
        id,
        'remote_fs_mount',
      );
    });
    await this.accessResolver.authorizationCommitted();
    return { ok: true, taskIds: [] };
  }

  async listServerAssignments(
    mountId: string,
  ): Promise<RemoteFsServerAssignmentRecord[]> {
    await this.findById(mountId);
    return this.storage.listAssignmentsForMount(mountId);
  }

  async assignServer(
    actorId: string,
    mountId: string,
    serverId: string,
  ): Promise<RemoteFsServerAssignmentRecord & { taskId?: string }> {
    const applied = await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageServers],
      );
      const mount = await this.storage.findActiveRemoteFsMount(mountId, transaction);
      if (!mount) throw new NotFoundException(`Remote FS mount ${mountId} not found`);
      await this.assertServerExists(transaction, serverId);
      const existing = await this.storage.findAssignment(mountId, serverId, transaction);
      if (existing) {
        await this.assertRepairConsumersStopped(transaction, mountId, serverId);
      } else {
        await this.assertServerAssignmentCapacity(transaction, serverId);
        await assertAgentDataDirCapacity(
          this.storage,
          transaction,
          serverId,
          { includeRemoteMountId: mountId },
        );
      }
      await this.workflow.supersedePendingForResourceInTransaction(transaction, {
        serverId,
        resourceType: 'remote_fs_mount',
        resourceId: mountId,
        reason: 'A newer RemoteFS ensure intent replaced this task',
      });
      const assignment = existing ?? await this.storage.insertAssignment({
        id: uuidv4(),
        mountId,
        serverId,
        desiredState: 'ensuring',
        generation: 1,
        lastTaskId: null,
      }, transaction);
      const nextGeneration = existing ? existing.generation + 1 : 1;
      const task = await this.enqueueMountTask(
        transaction,
        mount,
        serverId,
        actorId,
        async (taskTransaction, taskId) => {
          const transitioned = await this.storage.transitionAssignment(
            assignment.id,
            assignment.generation,
            [assignment.desiredState],
            {
              desiredState: 'ensuring',
              generation: nextGeneration,
              lastTaskId: taskId,
            },
            taskTransaction,
          );
          if (!transitioned) {
            throw new ConflictException('Remote FS assignment changed; retry');
          }
        },
      );
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.AssignRemoteFsServer,
        mountId,
        'remote_fs_mount',
        { serverId, repair: Boolean(existing) },
      );
      return {
        assignment: {
          ...assignment,
          desiredState: 'ensuring' as const,
          generation: nextGeneration,
          lastTaskId: task.taskId,
        },
        taskId: task.taskId,
        created: !existing,
      };
    });
    await this.accessResolver.authorizationCommitted();
    this.proxySnapshots.invalidate(
      `RemoteFS ${mountId} assignment ensure committed on ${serverId}`,
    );
    return Object.assign(applied.assignment, { taskId: applied.taskId });
  }

  async unassignServer(
    actorId: string,
    mountId: string,
    serverId: string,
  ): Promise<{ ok: true; taskIds: string[] }> {
    const task = await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageServers],
      );
      const assignment = await this.storage.findAssignment(
        mountId,
        serverId,
        transaction,
      );
      if (!assignment) return null;
      await this.assertNotInUse(transaction, mountId, serverId);
      await this.assertRemoteDataDirsRemainReachable(
        transaction,
        mountId,
        serverId,
      );
      await this.workflow.supersedePendingForResourceInTransaction(transaction, {
        serverId,
        resourceType: 'remote_fs_mount',
        resourceId: mountId,
        reason: 'A newer RemoteFS absent intent replaced this task',
      });
      const mount = await this.storage.findRemoteFsMount(mountId, transaction);
      if (!mount) throw new NotFoundException(`Remote FS mount ${mountId} not found`);
      const nextGeneration = assignment.generation + 1;
      const task = await this.enqueueRemoveTask(
        transaction,
        mount,
        serverId,
        actorId,
        async (taskTransaction, taskId) => {
          const transitioned = await this.storage.transitionAssignment(
            assignment.id,
            assignment.generation,
            [assignment.desiredState],
            {
              desiredState: 'removing',
              generation: nextGeneration,
              lastTaskId: taskId,
            },
            taskTransaction,
          );
          if (!transitioned) {
            throw new ConflictException('Remote FS assignment changed; retry');
          }
        },
      );
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.UnassignRemoteFsServer,
        mountId,
        'remote_fs_mount',
        { serverId },
      );
      return task;
    });
    if (!task) return { ok: true, taskIds: [] };
    await this.accessResolver.authorizationCommitted();
    return { ok: true, taskIds: [task.taskId] };
  }

  async getMountStatuses(
    _mountId: string,
    serverIds: string[],
  ): Promise<Record<string, RemoteFsMountStatus>> {
    const result: Record<string, RemoteFsMountStatus> = {};
    for (const serverId of serverIds) {
      const status = this.agentGateway.stateCache
        .getRemoteFsMountStatus(serverId, _mountId);
      if (status) result[serverId] = status;
    }
    return result;
  }

  private enqueueMountTask(
    transaction: Transaction<NyabaseDatabase>,
    mount: RemoteFsMountRecord,
    serverId: string,
    requestedBy: string | null,
    persist: (
      transaction: Transaction<NyabaseDatabase>,
      taskId: string,
    ) => Promise<void>,
  ) {
    return this.workflow.enqueueInTransaction(transaction, {
      kind: AgentTaskKind.RemoteFsEnsure,
      serverId,
      resourceType: 'remote_fs_mount',
      resourceId: mount.id,
      requestedBy,
      payload: {
        id: mount.id,
        hostMountPoint: mount.hostMountPoint,
        options: mount.options,
        params: mount.params,
      },
      request: {
        scope: 'assign',
        mountId: mount.id,
        serverId,
        mount: this.mountDefinition(mount),
      },
      resourceKeys: [
        this.resourceKeys.remoteFsAssignment(serverId, mount.id),
        this.resourceKeys.mountSource({
          serverId,
          sourceKind: 'remote',
          sourceId: mount.id,
        }),
      ],
      beforeCommit: (taskTransaction, context) =>
        persist(taskTransaction, context.taskId),
    });
  }

  private enqueueRemoveTask(
    transaction: Transaction<NyabaseDatabase>,
    mount: RemoteFsMountRecord,
    serverId: string,
    requestedBy: string | null,
    persist: (
      transaction: Transaction<NyabaseDatabase>,
      taskId: string,
    ) => Promise<void>,
  ) {
    return this.workflow.enqueueInTransaction(transaction, {
      kind: AgentTaskKind.RemoteFsAbsent,
      serverId,
      resourceType: 'remote_fs_mount',
      resourceId: mount.id,
      requestedBy,
      payload: {
        id: mount.id,
        hostMountPoint: mount.hostMountPoint,
        options: mount.options,
        params: mount.params,
      },
      request: { scope: 'assignment', mountId: mount.id, serverId },
      resourceKeys: [
        this.resourceKeys.remoteFsAssignment(serverId, mount.id),
        this.resourceKeys.mountSource({
          serverId,
          sourceKind: 'remote',
          sourceId: mount.id,
        }),
      ],
      beforeCommit: (taskTransaction, context) =>
        persist(taskTransaction, context.taskId),
    });
  }

  private async assertNotInUse(
    transaction: Transaction<NyabaseDatabase>,
    mountId: string,
    serverId?: string,
  ): Promise<void> {
    if (await this.storage.hasContainerMountReference({
      serverId,
      sourceKind: 'remote',
      sourceId: mountId,
    }, transaction)) {
      throw new ConflictException('Remote FS mount is still referenced by a container');
    }
    if (!serverId && (await this.storage.listDataDirectoriesForSource(
      'remote',
      mountId,
      undefined,
      transaction,
    )).length > 0) {
      throw new ConflictException(
        'Remote FS mount still has data directories; delete those data directories first',
      );
    }
  }

  private async assertRemoteDataDirsRemainReachable(
    transaction: Transaction<NyabaseDatabase>,
    mountId: string,
    removingServerId: string,
  ): Promise<void> {
    if ((await this.storage.listDataDirectoriesForSource(
      'remote',
      mountId,
      undefined,
      transaction,
    )).length === 0) return;
    if (await this.storage.countActiveReplacementAssignments(
      mountId,
      removingServerId,
      transaction,
    ) === 0) {
      throw new ConflictException({
        code: 'REMOTE_FS_LAST_ASSIGNMENT_HAS_DATA_DIRS',
        message:
          'Keep another active server assignment until all remote data directories are deleted',
      });
    }
  }

  private async assertRepairConsumersStopped(
    transaction: Transaction<NyabaseDatabase>,
    mountId: string,
    serverId: string,
  ): Promise<void> {
    const references = await transaction.selectFrom('control.container_mounts')
      .select('container_id')
      .where('source_kind', '=', 'remote')
      .where('source_id', '=', mountId)
      .where('server_id', '=', serverId)
      .execute();
    if (references.length === 0) return;
    const snapshot = this.agentGateway.stateCache.get(serverId);
    if (!this.agentGateway.isOnline(serverId) || !snapshot?.runtimeReady) {
      throw new ConflictException(
        'Remote FS repair requires a current online inventory proving every consumer is stopped',
      );
    }
    const containerIds = [...new Set(references.map((row) => row.container_id))];
    const lifecycles = await transaction.selectFrom('control.containers')
      .select(['id', 'active_task_id', 'bound_runtime_id'])
      .where('id', 'in', containerIds)
      .execute();
    const lifecycleById = new Map(lifecycles.map((row) => [row.id, row]));
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
        || lifecycle.active_task_id !== null
        || !lifecycle.bound_runtime_id
        || !exact
        || exact.runtime.runtimeId !== lifecycle.bound_runtime_id
        || exact.status !== ContainerStatus.Exited
      ) {
        throw new ConflictException(
          `Remote FS repair requires container ${containerId} to have one current exact stopped runtime`,
        );
      }
    }
  }

  private async assertServerExists(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
  ): Promise<void> {
    if (await transaction.selectFrom('infra.servers')
      .select('id')
      .where('id', '=', serverId)
      .executeTakeFirst()) return;
    throw new NotFoundException(`Server ${serverId} not found`);
  }

  private async assertServerAssignmentCapacity(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
  ): Promise<void> {
    await this.storage.lockRemoteAssignmentCapacity(serverId, transaction);
    if (await this.storage.countAssignmentsForServer(serverId, transaction)
      < MAX_AGENT_REMOTE_FS_MOUNTS) return;
    throw new ConflictException(
      `Server ${serverId} already has the maximum ${MAX_AGENT_REMOTE_FS_MOUNTS} RemoteFS assignments`,
    );
  }

  private mountDefinition(mount: RemoteFsMountRecord): Record<string, unknown> {
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
    return { ...params, secret: this.secretCrypto.encrypt(params.secret) };
  }

  private async ensureStoredParamsEncrypted(
    mount: RemoteFsMountRecord,
  ): Promise<RemoteFsMountRecord> {
    if (mount.params.type !== RemoteFsType.CephFs) return mount;
    if (!mount.params.secret || this.secretCrypto.isEncrypted(mount.params.secret)) {
      return mount;
    }
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
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }
}
