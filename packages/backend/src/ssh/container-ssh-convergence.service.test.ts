import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentTaskKind,
  AgentTaskStatus,
  ContainerPhase,
  ContainerStatus,
  ServerStatus,
} from '@nyabase/common';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { ResourceLockService } from '../agent-tasks/resource-lock.service.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { ContainerSshConvergenceService } from './container-ssh-convergence.service.js';

const HOST_FINGERPRINT = 'SHA256:UCUiLr7Pjs9wFFJMDByLgc3NrtdU344OgUM45wZPcIQ';

describe('ContainerSshConvergenceService', () => {
  let dataSource: DataSource;
  let service: ContainerSshConvergenceService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        ServerEntity,
        AgentTaskEntity,
        ResourceLockEntity,
        ContainerEntity,
        ContainerLifecycleEntity,
        ContainerSshRouteEntity,
        ImageEntity,
        UserInternalSshKeyEntity,
      ],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save({
      id: 'server-a', name: 'Server A', slug: 'server-a', agentTokenHash: 'token-a',
      hostFingerprint: null, agentConfigFingerprint: null,
      status: ServerStatus.Unknown, lastSeenAt: null,
    });
    const keys = new ResourceKeyService();
    const tasks = new AgentTasksService(
      dataSource,
      keys,
      new ResourceLockService(dataSource.getRepository(ResourceLockEntity)),
      {
        forWirePayload: (_kind: AgentTaskKind, payload: unknown) => payload,
        forDispatch: (task: AgentTaskEntity) => task.payloadJson,
      } as AgentTaskPayloadCodecService,
      dataSource.getRepository(AgentTaskEntity),
    );
    service = new ContainerSshConvergenceService(dataSource, tasks, keys);

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
    await dataSource.getRepository(UserInternalSshKeyEntity).save({
      userId: 'user-a',
      encryptedPrivateKey: 'private-2',
      publicKey: 'public-2',
      fingerprint: 'fingerprint-2',
      generation: 2,
      rotatedAt: new Date(),
    });
    await dataSource.getRepository(ContainerSshRouteEntity).save({
      containerId: 'container-a',
      serverId: 'server-a',
      runtimeId: 'runtime-a',
      macvlanIp: '10.0.0.2',
      runtimeStatus: ContainerStatus.Running,
      sshStatus: 'running',
      appliedInternalKeyGeneration: 1,
      containerHostKeyFingerprint: HOST_FINGERPRINT,
      lastError: null,
      observedAt: new Date(),
    });
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('defers a busy container and converges it on the next full-report pass', async () => {
    await saveLifecycle(ContainerPhase.Updating, 'busy-task');

    await service.reconcileServer('server-a');
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(0);

    await dataSource.getRepository(ContainerLifecycleEntity).update('container-a', {
      phase: ContainerPhase.Active,
      activeTaskId: null,
    });
    await service.reconcileServer('server-a');

    const task = await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({
      status: AgentTaskStatus.Pending,
    });
    expect(task).toMatchObject({
      kind: AgentTaskKind.ContainerSshEnsure,
      serverId: 'server-a',
      resourceId: 'container-a',
      payloadJson: {
        containerId: 'container-a',
        runtimeId: 'runtime-a',
        enabled: true,
        internalPublicKey: 'public-2',
        internalKeyGeneration: 2,
      },
    });
    expect(await dataSource.getRepository(ContainerLifecycleEntity).findOneByOrFail({
      containerId: 'container-a',
    })).toMatchObject({
      phase: ContainerPhase.Updating,
      activeTaskId: task.id,
    });

    await service.reconcileServer('server-a');
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(1);
  });

  it('does not enqueue for a stopped runtime and recovers after a later running report', async () => {
    await saveLifecycle(ContainerPhase.Active, null);
    await dataSource.getRepository(ContainerSshRouteEntity).update('container-a', {
      runtimeStatus: ContainerStatus.Exited,
      sshStatus: 'container_stopped',
    });

    await service.reconcileServer('server-a');
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(0);

    await dataSource.getRepository(ContainerSshRouteEntity).update('container-a', {
      runtimeStatus: ContainerStatus.Running,
      sshStatus: 'running',
    });
    await service.reconcileServer('server-a');
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(1);
  });

  it('keeps one broken container fail-closed without blocking convergence for its peers', async () => {
    await saveLifecycle(ContainerPhase.Active, null);
    await dataSource.getRepository(ContainerEntity).save({
      id: 'container-b',
      serverId: 'server-a',
      ownerId: 'user-without-key',
      name: 'broken',
      imageId: 'image-a',
      createdBy: 'user-without-key',
    });
    await dataSource.getRepository(ContainerLifecycleEntity).save({
      containerId: 'container-b',
      phase: ContainerPhase.Active,
      boundRuntimeId: 'runtime-b',
      quotaPathsJson: [],
      activeTaskId: null,
      lastTransitionAt: new Date(),
      failureReason: null,
      failureCode: null,
    });
    await dataSource.getRepository(ContainerSshRouteEntity).save({
      containerId: 'container-b',
      serverId: 'server-a',
      runtimeId: 'runtime-b',
      macvlanIp: '10.0.0.3',
      runtimeStatus: ContainerStatus.Running,
      sshStatus: 'running',
      appliedInternalKeyGeneration: 1,
      containerHostKeyFingerprint: HOST_FINGERPRINT,
      lastError: null,
      observedAt: new Date(),
    });

    await expect(service.reconcileServer('server-a')).resolves.toBeUndefined();

    const tasks = await dataSource.getRepository(AgentTaskEntity).find();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: AgentTaskKind.ContainerSshEnsure,
      resourceId: 'container-a',
    });
  });

  async function saveLifecycle(phase: ContainerPhase, activeTaskId: string | null): Promise<void> {
    await dataSource.getRepository(ContainerLifecycleEntity).save({
      containerId: 'container-a',
      phase,
      boundRuntimeId: 'runtime-a',
      quotaPathsJson: [],
      activeTaskId,
      lastTransitionAt: new Date(),
      failureReason: null,
      failureCode: null,
    });
  }
});
