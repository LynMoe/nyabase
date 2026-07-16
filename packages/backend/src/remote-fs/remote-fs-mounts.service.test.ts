import {
  AgentTaskKind,
  AgentTaskStatus,
  ContainerPhase,
  ContainerStatus,
  LABEL,
  MAX_AGENT_REMOTE_FS_MOUNTS,
  RemoteFsType,
  ServerStatus,
} from '@nyabase/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessResolverService } from '../access/access-resolver.service.js';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { AgentTaskFinalizerService } from '../agent-tasks/agent-task-finalizer.service.js';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { ResourceLockService } from '../agent-tasks/resource-lock.service.js';
import type { AuditService } from '../audit/audit.service.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import type { AgentGateway } from '../gateway/agent-gateway.js';
import type { RemoteFsSecretCryptoService } from './remote-fs-secret-crypto.service.js';
import { RemoteFsMountsService } from './remote-fs-mounts.service.js';

describe('RemoteFsMountsService control-plane invariants', () => {
  let dataSource: DataSource;
  let service: RemoteFsMountsService;
  let keys: ResourceKeyService;
  let finalizer: AgentTaskFinalizerService;
  let agentGateway: {
    isOnline: ReturnType<typeof vi.fn>;
    stateCache: {
      get: ReturnType<typeof vi.fn>;
      getRemoteFsMountStatus: ReturnType<typeof vi.fn>;
    };
  };
  let proxySnapshots: { invalidate: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        RemoteFsMountEntity,
        RemoteFsServerAssignmentEntity,
        ContainerMountEntity,
        ContainerEntity,
        ContainerLifecycleEntity,
        DataDirectoryEntity,
        ImageEntity,
        MountSourceGrantEntity,
        AgentTaskEntity,
        ResourceLockEntity,
        ServerEntity,
      ],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save([
      server('server-a'),
      server('server-b'),
    ]);
    keys = new ResourceKeyService();
    const locks = new ResourceLockService(dataSource.getRepository(ResourceLockEntity));
    const tasks = new AgentTasksService(
      dataSource,
      keys,
      locks,
      {
        forWirePayload: (_kind: AgentTaskKind, payload: unknown) => payload,
        forDispatch: (task: AgentTaskEntity) => task.payloadJson,
      } as AgentTaskPayloadCodecService,
      dataSource.getRepository(AgentTaskEntity),
    );
    const access = { invalidateAll: vi.fn() } as unknown as AccessResolverService;
    agentGateway = {
      isOnline: vi.fn().mockReturnValue(true),
      stateCache: {
        get: vi.fn().mockReturnValue({ runtimeReady: true, containers: new Map() }),
        getRemoteFsMountStatus: vi.fn(),
      },
    };
    proxySnapshots = { invalidate: vi.fn() };
    finalizer = new AgentTaskFinalizerService();
    service = new RemoteFsMountsService(
      dataSource.getRepository(RemoteFsMountEntity),
      dataSource.getRepository(RemoteFsServerAssignmentEntity),
      dataSource.getRepository(ContainerMountEntity),
      dataSource.getRepository(DataDirectoryEntity),
      { log: vi.fn() } as unknown as AuditService,
      access,
      dataSource,
      tasks,
      keys,
      agentGateway as unknown as AgentGateway,
      {
        encrypt: (value: string) => `rfs-v1.test.test.${value}`,
        isEncrypted: (value: string) => value.startsWith('rfs-v1.'),
      } as RemoteFsSecretCryptoService,
      { deleteSourceInTransaction: vi.fn((manager, target) => manager.delete(
        MountSourceGrantEntity,
        target,
      )) } as never,
      proxySnapshots as never,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('does not let an offline assignment block the same mount on another server', async () => {
    const mount = await createMount();

    const [first, second] = await Promise.allSettled([
      service.assignServer('actor-a', mount.id, 'server-a'),
      service.assignServer('actor-a', mount.id, 'server-b'),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');
    expect(await dataSource.getRepository(RemoteFsServerAssignmentEntity).find()).toHaveLength(2);
    expect(await dataSource.getRepository(AgentTaskEntity).find()).toHaveLength(2);
    const locks = await dataSource.getRepository(ResourceLockEntity).find();
    expect(locks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceKey: keys.remoteFsAssignment('server-a', mount.id),
      }),
      expect.objectContaining({
        resourceKey: keys.remoteFsAssignment('server-b', mount.id),
      }),
      expect.objectContaining({
        resourceKey: keys.mountSource({
          serverId: 'server-a', sourceKind: 'remote', sourceId: mount.id,
        }),
      }),
      expect.objectContaining({
        resourceKey: keys.mountSource({
          serverId: 'server-b', sourceKind: 'remote', sourceId: mount.id,
        }),
      }),
    ]));
  });

  it('derives an immutable physical path and permits metadata-only edits', async () => {
    const mount = await createMount();
    await service.assignServer('actor-a', mount.id, 'server-a');

    const renamed = await service.update('actor-a', mount.id, { displayName: 'Renamed' });
    expect(renamed).toMatchObject({
      displayName: 'Renamed',
      hostMountPoint: `/mnt/remote-fs/${mount.id}`,
      generation: mount.generation,
      taskIds: [],
    });
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(1);
  });

  it('lets a newer assign intent supersede an unresolved removal', async () => {
    const mount = await createMount();
    const assigned = await service.assignServer('actor-a', mount.id, 'server-a');
    await terminalizeTask(assigned.taskId!, AgentTaskStatus.Succeeded);

    const firstRemove = await service.unassignServer('actor-a', mount.id, 'server-a');
    const firstRemoveTaskId = firstRemove.taskIds[0]!;
    await terminalizeTask(firstRemoveTaskId, AgentTaskStatus.Failed);

    const repair = await service.assignServer('actor-a', mount.id, 'server-a');
    expect(repair.taskId).not.toBe(firstRemoveTaskId);
    expect(await dataSource.getRepository(RemoteFsServerAssignmentEntity).findOneByOrFail({
      remoteFsMountId: mount.id,
      serverId: 'server-a',
    })).toMatchObject({
      desiredState: 'ensuring',
      lastTaskId: repair.taskId,
    });
  });

  it('requires successful unassignment before deleting the global mount object', async () => {
    const mount = await createMount();
    const assigned = await service.assignServer('actor-a', mount.id, 'server-a');

    await expect(service.remove('actor-a', mount.id))
      .rejects.toThrow(/Unassign every server successfully/);

    await terminalizeTask(assigned.taskId!, AgentTaskStatus.Succeeded);
    await dataSource.getRepository(RemoteFsServerAssignmentEntity).delete({
      remoteFsMountId: mount.id,
      serverId: 'server-a',
    });
    await expect(service.remove('actor-a', mount.id)).resolves.toEqual({ ok: true, taskIds: [] });
    expect(await dataSource.getRepository(RemoteFsMountEntity).findOneBy({ id: mount.id })).toBeNull();
  });

  it('finalizes assignment removal without implicitly deleting the global mount', async () => {
    const mount = await createMount();
    const assigned = await service.assignServer('actor-a', mount.id, 'server-a');
    await terminalizeTask(assigned.taskId!, AgentTaskStatus.Succeeded);
    const removed = await service.unassignServer('actor-a', mount.id, 'server-a');
    const task = await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({
      id: removed.taskIds[0],
    });

    await dataSource.transaction((manager) => finalizer.applySucceeded(manager, task, { id: mount.id }));

    expect(await dataSource.getRepository(RemoteFsServerAssignmentEntity).countBy({
      remoteFsMountId: mount.id,
    })).toBe(0);
    expect(await dataSource.getRepository(RemoteFsMountEntity).findOneBy({ id: mount.id }))
      .toMatchObject({ id: mount.id, desiredState: 'active' });
  });

  it('refuses to finalize ensure evidence against a changed physical generation', async () => {
    const mount = await createMount();
    const assigned = await service.assignServer('actor-a', mount.id, 'server-a');
    const task = await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: assigned.taskId });
    await dataSource.getRepository(RemoteFsMountEntity).update(mount.id, {
      hostMountPoint: '/mnt/remote-fs/tampered',
      generation: mount.generation + 1,
    });

    await expect(dataSource.transaction((manager) =>
      finalizer.applySucceeded(manager, task, {
        id: mount.id,
        hostMountPoint: mount.hostMountPoint,
      }))).rejects.toThrow(/generation or physical spec changed/);
    expect(await dataSource.getRepository(RemoteFsServerAssignmentEntity).findOneByOrFail({
      remoteFsMountId: mount.id,
      serverId: 'server-a',
    })).toMatchObject({ lastTaskId: task.id });
  });

  it('rejects multi-server create instead of creating an implicit task group', async () => {
    await expect(service.create('actor-a', {
      ...mountInput(),
      serverIds: ['server-a', 'server-b'],
    })).rejects.toThrow(/at most one server/);
    expect(await dataSource.getRepository(RemoteFsMountEntity).count()).toBe(0);
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(0);
  });

  it('does not create a dangling assignment for a missing server', async () => {
    const mount = await createMount();

    await expect(service.assignServer('actor-a', mount.id, 'server-missing'))
      .rejects.toThrow(/Server server-missing not found/);

    expect(await dataSource.getRepository(RemoteFsServerAssignmentEntity).count()).toBe(0);
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(0);
  });

  it('rejects a new assignment once the server bootstrap capacity is full', async () => {
    const candidate = await createMount();
    const now = new Date();
    const mounts = Array.from({ length: MAX_AGENT_REMOTE_FS_MOUNTS }, (_, index) => ({
      id: `capacity-${index}`,
      name: `capacity-${index}`,
      displayName: null,
      description: null,
      type: RemoteFsType.Nfs,
      hostMountPoint: `/mnt/remote-fs/capacity-${index}`,
      options: '',
      params: {
        type: RemoteFsType.Nfs as RemoteFsType.Nfs,
        nfsServer: 'nfs.internal',
        exportPath: `/capacity-${index}`,
        version: '4.2' as const,
      },
      desiredState: 'active' as const,
      generation: 1,
      lastTaskId: null,
      createdAt: now,
      updatedAt: now,
    }));
    await dataSource.getRepository(RemoteFsMountEntity).save(mounts);
    await dataSource.getRepository(RemoteFsServerAssignmentEntity).save(
      mounts.map((mount, index) => ({
        id: `assignment-${index}`,
        remoteFsMountId: mount.id,
        serverId: 'server-a',
        desiredState: 'active' as const,
        generation: 1,
        lastTaskId: null,
        createdAt: now,
        updatedAt: now,
      })),
    );

    await expect(service.assignServer('actor-a', candidate.id, 'server-a'))
      .rejects.toThrow(`maximum ${MAX_AGENT_REMOTE_FS_MOUNTS} RemoteFS assignments`);
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(0);
  });

  it('rejects repair with a running consumer, then permits one exact stopped consumer under the mount-source lock', async () => {
    const mount = await createMount();
    const assigned = await service.assignServer('actor-a', mount.id, 'server-a');
    const ensureTask = await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({
      id: assigned.taskId,
    });
    await dataSource.transaction((manager) => finalizer.applySucceeded(manager, ensureTask, {
      id: mount.id,
      hostMountPoint: mount.hostMountPoint,
    }));
    await terminalizeTask(assigned.taskId!, AgentTaskStatus.Succeeded);

    await dataSource.getRepository(ImageEntity).save({
      id: 'image-a',
      name: 'image-a',
      dockerImage: 'image:a',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      description: null,
      isActive: true,
      disableSsh: false,
    });
    await dataSource.getRepository(ContainerEntity).save({
      id: 'container-a',
      serverId: 'server-a',
      ownerId: 'user-a',
      name: 'work',
      imageId: 'image-a',
      createdBy: 'user-a',
    });
    await dataSource.getRepository(ContainerLifecycleEntity).save({
      containerId: 'container-a',
      phase: ContainerPhase.Active,
      boundRuntimeId: 'runtime-a',
      quotaPathsJson: [],
      runtimeSpecHash: 'a'.repeat(64),
      activeTaskId: null,
      lastTransitionAt: new Date(),
      failureReason: null,
      failureCode: null,
    });
    await dataSource.getRepository(ContainerMountEntity).save({
      id: 'container-mount-a',
      serverId: 'server-a',
      containerId: 'container-a',
      containerName: 'work',
      sourceKind: 'remote',
      sourceId: mount.id,
      sourceIdentity: `remote:${mount.id}`,
      userId: 'user-a',
      dirName: 'data',
      containerPath: '/data',
    });
    const runtime = (status: ContainerStatus) => ({
      runtime: { runtimeId: 'runtime-a' },
      status,
      labels: { [LABEL.CONTAINER_ID]: 'container-a' },
    });
    agentGateway.stateCache.get.mockReturnValue({
      runtimeReady: true,
      containers: new Map([['runtime-a', runtime(ContainerStatus.Running)]]),
    });
    proxySnapshots.invalidate.mockClear();

    await expect(service.assignServer('actor-a', mount.id, 'server-a'))
      .rejects.toThrow('one current exact stopped runtime');
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(1);
    expect(await dataSource.getRepository(RemoteFsServerAssignmentEntity).findOneByOrFail({
      remoteFsMountId: mount.id,
      serverId: 'server-a',
    })).toMatchObject({ desiredState: 'active' });
    expect(proxySnapshots.invalidate).not.toHaveBeenCalled();

    agentGateway.stateCache.get.mockReturnValue({
      runtimeReady: true,
      containers: new Map([['runtime-a', runtime(ContainerStatus.Exited)]]),
    });
    const repair = await service.assignServer('actor-a', mount.id, 'server-a');
    expect(repair.taskId).toBeTruthy();
    expect(await dataSource.getRepository(ResourceLockEntity).findOneBy({
      taskId: repair.taskId,
      resourceKey: keys.mountSource({
        serverId: 'server-a', sourceKind: 'remote', sourceId: mount.id,
      }),
    })).not.toBeNull();
    expect(proxySnapshots.invalidate).toHaveBeenCalledOnce();
  });

  async function createMount(): Promise<RemoteFsMountEntity> {
    return service.create('actor-a', mountInput());
  }

  async function terminalizeTask(taskId: string, status: AgentTaskStatus): Promise<void> {
    await dataSource.getRepository(AgentTaskEntity).update(taskId, {
      status,
      completedAt: new Date(),
    });
    await dataSource.getRepository(ResourceLockEntity).delete({ taskId });
  }
});

function mountInput() {
  return {
    name: 'remote-a',
    type: RemoteFsType.Nfs,
    params: {
      type: RemoteFsType.Nfs,
      nfsServer: 'nfs.example',
      exportPath: '/data',
      version: '4.2' as const,
    },
  } as const;
}

function server(id: string) {
  return {
    id,
    name: id,
    slug: id,
    agentTokenHash: `hash-${id}`,
    hostFingerprint: null,
    status: ServerStatus.Unknown,
    lastSeenAt: null,
  };
}
