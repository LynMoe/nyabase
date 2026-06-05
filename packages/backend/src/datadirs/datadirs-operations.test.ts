import { ConflictException } from '@nestjs/common';
import {
  AuditAction,
  AgentCommandKind,
  ContainerStatus,
  OperationKind,
  OperationStatus,
} from '@nyabase/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSource, Repository } from 'typeorm';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { ContainerRuntimeObservationEntity } from '../entities/container-runtime-observation.entity.js';
import { RuntimeContainerEntity } from '../entities/runtime-container.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { DataDirsService } from './datadirs.service.js';

describe('DataDirsService durable operations', () => {
  let dataSource: DataSource;
  let dataDirsRepo: Repository<DataDirectoryEntity>;
  let dataDisksRepo: Repository<DataDiskEntity>;
  let mountsRepo: Repository<ContainerMountEntity>;
  let observationsRepo: Repository<ContainerRuntimeObservationEntity>;
  let runtimeContainersRepo: Repository<RuntimeContainerEntity>;
  let service: DataDirsService;
  let operationsService: { dispatchAgentCommand: ReturnType<typeof vi.fn> };
  let auditService: { log: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        ContainerMountEntity,
        ContainerRuntimeObservationEntity,
        RuntimeContainerEntity,
        DataDirectoryEntity,
        DataDiskEntity,
        RemoteFsMountEntity,
        RemoteFsServerAssignmentEntity,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    dataDirsRepo = dataSource.getRepository(DataDirectoryEntity);
    dataDisksRepo = dataSource.getRepository(DataDiskEntity);
    mountsRepo = dataSource.getRepository(ContainerMountEntity);
    observationsRepo = dataSource.getRepository(ContainerRuntimeObservationEntity);
    runtimeContainersRepo = dataSource.getRepository(RuntimeContainerEntity);
    operationsService = {
      dispatchAgentCommand: vi.fn(async () => ({
        operationId: 'operation-a',
        status: OperationStatus.Queued,
        result: null,
      })),
    };
    auditService = { log: vi.fn().mockResolvedValue(undefined) };
    service = new DataDirsService(
      dataDirsRepo,
      dataDisksRepo,
      mountsRepo,
      observationsRepo,
      runtimeContainersRepo,
      dataSource.getRepository(RemoteFsMountEntity),
      dataSource.getRepository(RemoteFsServerAssignmentEntity),
      { findById: vi.fn().mockResolvedValue({ id: 'server-a', name: 'Server A' }) } as never,
      { getNumericIdsByUserIds: vi.fn().mockResolvedValue(new Map([['user-a', 1001]])) } as never,
      auditService as never,
      operationsService as never,
    );
    await dataDisksRepo.save(dataDisksRepo.create({
      id: 'disk-a',
      serverId: 'server-a',
      mountPoint: '/data',
      label: null,
    }));
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('creates the data-dir row before queueing a durable create command', async () => {
    await expect(service.createDir('actor-a', 'user-a', 'server-a', 'local', 'disk-a', 'project', 1000))
      .resolves
      .toMatchObject({
        id: expect.any(String),
        serverId: 'server-a',
        sourceKind: 'local',
        sourceId: 'disk-a',
        name: 'project',
        hostPath: '/data/project',
        operationId: 'operation-a',
      });

    const row = await dataDirsRepo.findOneByOrFail({ sourceId: 'disk-a', name: 'project' });
    expect(row).toMatchObject({ userId: 'user-a', serverId: 'server-a', uid: 1000 });
    expect(operationsService.dispatchAgentCommand).toHaveBeenCalledWith({
      operationKind: OperationKind.DataDirCreate,
      commandKind: AgentCommandKind.DataDirApply,
      serverId: 'server-a',
      resourceType: 'datadir',
      resourceId: row.id,
      requestedBy: 'actor-a',
      payload: { diskId: 'disk-a', name: 'project', uid: 1000, numericUserId: 1001 },
      request: {
        userId: 'user-a',
        sourceKind: 'local',
        sourceId: 'disk-a',
        name: 'project',
        uid: 1000,
      },
    });
    expect(auditService.log).toHaveBeenCalledWith(
      'actor-a',
      AuditAction.CreateDataDir,
      'server-a/disk-a/project',
      'datadir',
      expect.objectContaining({ operationId: 'operation-a' }),
    );
  });

  it('queues durable delete visibility and leaves DB deletion to terminal operation success', async () => {
    await dataDirsRepo.save(dataDirsRepo.create({
      id: 'dir-a',
      userId: 'user-a',
      sourceKind: 'local',
      sourceId: 'disk-a',
      name: 'project',
      serverId: 'server-a',
      uid: 1000,
    }));

    await expect(service.deleteDir('actor-a', 'user-a', 'server-a', 'local', 'disk-a', 'project'))
      .resolves
      .toEqual({
        ok: true,
        operationId: 'operation-a',
        status: OperationStatus.Queued,
      });

    await expect(dataDirsRepo.findOneByOrFail({ id: 'dir-a' })).resolves.toMatchObject({ name: 'project' });
    expect(operationsService.dispatchAgentCommand).toHaveBeenCalledWith(expect.objectContaining({
      operationKind: OperationKind.DataDirDelete,
      commandKind: AgentCommandKind.DataDirDelete,
      serverId: 'server-a',
      resourceType: 'datadir',
      resourceId: 'dir-a',
      requestedBy: 'actor-a',
      payload: { diskId: 'disk-a', name: 'project' },
      request: {
        userId: 'user-a',
        sourceKind: 'local',
        sourceId: 'disk-a',
        name: 'project',
      },
    }));
  });

  it('prevents delete dispatch when persisted observations show a matching running mount', async () => {
    await dataDirsRepo.save(dataDirsRepo.create({
      id: 'dir-a',
      userId: 'user-a',
      sourceKind: 'local',
      sourceId: 'disk-a',
      name: 'project',
      serverId: 'server-a',
      uid: 1000,
    }));
    await mountsRepo.save(mountsRepo.create({
      id: 'mount-a',
      serverId: 'server-a',
      containerId: 'container-a',
      dockerId: 'docker-a',
      containerName: 'work',
      sourceKind: 'local',
      sourceId: 'disk-a',
      userId: 'user-a',
      dirName: 'project',
      containerPath: '/work',
      createIfMissing: false,
    }));
    await observationsRepo.save(observationsRepo.create({
      id: 'obs-a',
      serverId: 'server-a',
      containerId: 'container-a',
      dockerId: 'docker-a',
      reportSeq: 1,
      status: ContainerStatus.Running,
      stats: null,
      sshServer: null,
      labels: null,
      labelsValid: false,
      specGenerationSeen: 1,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      missingSince: null,
      stale: false,
    }));

    await expect(service.deleteDir('actor-a', 'user-a', 'server-a', 'local', 'disk-a', 'project'))
      .rejects
      .toBeInstanceOf(ConflictException);
    expect(operationsService.dispatchAgentCommand).not.toHaveBeenCalled();
  });

  it('prevents delete dispatch when live runtime state is running before the observation row catches up', async () => {
    await dataDirsRepo.save(dataDirsRepo.create({
      id: 'dir-a',
      userId: 'user-a',
      sourceKind: 'local',
      sourceId: 'disk-a',
      name: 'project',
      serverId: 'server-a',
      uid: 1000,
    }));
    await mountsRepo.save(mountsRepo.create({
      id: 'mount-a',
      serverId: 'server-a',
      containerId: 'container-a',
      dockerId: null,
      containerName: 'work',
      sourceKind: 'local',
      sourceId: 'disk-a',
      userId: 'user-a',
      dirName: 'project',
      containerPath: '/work',
      createIfMissing: false,
    }));
    await runtimeContainersRepo.save(runtimeContainersRepo.create({
      id: 'server-a:docker-a',
      serverId: 'server-a',
      runtimeId: 'docker-a',
      containerId: 'container-a',
      ownerId: 'user-a',
      ownerNumericId: 1001,
      status: ContainerStatus.Running,
      specGenerationSeen: 1,
      ip: '10.0.0.42',
      labelsJson: {},
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      stale: false,
    }));

    await expect(service.deleteDir('actor-a', 'user-a', 'server-a', 'local', 'disk-a', 'project'))
      .rejects
      .toBeInstanceOf(ConflictException);
    expect(operationsService.dispatchAgentCommand).not.toHaveBeenCalled();
  });
});
