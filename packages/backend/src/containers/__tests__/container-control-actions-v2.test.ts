import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import {
  AgentCommandKind,
  AgentCommandStatus,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  GpuGrantMode,
  OperationKind,
  OperationStatus,
  ServerStatus,
  UserStatus,
} from '@nyabase/common';
import { ContainerActionPolicyService } from '../container-action-policy.service.js';
import { ContainerControlService } from '../container-control.service.js';
import { ContainerOperationService } from '../container-operation.service.js';
import { OperationOrchestratorService } from '../../operations/operation-orchestrator.service.js';
import type { AccessResolverService } from '../../access/access-resolver.service.js';
import { AgentCommandOutboxEntity } from '../../entities/agent-command-outbox.entity.js';
import { ContainerDesiredSpecEntity } from '../../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../../entities/container-lifecycle.entity.js';
import { ContainerMountEntity } from '../../entities/container-mount.entity.js';
import { ContainerRuntimeObservationEntity } from '../../entities/container-runtime-observation.entity.js';
import { DataDiskEntity } from '../../entities/data-disk.entity.js';
import { GpuAllocationEntity } from '../../entities/gpu-allocation.entity.js';
import { ImageEntity } from '../../entities/image.entity.js';
import { OperationEntity } from '../../entities/operation.entity.js';
import { OperationStepEntity } from '../../entities/operation-step.entity.js';
import { RemoteFsMountEntity } from '../../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../../entities/remote-fs-server-assignment.entity.js';
import { RuntimeContainerEntity } from '../../entities/runtime-container.entity.js';
import { RuntimeGpuInventoryEntity } from '../../entities/runtime-gpu-inventory.entity.js';
import { ReconcileTaskEntity } from '../../entities/reconcile-task.entity.js';
import { RuntimeOrphanEntity } from '../../entities/runtime-orphan.entity.js';
import { ServerEntity } from '../../entities/server.entity.js';
import { SshPublicKeyEntity } from '../../entities/ssh-public-key.entity.js';
import { UserEntity } from '../../entities/user.entity.js';

async function makeDataSource() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    synchronize: true,
    entities: [
      ContainerEntity,
      ContainerDesiredSpecEntity,
      ContainerLifecycleEntity,
      RuntimeContainerEntity,
      RuntimeOrphanEntity,
      GpuAllocationEntity,
      ImageEntity,
      ServerEntity,
      UserEntity,
      OperationEntity,
      OperationStepEntity,
      AgentCommandOutboxEntity,
      ReconcileTaskEntity,
      DataDiskEntity,
      RuntimeGpuInventoryEntity,
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      SshPublicKeyEntity,
      ContainerRuntimeObservationEntity,
      ContainerMountEntity,
    ],
  });
  await dataSource.initialize();
  return dataSource;
}

function makeService(dataSource: DataSource, access: Partial<AccessResolverService> = {}) {
  const operation = new ContainerOperationService(dataSource, dataSource.getRepository(OperationEntity));
  return new ContainerControlService(
    dataSource,
    {
      resolveServer: async () => ({ cpuMillis: 1000, memBytes: 1024, diskBytes: 0, gpuMode: GpuGrantMode.None, gpuIndices: [] }),
      hasCapability: async () => false,
      resolveAllowedImages: async () => new Set(['image-a']),
      hasMountSourceAccess: async () => true,
      ...access,
    } as unknown as AccessResolverService,
    new ContainerActionPolicyService(),
    operation,
    dataSource.getRepository(ContainerEntity),
    dataSource.getRepository(ContainerDesiredSpecEntity),
    dataSource.getRepository(ContainerLifecycleEntity),
    dataSource.getRepository(RuntimeContainerEntity),
    dataSource.getRepository(OperationEntity),
    dataSource.getRepository(ImageEntity),
    dataSource.getRepository(ServerEntity),
    dataSource.getRepository(UserEntity),
    dataSource.getRepository(GpuAllocationEntity),
    dataSource.getRepository(RuntimeGpuInventoryEntity),
    dataSource.getRepository(DataDiskEntity),
    dataSource.getRepository(RemoteFsMountEntity),
    dataSource.getRepository(RemoteFsServerAssignmentEntity),
    dataSource.getRepository(SshPublicKeyEntity),
    dataSource.getRepository(ContainerRuntimeObservationEntity),
    {} as never,
    {} as never,
  );
}

