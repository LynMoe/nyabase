import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AgentCommandKind,
  AgentCommandStatus,
  ContainerPhase,
  ContainerPowerIntent,
  GpuGrantMode,
  ServerStatus,
  UserStatus,
} from '@nyabase/common';
import { ContainerActionPolicyService } from '../container-action-policy.service.js';
import { ContainerControlService } from '../container-control.service.js';
import { ContainerOperationService } from '../container-operation.service.js';
import { AccessResolverService } from '../../access/access-resolver.service.js';
import { AgentCommandOutboxEntity } from '../../entities/agent-command-outbox.entity.js';
import { ContainerDesiredSpecEntity } from '../../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../../entities/container-lifecycle.entity.js';
import { GpuAllocationEntity } from '../../entities/gpu-allocation.entity.js';
import { ImageEntity } from '../../entities/image.entity.js';
import { OperationEntity } from '../../entities/operation.entity.js';
import { OperationStepEntity } from '../../entities/operation-step.entity.js';
import { RuntimeContainerEntity } from '../../entities/runtime-container.entity.js';
import { RuntimeOrphanEntity } from '../../entities/runtime-orphan.entity.js';
import { ServerEntity } from '../../entities/server.entity.js';
import { UserEntity } from '../../entities/user.entity.js';
import { DataDiskEntity } from '../../entities/data-disk.entity.js';
import { RuntimeGpuInventoryEntity } from '../../entities/runtime-gpu-inventory.entity.js';
import { RemoteFsMountEntity } from '../../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../../entities/remote-fs-server-assignment.entity.js';
import { SshPublicKeyEntity } from '../../entities/ssh-public-key.entity.js';
import { ContainerRuntimeObservationEntity } from '../../entities/container-runtime-observation.entity.js';
import { ContainerMountEntity } from '../../entities/container-mount.entity.js';
import type { ResolvedServerGrant } from '../../access/access-resolver.service.js';

const ENTITIES = [
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
  DataDiskEntity,
  RuntimeGpuInventoryEntity,
  RemoteFsMountEntity,
  RemoteFsServerAssignmentEntity,
  SshPublicKeyEntity,
  ContainerRuntimeObservationEntity,
  ContainerMountEntity,
];

async function makeDataSource() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    synchronize: true,
    entities: ENTITIES,
  });
  await dataSource.initialize();
  return dataSource;
}

function makeGrant(overrides: Partial<ResolvedServerGrant> = {}): ResolvedServerGrant {
  return {
    cpuMillis: 2000,
    memBytes: 4 * 1024 ** 3,
    diskBytes: 0,
    gpuMode: GpuGrantMode.None,
    gpuIndices: [],
    ...overrides,
  };
}

async function seedBase(dataSource: DataSource, options: {
  grant?: Partial<ResolvedServerGrant>;
  server?: Partial<ServerEntity>;
  userId?: string;
  imageId?: string;
} = {}) {
  const userId = options.userId ?? 'user-a';
  const imageId = options.imageId ?? 'image-a';
  const grant = makeGrant(options.grant);
  await dataSource.getRepository(UserEntity).save({
    id: userId,
    numericId: 1001,
    username: userId,
    passwordHash: 'x',
    displayName: userId,
    status: UserStatus.Active,
  });
  await dataSource.getRepository(ServerEntity).save({
    id: 'server-a',
    name: 'srv',
    parentIface: 'eth0',
    ipCidr: '10.0.0.0/24',
    gateway: '10.0.0.1',
    agentTokenHash: 'h',
    reservedIps: ['10.0.0.2'],
    isGpuServer: grant.gpuMode !== GpuGrantMode.None,
    status: ServerStatus.Online,
    lastSeenAt: null,
    dockerRoot: null,
    dockerSocket: null,
    defaultCpuMillis: grant.cpuMillis,
    defaultMemBytes: grant.memBytes,
    defaultDiskBytes: grant.diskBytes,
    defaultGpuMode: grant.gpuMode,
    defaultGpuIndices: grant.gpuIndices,
    ...options.server,
  });
  await dataSource.getRepository(ImageEntity).save({
    id: imageId,
    name: 'img',
    dockerImage: 'alpine:latest',
    defaultUid: 1000,
    runtimeOverrides: {
      uid: 1000,
      entrypoint: ['/entrypoint'],
      cmd: ['sleep', 'infinity'],
      init: true,
    },
    description: null,
    isActive: true,
  });
  return { userId, imageId, grant };
}

