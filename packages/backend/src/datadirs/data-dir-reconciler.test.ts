import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSource, Repository } from 'typeorm';
import { DataDirRuntimeObservationEntity } from '../entities/data-dir-runtime-observation.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ContainerRuntimeObservationWriter } from '../gateway/container-runtime-observation-writer.service.js';
import { DataDirReconcilerService } from './data-dir-reconciler.service.js';

describe('data-dir runtime observation lifecycle', () => {
  let dataSource: DataSource;
  let observationsRepo: Repository<DataDirRuntimeObservationEntity>;
  let writer: ContainerRuntimeObservationWriter;
  let reconciler: DataDirReconcilerService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        DataDirRuntimeObservationEntity,
        DataDirectoryEntity,
        DataDiskEntity,
        RemoteFsMountEntity,
        RemoteFsServerAssignmentEntity,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    observationsRepo = dataSource.getRepository(DataDirRuntimeObservationEntity);
    writer = new ContainerRuntimeObservationWriter(
      dataSource,
      {
        enqueueAgentReconnect: vi.fn().mockResolvedValue(undefined),
        enqueueDataDirReport: vi.fn().mockImplementation((serverId: string) => reconciler.reconcile(serverId)),
        enqueueFullReport: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        persistStateReport: vi.fn().mockResolvedValue(undefined),
        persistHelloInventory: vi.fn().mockResolvedValue(undefined),
      } as never,
    );
    reconciler = new DataDirReconcilerService(
      dataSource.getRepository(DataDirectoryEntity),
      observationsRepo,
      dataSource.getRepository(DataDiskEntity),
      dataSource.getRepository(RemoteFsServerAssignmentEntity),
      dataSource.getRepository(RemoteFsMountEntity),
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('stales previous reported dirs when a later report omits them', async () => {
    await writer.persistDataDirReport('server-a', {
      serverId: 'server-a',
      dirs: [{
        sourceKind: 'local',
        sourceId: 'disk-a',
        name: 'project',
        hostPath: '/data/project',
      }],
    });

    await expect(reconciler.getIssues()).resolves.toEqual([
      {
        kind: 'orphan',
        serverId: 'server-a',
        entry: {
          sourceKind: 'local',
          sourceId: 'disk-a',
          name: 'project',
          hostPath: '/data/project',
        },
      },
    ]);

    await writer.persistDataDirReport('server-a', {
      serverId: 'server-a',
      dirs: [],
    });

    await expect(reconciler.getIssues()).resolves.toEqual([]);
    await expect(observationsRepo.findOneByOrFail({ sourceId: 'disk-a', name: 'project' }))
      .resolves
      .toMatchObject({ stale: true });
  });
});