async function seedRunnableContainer(dataSource: DataSource) {
  await dataSource.getRepository(UserEntity).save([
    { id: 'owner-a', numericId: 1001, username: 'owner', passwordHash: 'x', displayName: 'Owner', status: UserStatus.Active },
    { id: 'admin-a', numericId: 1, username: 'admin', passwordHash: 'x', displayName: 'Admin', status: UserStatus.Active },
  ]);
  await dataSource.getRepository(ServerEntity).save({
    id: 'server-a',
    name: 'srv',
    parentIface: 'eth0',
    ipCidr: '10.0.0.0/24',
    gateway: '10.0.0.1',
    agentTokenHash: 'h',
    reservedIps: [],
    isGpuServer: false,
    status: ServerStatus.Online,
    lastSeenAt: null,
    dockerRoot: null,
    dockerSocket: null,
    defaultCpuMillis: 1000,
    defaultMemBytes: 1024,
    defaultDiskBytes: 0,
    defaultGpuMode: GpuGrantMode.None,
    defaultGpuIndices: [],
  });
  await dataSource.getRepository(ImageEntity).save({ id: 'image-a', name: 'img', dockerImage: 'alpine:latest', defaultUid: 0, description: null, isActive: true });
  await dataSource.getRepository(DataDiskEntity).save({ id: 'disk-a', serverId: 'server-a', mountPoint: '/mnt/disk-a', label: null, desiredState: 'active', generation: 1, lastOperationId: null });
  await dataSource.getRepository(SshPublicKeyEntity).save({ id: 'key-a', userId: 'owner-a', name: 'main', keyText: 'ssh-ed25519 AAAA owner@example', createdAt: new Date() });
  await dataSource.getRepository(ContainerEntity).save({ id: 'container-a', serverId: 'server-a', ownerId: 'owner-a', name: 'work', imageId: 'image-a', createdBy: 'owner-a', deletedAt: null });
  await dataSource.getRepository(ContainerDesiredSpecEntity).save({
    id: 'spec-a',
    containerId: 'container-a',
    generation: 1,
    imageRef: 'alpine:latest',
    imageDefaultUid: 0,
    cpuMillis: 1000,
    memBytes: 1024,
    diskBytes: 0,
    gpuMode: 'none',
    gpuIndices: [],
    mountsJson: [{ id: 'm1', sourceKind: 'local', sourceId: 'disk-a', dirName: 'data', containerPath: '/data', createIfMissing: false }],
    sshEnabled: true,
    powerIntent: ContainerPowerIntent.Stopped,
  });
  await dataSource.getRepository(ContainerLifecycleEntity).save({ containerId: 'container-a', phase: ContainerPhase.Active, boundRuntimeId: 'runtime-a', activeOperationId: null, lastTransitionAt: new Date(), failureReason: null, failureCode: null });
  await dataSource.getRepository(RuntimeContainerEntity).save({
    id: 'server-a:runtime-a',
    serverId: 'server-a',
    runtimeId: 'runtime-a',
    containerId: 'container-a',
    ownerId: 'owner-a',
    ownerNumericId: 1001,
    status: ContainerStatus.Exited,
    specGenerationSeen: 1,
    ip: '10.0.0.2',
    labelsJson: {},
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    stale: false,
  });
}