function makeService(dataSource: DataSource, grant: ResolvedServerGrant, imageId = 'image-a') {
  const access = {
    resolveServer: async () => grant,
    hasCapability: async () => false,
    resolveAllowedImages: async () => new Set([imageId]),
    hasMountSourceAccess: async () => true,
  } as unknown as AccessResolverService;
  const operation = new ContainerOperationService(dataSource, dataSource.getRepository(OperationEntity));
  return new ContainerControlService(
    dataSource,
    access,
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

async function createdCommand(dataSource: DataSource, operationId: string) {
  return dataSource.getRepository(AgentCommandOutboxEntity).findOneByOrFail({ operationId });
}

describe('ContainerControlService V2 create', () => {
  it('persists desired/control rows and enqueues agent create payload with grant CPU and memory', async () => {
    const dataSource = await makeDataSource();
    try {
      const { userId, imageId, grant } = await seedBase(dataSource, {
        grant: { cpuMillis: 500, memBytes: 1024, diskBytes: 2048 },
      });
      await dataSource.getRepository(DataDiskEntity).save({
        id: 'disk-a',
        serverId: 'server-a',
        mountPoint: '/mnt/disk-a',
        label: null,
        desiredState: 'active',
        generation: 1,
        lastOperationId: null,
      });
      await dataSource.getRepository(SshPublicKeyEntity).save({
        id: 'key-a',
        userId,
        name: 'main',
        keyText: 'ssh-ed25519 AAAA user@example',
        createdAt: new Date(),
      });
      const service = makeService(dataSource, grant, imageId);

      const ref = await service.create(userId, {
        serverId: 'server-a',
        imageId,
        name: 'work',
        dataDirs: [{
          sourceKind: 'local',
          sourceId: 'disk-a',
          dirName: 'data',
          containerPath: '/data',
          createIfMissing: true,
        }],
        sshServerEnabled: true,
      });

      const command = await createdCommand(dataSource, ref.operationId);
      expect(command).toMatchObject({
        commandKind: AgentCommandKind.RuntimeContainerCreate,
        status: AgentCommandStatus.Pending,
      });
      expect(command.payload).toMatchObject({
        ownerId: userId,
        numericOwnerId: 1001,
        imageDockerRef: 'alpine:latest',
        imageId,
        name: 'work',
        cpuMillis: 500,
        memBytes: 1024,
        gpuIndices: [],
        ipCidr: '10.0.0.0/24',
        gateway: '10.0.0.1',
        reservedIps: ['10.0.0.2'],
        runtimeOverrides: {
          uid: 1000,
          entrypoint: ['/entrypoint'],
          cmd: ['sleep', 'infinity'],
          init: true,
        },
        sshServerEnabled: true,
        sshPublicKeys: ['ssh-ed25519 AAAA user@example'],
        createDirs: [{ sourceKind: 'local', sourceId: 'disk-a', dirName: 'data', createIfMissing: true, ownerUid: 1000 }],
        mounts: [{ sourceKind: 'local', sourceId: 'disk-a', userId, dirName: 'data', containerPath: '/data', hostPath: '/mnt/disk-a/data' }],
      });
      const desired = await dataSource.getRepository(ContainerDesiredSpecEntity).findOneByOrFail({
        containerId: (command.payload as { containerId: string }).containerId,
      });
      expect(desired).toMatchObject({
        imageDefaultUid: 1000,
        imageRuntimeOverrides: {
          uid: 1000,
          entrypoint: ['/entrypoint'],
          cmd: ['sleep', 'infinity'],
          init: true,
        },
        cpuMillis: 500,
        memBytes: 1024,
        diskBytes: 2048,
        gpuIndices: [],
      });
    } finally {
      await dataSource.destroy();
    }
  });

  it('allows another full-grant container when existing containers already use CPU and memory', async () => {
    const dataSource = await makeDataSource();
    try {
      const { userId, imageId, grant } = await seedBase(dataSource, {
        grant: { cpuMillis: 1000, memBytes: 1024, diskBytes: 0 },
      });
      const now = new Date();
      await dataSource.getRepository(ContainerEntity).save({
        id: 'existing',
        serverId: 'server-a',
        ownerId: userId,
        name: 'existing',
        imageId,
        createdBy: userId,
        deletedAt: null,
      });
      await dataSource.getRepository(ContainerDesiredSpecEntity).save({
        id: 'existing-spec',
        containerId: 'existing',
        generation: 1,
        imageRef: 'alpine:latest',
        imageDefaultUid: 0,
        cpuMillis: 1000,
        memBytes: 1024,
        diskBytes: 0,
        gpuMode: 'none',
        gpuIndices: [],
        mountsJson: [],
        sshEnabled: false,
        powerIntent: ContainerPowerIntent.Running,
      });
      await dataSource.getRepository(ContainerLifecycleEntity).save({
        containerId: 'existing',
        phase: ContainerPhase.Active,
        boundRuntimeId: 'runtime-existing',
        activeOperationId: null,
        lastTransitionAt: now,
        failureReason: null,
        failureCode: null,
      });
      const service = makeService(dataSource, grant, imageId);

      const ref = await service.create(userId, { serverId: 'server-a', imageId, name: 'second' });
      const command = await createdCommand(dataSource, ref.operationId);
      expect(command.payload).toMatchObject({ cpuMillis: 1000, memBytes: 1024 });
    } finally {
      await dataSource.destroy();
    }
  });

  it('does not block create based on existing desired disk quota reservations', async () => {
    const dataSource = await makeDataSource();
    try {
      const { userId, imageId, grant } = await seedBase(dataSource, {
        grant: { cpuMillis: 1000, memBytes: 1024, diskBytes: 100 },
      });
      const now = new Date();
      await dataSource.getRepository(ContainerEntity).save({
        id: 'existing',
        serverId: 'server-a',
        ownerId: userId,
        name: 'existing',
        imageId,
        createdBy: userId,
        deletedAt: null,
      });
      await dataSource.getRepository(ContainerDesiredSpecEntity).save({
        id: 'existing-spec',
        containerId: 'existing',
        generation: 1,
        imageRef: 'alpine:latest',
        imageDefaultUid: 0,
        cpuMillis: 1000,
        memBytes: 1024,
        diskBytes: 100,
        gpuMode: 'none',
        gpuIndices: [],
        mountsJson: [],
        sshEnabled: false,
        powerIntent: ContainerPowerIntent.Running,
      });
      await dataSource.getRepository(ContainerLifecycleEntity).save({
        containerId: 'existing',
        phase: ContainerPhase.Active,
        boundRuntimeId: 'runtime-existing',
        activeOperationId: null,
        lastTransitionAt: now,
        failureReason: null,
        failureCode: null,
      });
      const service = makeService(dataSource, grant, imageId);

      const ref = await service.create(userId, { serverId: 'server-a', imageId, name: 'second' });
      const command = await createdCommand(dataSource, ref.operationId);
      expect(command.payload).toMatchObject({ name: 'second' });
    } finally {
      await dataSource.destroy();
    }
  });

  it('assigns all GPU indices from an indices grant', async () => {
    const dataSource = await makeDataSource();
    try {
      const { userId, imageId, grant } = await seedBase(dataSource, {
        grant: { gpuMode: GpuGrantMode.Indices, gpuIndices: [1, 0] },
        server: { defaultGpuMode: GpuGrantMode.Indices, defaultGpuIndices: [0, 1] },
      });
      const service = makeService(dataSource, grant, imageId);

      const ref = await service.create(userId, { serverId: 'server-a', imageId, name: 'gpuwork' });
      const command = await createdCommand(dataSource, ref.operationId);
      expect(command.payload).toMatchObject({ gpuIndices: [0, 1] });
      const allocation = await dataSource.getRepository(GpuAllocationEntity).findOneByOrFail({
        containerId: (command.payload as { containerId: string }).containerId,
      });
      expect(allocation.gpuIndicesJson).toEqual([0, 1]);
    } finally {
      await dataSource.destroy();
    }
  });

  it('assigns all known server GPU indices from an all grant', async () => {
    const dataSource = await makeDataSource();
    try {
      const { userId, imageId, grant } = await seedBase(dataSource, {
        grant: { gpuMode: GpuGrantMode.All, gpuIndices: [] },
        server: { defaultGpuMode: GpuGrantMode.All, defaultGpuIndices: [0] },
      });
      await dataSource.getRepository(RuntimeGpuInventoryEntity).save([
        { serverId: 'server-a', gpuIndex: 2, uuid: 'GPU-2', model: 'A', totalMemMib: 100, observedAt: new Date() },
        { serverId: 'server-a', gpuIndex: 1, uuid: 'GPU-1', model: 'A', totalMemMib: 100, observedAt: new Date() },
      ]);
      const service = makeService(dataSource, grant, imageId);

      const ref = await service.create(userId, { serverId: 'server-a', imageId, name: 'gpuwork' });
      const command = await createdCommand(dataSource, ref.operationId);
      expect(command.payload).toMatchObject({ gpuIndices: [0, 1, 2] });
    } finally {
      await dataSource.destroy();
    }
  });

  it('rejects an all GPU grant when the server has no known GPU indices', async () => {
    const dataSource = await makeDataSource();
    try {
      const { userId, imageId, grant } = await seedBase(dataSource, {
        grant: { gpuMode: GpuGrantMode.All, gpuIndices: [] },
        server: { defaultGpuMode: GpuGrantMode.All, defaultGpuIndices: [] },
      });
      const service = makeService(dataSource, grant, imageId);

      await expect(service.create(userId, { serverId: 'server-a', imageId, name: 'gpuwork' }))
        .rejects.toThrow('GPU inventory unavailable for this server');
    } finally {
      await dataSource.destroy();
    }
  });

  it('does not assign GPUs from a none grant', async () => {
    const dataSource = await makeDataSource();
    try {
      const { userId, imageId, grant } = await seedBase(dataSource, {
        grant: { gpuMode: GpuGrantMode.None, gpuIndices: [] },
      });
      await dataSource.getRepository(RuntimeGpuInventoryEntity).save({
        serverId: 'server-a',
        gpuIndex: 0,
        uuid: 'GPU-0',
        model: 'A',
        totalMemMib: 100,
        observedAt: new Date(),
      });
      const service = makeService(dataSource, grant, imageId);

      const ref = await service.create(userId, { serverId: 'server-a', imageId, name: 'nogpu' });
      const command = await createdCommand(dataSource, ref.operationId);
      expect(command.payload).toMatchObject({ gpuIndices: [] });
      await expect(dataSource.getRepository(GpuAllocationEntity).findOneByOrFail({
        containerId: (command.payload as { containerId: string }).containerId,
      })).rejects.toThrow();
    } finally {
      await dataSource.destroy();
    }
  });
});
