import {
  ContainerStatus,
  OperationStatus,
  RemoteFsType,
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

describe('DataDirsService durable reads and guards', () => {
  let dataSource: DataSource;
  let dataDirsRepo: Repository<DataDirectoryEntity>;
  let dataDisksRepo: Repository<DataDiskEntity>;
  let mountsRepo: Repository<ContainerMountEntity>;
  let observationsRepo: Repository<ContainerRuntimeObservationEntity>;
  let runtimeContainersRepo: Repository<RuntimeContainerEntity>;
  let remoteFsRepo: Repository<RemoteFsMountEntity>;
  let assignmentsRepo: Repository<RemoteFsServerAssignmentEntity>;
  let service: DataDirsService;
  let operationsService: { dispatchAgentCommand: ReturnType<typeof vi.fn> };

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
    remoteFsRepo = dataSource.getRepository(RemoteFsMountEntity);
    assignmentsRepo = dataSource.getRepository(RemoteFsServerAssignmentEntity);
    operationsService = {
      dispatchAgentCommand: vi.fn().mockResolvedValue({
        operationId: 'operation-delete',
        status: OperationStatus.Queued,
        result: null,
      }),
    };
    service = new DataDirsService(
      dataDirsRepo,
      dataDisksRepo,
      mountsRepo,
      observationsRepo,
      runtimeContainersRepo,
      remoteFsRepo,
      assignmentsRepo,
      { findById: vi.fn().mockResolvedValue({ id: 'server-a', name: 'Server A' }) } as never,
      { getNumericIdsByUserIds: vi.fn().mockResolvedValue(new Map([['user-a', 1001]])) } as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      operationsService as never,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('lists local and assigned remote data dirs from persisted desired state', async () => {
    await dataDisksRepo.save(dataDisksRepo.create({
      id: 'disk-a',
      serverId: 'server-a',
      mountPoint: '/data',
      label: null,
    }));
    await remoteFsRepo.save(remoteFsRepo.create({
      id: 'remote-a',
      name: 'nfs-a',
      displayName: null,
      description: null,
      type: RemoteFsType.Nfs,
      hostMountPoint: '/mnt/remote-a',
      options: '',
      params: { type: RemoteFsType.Nfs, nfsServer: 'nfs.example', exportPath: '/srv' },
    }));
    await assignmentsRepo.save(assignmentsRepo.create({
      id: 'assignment-a',
      remoteFsMountId: 'remote-a',
      serverId: 'server-a',
    }));
    await dataDirsRepo.save([
      dataDirsRepo.create({
        id: 'local-dir',
        userId: 'user-a',
        sourceKind: 'local',
        sourceId: 'disk-a',
        name: 'project',
        serverId: 'server-a',
        uid: 1000,
      }),
      dataDirsRepo.create({
        id: 'remote-dir',
        userId: 'user-a',
        sourceKind: 'remote',
        sourceId: 'remote-a',
        name: 'shared',
        serverId: null,
        uid: 1000,
      }),
    ]);

    await expect(service.listDirs('user-a', 'server-a')).resolves.toEqual([
      expect.objectContaining({ id: 'local-dir', hostPath: '/data/project', serverName: 'Server A' }),
      expect.objectContaining({ id: 'remote-dir', hostPath: '/mnt/remote-a/shared', serverName: 'Server A' }),
    ]);
  });

  it('allows delete dispatch when matching mount observations are stale or non-running', async () => {
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
      status: ContainerStatus.Exited,
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
      .resolves
      .toMatchObject({ operationId: 'operation-delete', status: OperationStatus.Queued });
    expect(operationsService.dispatchAgentCommand).toHaveBeenCalledTimes(1);
  });
});