describe('ContainerControlService V2 actions', () => {
  it('includes desired mounts and owner SSH keys when starting a stopped container', async () => {
    const dataSource = await makeDataSource();
    try {
      await seedRunnableContainer(dataSource);
      const service = makeService(dataSource);

      const ref = await service.action('container-a', 'start', 'owner-a');

      const command = await dataSource.getRepository(AgentCommandOutboxEntity).findOneByOrFail({ operationId: ref.operationId });
      expect(command).toMatchObject({ commandKind: AgentCommandKind.RuntimeContainerPower });
      expect(command.payload).toMatchObject({
        runtimeId: 'runtime-a',
        action: 'start',
        mounts: [{ sourceKind: 'local', sourceId: 'disk-a', userId: 'owner-a', dirName: 'data', hostPath: '/mnt/disk-a/data', containerPath: '/data' }],
        sshServerEnabled: true,
        sshPublicKeys: ['ssh-ed25519 AAAA owner@example'],
      });
    } finally {
      await dataSource.destroy();
    }
  });

  it('uses the container owner for admin mount updates', async () => {
    const dataSource = await makeDataSource();
    try {
      await seedRunnableContainer(dataSource);
      await dataSource.getRepository(ContainerRuntimeObservationEntity).save({
        id: 'obs-a',
        serverId: 'server-a',
        dockerId: 'runtime-a',
        containerId: 'container-a',
        reportSeq: 1,
        status: ContainerStatus.Running,
        stats: null,
        sshServer: null,
        labels: {},
        labelsValid: true,
        specGenerationSeen: 1,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        missingSince: null,
        stale: false,
      });
      const service = makeService(dataSource);

      const ref = await service.actionForAdmin('container-a', 'updateMounts', 'admin-a', [{ sourceKind: 'local', sourceId: 'disk-a', dirName: 'newdata', containerPath: '/newdata' }]);

      const command = await dataSource.getRepository(AgentCommandOutboxEntity).findOneByOrFail({ operationId: ref.operationId });
      expect(command.payload).toMatchObject({
        expected: [{ userId: 'owner-a', hostPath: '/mnt/disk-a/newdata', containerPath: '/newdata' }],
      });
      const mount = await dataSource.getRepository(ContainerMountEntity).findOneByOrFail({ containerId: 'container-a' });
      expect(mount.userId).toBe('owner-a');
    } finally {
      await dataSource.destroy();
    }
  });

  it('marks runtime rows fresh again after successful mount update operations', async () => {
    const dataSource = await makeDataSource();
    try {
      await seedRunnableContainer(dataSource);
      await dataSource.getRepository(RuntimeContainerEntity).update('server-a:runtime-a', {
        status: ContainerStatus.Running,
        stale: true,
        lastSeenAt: new Date(0),
      });
      await dataSource.getRepository(OperationEntity).save({
        id: 'operation-update-mounts',
        idempotencyKey: 'container.updateMounts:container-a:operation-update-mounts',
        kind: OperationKind.ContainerUpdateMounts,
        resourceType: 'container',
        resourceId: 'container-a',
        serverId: 'server-a',
        requestedBy: 'owner-a',
        status: OperationStatus.WaitingAgent,
        request: {},
        result: null,
        lastError: null,
        attempts: 1,
        startedAt: new Date(),
        completedAt: null,
      });
      await dataSource.getRepository(AgentCommandOutboxEntity).save({
        id: 'command-update-mounts',
        operationId: 'operation-update-mounts',
        operationStepId: null,
        serverId: 'server-a',
        resourceKey: 'container:container-a',
        commandKind: AgentCommandKind.RuntimeContainerMountsApply,
        idempotencyKey: 'runtime.container.mounts.apply:container-a:operation-update-mounts',
        desiredGeneration: null,
        payload: { runtimeId: 'runtime-a' },
        status: AgentCommandStatus.Sent,
        attempts: 1,
        lastError: null,
        nextAttemptAt: null,
        leaseHolderId: null,
        leaseExpiresAt: null,
        sentAt: new Date(),
        completedAt: null,
      });
      const orchestrator = new OperationOrchestratorService(
        dataSource,
        dataSource.getRepository(OperationEntity),
        dataSource.getRepository(OperationStepEntity),
        dataSource.getRepository(AgentCommandOutboxEntity),
        dataSource.getRepository(ReconcileTaskEntity),
      );

      await orchestrator.markCommandSucceeded(
        await dataSource.getRepository(AgentCommandOutboxEntity).findOneByOrFail({ id: 'command-update-mounts' }),
        { current: [] },
      );

      await expect(dataSource.getRepository(RuntimeContainerEntity).findOneByOrFail({ id: 'server-a:runtime-a' }))
        .resolves.toMatchObject({ stale: false, status: ContainerStatus.Running });
    } finally {
      await dataSource.destroy();
    }
  });

  it('persists SSH reconcile result immediately after successful SSH operations', async () => {
    const dataSource = await makeDataSource();
    try {
      await seedRunnableContainer(dataSource);
      await dataSource.getRepository(ContainerDesiredSpecEntity).update({ containerId: 'container-a' }, {
        sshEnabled: false,
      });
      await dataSource.getRepository(ContainerRuntimeObservationEntity).save({
        id: 'obs-a',
        serverId: 'server-a',
        dockerId: 'runtime-a',
        containerId: 'container-a',
        reportSeq: 1,
        status: ContainerStatus.Running,
        stats: null,
        sshServer: { enabled: false, status: 'disabled', user: 'root', port: 22 },
        labels: {},
        labelsValid: true,
        specGenerationSeen: 1,
        firstSeenAt: new Date(0),
        lastSeenAt: new Date(0),
        missingSince: null,
        stale: false,
      });
      await dataSource.getRepository(OperationEntity).save({
        id: 'operation-enable-ssh',
        idempotencyKey: 'container.enableSsh:container-a:operation-enable-ssh',
        kind: OperationKind.ContainerEnableSsh,
        resourceType: 'container',
        resourceId: 'container-a',
        serverId: 'server-a',
        requestedBy: 'owner-a',
        status: OperationStatus.WaitingAgent,
        request: {},
        result: null,
        lastError: null,
        attempts: 1,
        startedAt: new Date(),
        completedAt: null,
      });
      await dataSource.getRepository(AgentCommandOutboxEntity).save({
        id: 'command-enable-ssh',
        operationId: 'operation-enable-ssh',
        operationStepId: null,
        serverId: 'server-a',
        resourceKey: 'container:container-a',
        commandKind: AgentCommandKind.RuntimeContainerSshApply,
        idempotencyKey: 'runtime.container.ssh.apply:container-a:operation-enable-ssh',
        desiredGeneration: null,
        payload: { containerId: 'container-a', runtimeId: 'runtime-a', publicKeys: ['ssh-ed25519 AAAA owner@example'] },
        status: AgentCommandStatus.Sent,
        attempts: 1,
        lastError: null,
        nextAttemptAt: null,
        leaseHolderId: null,
        leaseExpiresAt: null,
        sentAt: new Date(),
        completedAt: null,
      });
      const orchestrator = new OperationOrchestratorService(
        dataSource,
        dataSource.getRepository(OperationEntity),
        dataSource.getRepository(OperationStepEntity),
        dataSource.getRepository(AgentCommandOutboxEntity),
        dataSource.getRepository(ReconcileTaskEntity),
      );

      await orchestrator.markCommandSucceeded(
        await dataSource.getRepository(AgentCommandOutboxEntity).findOneByOrFail({ id: 'command-enable-ssh' }),
        { enabled: true, status: 'running', user: 'root', port: 22, pid: 42, keyHash: 'abc' },
      );

      const service = makeService(dataSource);
      await expect(service.get('container-a', 'owner-a')).resolves.toMatchObject({
        ssh: { enabled: true, status: 'running', user: 'root', port: 22, pid: 42, keyHash: 'abc' },
      });
    } finally {
      await dataSource.destroy();
    }
  });


  it('releases reserved GPU allocation when create command fails', async () => {
    const dataSource = await makeDataSource();
    try {
      await seedRunnableContainer(dataSource);
      await dataSource.getRepository(ContainerLifecycleEntity).update('container-a', { phase: ContainerPhase.Provisioning, boundRuntimeId: null });
      await dataSource.getRepository(GpuAllocationEntity).save({ containerId: 'container-a', serverId: 'server-a', gpuIndicesJson: [0], allocatedAt: new Date() });
      await dataSource.getRepository(OperationEntity).save({
        id: 'operation-create',
        idempotencyKey: 'container.create:container-a:operation-create',
        kind: OperationKind.ContainerCreate,
        resourceType: 'container',
        resourceId: 'container-a',
        serverId: 'server-a',
        requestedBy: 'owner-a',
        status: OperationStatus.WaitingAgent,
        request: {},
        result: null,
        lastError: null,
        attempts: 1,
        startedAt: new Date(),
        completedAt: null,
      });
      await dataSource.getRepository(AgentCommandOutboxEntity).save({
        id: 'command-create',
        operationId: 'operation-create',
        operationStepId: null,
        serverId: 'server-a',
        resourceKey: 'container:container-a',
        commandKind: AgentCommandKind.RuntimeContainerCreate,
        idempotencyKey: 'runtime.container.create:container-a:operation-create',
        desiredGeneration: null,
        payload: {},
        status: AgentCommandStatus.Sent,
        attempts: 1,
        lastError: null,
        nextAttemptAt: null,
        leaseHolderId: null,
        leaseExpiresAt: null,
        sentAt: new Date(),
        completedAt: null,
      });
      const orchestrator = new OperationOrchestratorService(
        dataSource,
        dataSource.getRepository(OperationEntity),
        dataSource.getRepository(OperationStepEntity),
        dataSource.getRepository(AgentCommandOutboxEntity),
        dataSource.getRepository(ReconcileTaskEntity),
      );

      await orchestrator.markCommandFailed(
        await dataSource.getRepository(AgentCommandOutboxEntity).findOneByOrFail({ id: 'command-create' }),
        new Error('agent create failed'),
      );

      expect(await dataSource.getRepository(GpuAllocationEntity).count()).toBe(0);
      const lifecycle = await dataSource.getRepository(ContainerLifecycleEntity).findOneByOrFail({ containerId: 'container-a' });
      expect(lifecycle.phase).toBe(ContainerPhase.Failed);
      expect(lifecycle.failureReason).toContain('agent create failed');
    } finally {
      await dataSource.destroy();
    }
  });

  it('locally deletes failed unbound containers and clears GPU allocations', async () => {
    const dataSource = await makeDataSource();
    try {
      await seedRunnableContainer(dataSource);
      await dataSource.getRepository(ContainerLifecycleEntity).update('container-a', { phase: ContainerPhase.Failed, boundRuntimeId: null });
      await dataSource.getRepository(GpuAllocationEntity).save({ containerId: 'container-a', serverId: 'server-a', gpuIndicesJson: [0], allocatedAt: new Date() });
      const service = makeService(dataSource);

      const ref = await service.action('container-a', 'delete', 'owner-a');

      expect(ref.status).toBe(OperationStatus.Succeeded);
      const lifecycle = await dataSource.getRepository(ContainerLifecycleEntity).findOneByOrFail({ containerId: 'container-a' });
      expect(lifecycle.phase).toBe(ContainerPhase.Deleted);
      expect(await dataSource.getRepository(AgentCommandOutboxEntity).count()).toBe(0);
      expect(await dataSource.getRepository(GpuAllocationEntity).count()).toBe(0);
      const container = await dataSource.getRepository(ContainerEntity).findOneByOrFail({ id: 'container-a' });
      expect(container.deletedAt).toBeInstanceOf(Date);
    } finally {
      await dataSource.destroy();
    }
  });
});
