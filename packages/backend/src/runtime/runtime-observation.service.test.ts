import { describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { ContainerPhase, ContainerStatus } from '@nyabase/common';
import { RuntimeObservationService } from './runtime-observation.service.js';
import { RuntimeOrphanService } from './runtime-orphan.service.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { RuntimeContainerEntity } from '../entities/runtime-container.entity.js';
import { RuntimeContainerStatEntity } from '../entities/runtime-container-stat.entity.js';
import { RuntimeGpuInventoryEntity } from '../entities/runtime-gpu-inventory.entity.js';
import { RuntimeOrphanEntity } from '../entities/runtime-orphan.entity.js';

async function makeDataSource() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    synchronize: true,
    entities: [
      ContainerEntity,
      ContainerLifecycleEntity,
      RuntimeContainerEntity,
      RuntimeContainerStatEntity,
      RuntimeGpuInventoryEntity,
      RuntimeOrphanEntity,
    ],
  });
  await dataSource.initialize();
  return dataSource;
}

describe('RuntimeObservationService V2', () => {
  it('binds managed runtime rows by canonical containerId label and records stats', async () => {
    const dataSource = await makeDataSource();
    try {
      await dataSource.getRepository(ContainerEntity).save({
        id: 'container-a', serverId: 'server-a', ownerId: 'user-a', name: 'work', imageId: 'image-a', createdBy: 'user-a', deletedAt: null,
      });
      await dataSource.getRepository(ContainerLifecycleEntity).save({
        containerId: 'container-a', phase: ContainerPhase.Provisioning, boundRuntimeId: null, activeOperationId: null, lastTransitionAt: new Date(), failureReason: null, failureCode: null,
      });
      const orphan = new RuntimeOrphanService(dataSource.getRepository(RuntimeOrphanEntity));
      const service = new RuntimeObservationService(dataSource, orphan, dataSource.getRepository(ContainerEntity));
      await service.persistStateReport('server-a', {
        serverId: 'server-a',
        incremental: false,
        containers: [{
          spec: { runtimeId: 'runtime-a', name: 'work', ownerId: 'user-a', imageId: 'image-a', cpuMillis: 1000, memBytes: 1024, gpuIndices: [], ip: '10.0.0.2', serverId: 'server-a', sshServerEnabled: false, dataDirs: [], createdAt: new Date().toISOString(), specVersion: '3' },
          status: ContainerStatus.Running,
          stats: { cpuUsageRatio: 0.1, memUsedBytes: 1, memLimitBytes: 2, netRxBytes: 3, netTxBytes: 4, blockReadBytes: 5, blockWriteBytes: 6, gpuMemUsedMiB: {} },
          sshServer: { enabled: false, status: 'disabled', user: 'root', port: 22 },
          labels: { 'nyabase.containerId': 'container-a', 'nyabase.ownerId': 'user-a' },
        }],
        xfsProjects: [],
        disks: [],
        remoteFsMounts: [],
      });
      await expect(dataSource.getRepository(RuntimeContainerEntity).findOneByOrFail({ runtimeId: 'runtime-a' }))
        .resolves.toMatchObject({ containerId: 'container-a', status: ContainerStatus.Running, stale: false });
      await expect(dataSource.getRepository(ContainerLifecycleEntity).findOneByOrFail({ containerId: 'container-a' }))
        .resolves.toMatchObject({ boundRuntimeId: 'runtime-a' });
      await expect(dataSource.getRepository(RuntimeContainerStatEntity).findOneByOrFail({ runtimeContainerId: 'server-a:runtime-a' }))
        .resolves.toMatchObject({ statsJson: expect.objectContaining({ memUsedBytes: 1 }) });
      expect(await dataSource.getRepository(RuntimeOrphanEntity).count()).toBe(0);
    } finally {
      await dataSource.destroy();
    }
  });

  it('preserves operation-known IP and resolves owner from desired container when state report omits non-label spec fields', async () => {
    const dataSource = await makeDataSource();
    try {
      await dataSource.getRepository(ContainerEntity).save({
        id: 'container-a', serverId: 'server-a', ownerId: 'user-a', name: 'work', imageId: 'image-a', createdBy: 'user-a', deletedAt: null,
      });
      await dataSource.getRepository(ContainerLifecycleEntity).save({
        containerId: 'container-a', phase: ContainerPhase.Active, boundRuntimeId: 'runtime-a', activeOperationId: null, lastTransitionAt: new Date(), failureReason: null, failureCode: null,
      });
      await dataSource.getRepository(RuntimeContainerEntity).save({
        id: 'server-a:runtime-a',
        serverId: 'server-a',
        runtimeId: 'runtime-a',
        containerId: 'container-a',
        ownerId: 'user-a',
        ownerNumericId: null,
        status: ContainerStatus.Running,
        specGenerationSeen: null,
        ip: '10.0.0.2',
        labelsJson: { 'nyabase.container_id': 'container-a' },
        firstSeenAt: new Date(0),
        lastSeenAt: new Date(0),
        stale: false,
      });
      const orphan = new RuntimeOrphanService(dataSource.getRepository(RuntimeOrphanEntity));
      const service = new RuntimeObservationService(dataSource, orphan, dataSource.getRepository(ContainerEntity));

      await service.persistStateReport('server-a', {
        serverId: 'server-a',
        incremental: false,
        containers: [{
          spec: { runtimeId: 'runtime-a', name: 'work', ownerId: '', imageId: '', cpuMillis: 0, memBytes: 0, gpuIndices: [], ip: '', serverId: 'server-a', sshServerEnabled: false, dataDirs: [], createdAt: '', specVersion: '3' },
          status: ContainerStatus.Running,
          stats: null,
          sshServer: { enabled: false, status: 'disabled', user: 'root', port: 22 },
          labels: { 'nyabase.container_id': 'container-a', 'nyabase.server_id': 'server-a', 'nyabase.managed': 'true' },
        }],
        xfsProjects: [],
        disks: [],
        remoteFsMounts: [],
      });

      await expect(dataSource.getRepository(RuntimeContainerEntity).findOneByOrFail({ runtimeId: 'runtime-a' }))
        .resolves.toMatchObject({ containerId: 'container-a', ownerId: 'user-a', ip: '10.0.0.2', stale: false });
    } finally {
      await dataSource.destroy();
    }
  });

  it('uses a report-level observation timestamp so full reports do not mark newly reported rows stale', async () => {
    const dataSource = await makeDataSource();
    try {
      await dataSource.getRepository(ContainerEntity).save([
        {
          id: 'container-old', serverId: 'server-a', ownerId: 'user-a', name: 'old', imageId: 'image-a', createdBy: 'user-a', deletedAt: null,
        },
        {
          id: 'container-new', serverId: 'server-a', ownerId: 'user-a', name: 'new', imageId: 'image-a', createdBy: 'user-a', deletedAt: null,
        },
      ]);
      await dataSource.getRepository(ContainerLifecycleEntity).save([
        { containerId: 'container-old', phase: ContainerPhase.Active, boundRuntimeId: 'runtime-old', activeOperationId: null, lastTransitionAt: new Date(0), failureReason: null, failureCode: null },
        { containerId: 'container-new', phase: ContainerPhase.Active, boundRuntimeId: 'runtime-new', activeOperationId: null, lastTransitionAt: new Date(0), failureReason: null, failureCode: null },
      ]);
      const reportTs = Date.now();
      await dataSource.getRepository(RuntimeContainerEntity).save({
        id: 'server-a:runtime-old',
        serverId: 'server-a',
        runtimeId: 'runtime-old',
        containerId: 'container-old',
        ownerId: 'user-a',
        ownerNumericId: null,
        status: ContainerStatus.Running,
        specGenerationSeen: null,
        ip: '10.0.0.2',
        labelsJson: { 'nyabase.container_id': 'container-old' },
        firstSeenAt: new Date(reportTs - 1000),
        lastSeenAt: new Date(reportTs - 1000),
        stale: false,
      });
      const orphan = new RuntimeOrphanService(dataSource.getRepository(RuntimeOrphanEntity));
      const service = new RuntimeObservationService(dataSource, orphan, dataSource.getRepository(ContainerEntity));

      await service.persistStateReport('server-a', {
        serverId: 'server-a',
        observedAt: reportTs,
        incremental: false,
        containers: [{
          spec: { runtimeId: 'runtime-new', name: 'new', ownerId: '', imageId: '', cpuMillis: 0, memBytes: 0, gpuIndices: [], ip: '10.0.0.3', serverId: 'server-a', sshServerEnabled: false, dataDirs: [], createdAt: '', specVersion: '3' },
          status: ContainerStatus.Running,
          stats: null,
          sshServer: { enabled: false, status: 'disabled', user: 'root', port: 22 },
          labels: { 'nyabase.container_id': 'container-new', 'nyabase.server_id': 'server-a', 'nyabase.managed': 'true' },
        }],
        xfsProjects: [],
        disks: [],
        remoteFsMounts: [],
      });

      await expect(dataSource.getRepository(RuntimeContainerEntity).findOneByOrFail({ runtimeId: 'runtime-new' }))
        .resolves.toMatchObject({ containerId: 'container-new', stale: false });
      await expect(dataSource.getRepository(RuntimeContainerEntity).findOneByOrFail({ runtimeId: 'runtime-old' }))
        .resolves.toMatchObject({ containerId: 'container-old', stale: true });
    } finally {
      await dataSource.destroy();
    }
  });

  it('classifies missing-label and desired-missing runtime rows as orphans', async () => {
    const dataSource = await makeDataSource();
    try {
      const orphan = new RuntimeOrphanService(dataSource.getRepository(RuntimeOrphanEntity));
      const service = new RuntimeObservationService(dataSource, orphan, dataSource.getRepository(ContainerEntity));
      await service.persistStateReport('server-a', {
        serverId: 'server-a',
        incremental: false,
        containers: [
          {
            spec: { runtimeId: 'runtime-missing-label', name: 'x', ownerId: '', imageId: '', cpuMillis: 0, memBytes: 0, gpuIndices: [], ip: '', serverId: 'server-a', sshServerEnabled: false, dataDirs: [], createdAt: '', specVersion: '3' },
            status: ContainerStatus.Running,
            stats: null,
            sshServer: { enabled: false, status: 'disabled', user: 'root', port: 22 },
            labels: {},
          },
          {
            spec: { runtimeId: 'runtime-desired-missing', name: 'y', ownerId: '', imageId: '', cpuMillis: 0, memBytes: 0, gpuIndices: [], ip: '', serverId: 'server-a', sshServerEnabled: false, dataDirs: [], createdAt: '', specVersion: '3' },
            status: ContainerStatus.Running,
            stats: null,
            sshServer: { enabled: false, status: 'disabled', user: 'root', port: 22 },
            labels: { 'nyabase.containerId': 'missing-container' },
          },
        ],
        xfsProjects: [],
        disks: [],
        remoteFsMounts: [],
      });
      const orphans = await dataSource.getRepository(RuntimeOrphanEntity).find({ order: { runtimeId: 'ASC' } });
      expect(orphans.map((o) => [o.runtimeId, o.reason])).toEqual([
        ['runtime-desired-missing', 'desired_missing'],
        ['runtime-missing-label', 'missing_label'],
      ]);
    } finally {
      await dataSource.destroy();
    }
  });
});
