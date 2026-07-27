import { describe, expect, it, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { GpuGrantMode, type MetricSeries } from '@nyabase/common';
import { MetricsController } from './metrics.controller.js';
import { AdminMetricsController } from './admin-metrics.controller.js';
import type { MetricsQueryService } from './metrics-query.service.js';
import type { AccessResolverService } from '../access/access-resolver.service.js';
import type { UsersService } from '../users/users.service.js';
import type { UserRecord } from '../domain/domain-records.js';
import { parseRange } from './metrics-query.service.js';

describe('MetricsController.routes', () => {
  it('does not expose legacy raw PromQL paths', () => {
    const ordinaryPaths = declaredRoutePaths(MetricsController);
    const adminPaths = declaredRoutePaths(AdminMetricsController);

    expect(ordinaryPaths).not.toEqual(expect.arrayContaining(['query', 'query_range']));
    expect(adminPaths).not.toEqual(expect.arrayContaining(['query', 'query_range']));
  });

  it('rejects unsupported ranges instead of silently widening them to a default', () => {
    expect(() => parseRange('7d')).toThrow('range must be one of 1h, 6h, or 24h');
    expect(parseRange(undefined)).toMatchObject({ step: 60 });
  });

  it('quotes an admin-controlled server id as one PromQL label value', async () => {
    const maliciousServerId = 'srv"} or vector(1) #';
    const metricsQuery = {
      queryRangeByLabel: vi.fn().mockResolvedValue(new Map()),
    } as unknown as MetricsQueryService;
    const controller = makeAdminController(metricsQuery);

    await controller.adminGpuMetrics(maliciousServerId, '1h');

    const selectors = vi.mocked(metricsQuery.queryRangeByLabel).mock.calls
      .map(([selector]) => selector);
    expect(selectors).toHaveLength(5);
    for (const selector of selectors) {
      expect(selector).toContain(`server=${JSON.stringify(maliciousServerId)}`);
      expect(selector).not.toContain('server="srv"} or vector(1) #"');
    }
  });
});

describe('MetricsController.gpuMetrics', () => {
  it('returns graphicsClockMHz and includes clock-only GPU indices in the union', async () => {
    const util = series(60, [[1000, 0.5]]);
    const memUsed = series(60, [[1000, 1024]]);
    const temp = series(60, [[1000, 42]]);
    const power = series(60, [[1000, 75]]);
    const graphicsClock = series(60, [[1000, 1410]]);
    const metricsQuery = {
      queryRangeByLabel: vi.fn()
        .mockResolvedValueOnce(new Map([['0', util]]))
        .mockResolvedValueOnce(new Map([['0', memUsed]]))
        .mockResolvedValueOnce(new Map([['0', temp]]))
        .mockResolvedValueOnce(new Map([['0', power]]))
        .mockResolvedValueOnce(new Map([['1', graphicsClock]])),
    } as unknown as MetricsQueryService;
    const controller = makeController(metricsQuery);

    const result = await controller.gpuMetrics('srv-1', { id: 'user-1' } as UserRecord, '1h');

    expect(metricsQuery.queryRangeByLabel).toHaveBeenNthCalledWith(
      5,
      'nyabase_gpu_clock_graphics_mhz{server="srv-1"}',
      expect.any(Number),
      expect.any(Number),
      60,
      'gpu_index',
    );
    expect(result.gpus).toEqual([
      expect.objectContaining({
        index: 0,
        model: 'GPU 0',
        memTotalMiB: 0,
        util,
        memUsed,
        temp,
        power,
        graphicsClockMHz: { step: 60, points: [] },
      }),
      expect.objectContaining({
        index: 1,
        model: 'GPU 1',
        memTotalMiB: 0,
        util: { step: 60, points: [] },
        memUsed: { step: 60, points: [] },
        temp: { step: 60, points: [] },
        power: { step: 60, points: [] },
        graphicsClockMHz: graphicsClock,
      }),
    ]);
  });

  it('joins idle GPU inventory metadata without exposing physical UUIDs', async () => {
    const metricsQuery = {
      queryRangeByLabel: vi.fn().mockResolvedValue(new Map()),
    } as unknown as MetricsQueryService;
    const controller = makeController(
      metricsQuery,
      undefined,
      undefined,
      [],
      new Map(),
      [{ index: 2, uuid: 'GPU-physical-secret', model: 'NVIDIA A100', totalMemMiB: 40_960 }],
    );

    const result = await controller.gpuMetrics('srv-1', { id: 'user-1' } as UserRecord, '1h');

    expect(result.gpus).toEqual([{
      index: 2,
      model: 'NVIDIA A100',
      memTotalMiB: 40_960,
      util: empty(60),
      memUsed: empty(60),
      temp: empty(60),
      power: empty(60),
      graphicsClockMHz: empty(60),
    }]);
    expect(JSON.stringify(result)).not.toContain('GPU-physical-secret');
  });

  it.each([
    [GpuGrantMode.None, [], []],
    [GpuGrantMode.Indices, [1], [1]],
    [GpuGrantMode.All, [], [0, 1]],
  ] as const)(
    'filters ordinary GPU metrics for %s resolved access',
    async (gpuMode, gpuIndices, expectedIndices) => {
      const metricByIndex = new Map([
        ['0', series(60, [[1000, 10]])],
        ['1', series(60, [[1000, 20]])],
      ]);
      const metricsQuery = {
        queryRangeByLabel: vi.fn()
          .mockResolvedValueOnce(metricByIndex)
          .mockResolvedValueOnce(metricByIndex)
          .mockResolvedValueOnce(metricByIndex)
          .mockResolvedValueOnce(metricByIndex)
          .mockResolvedValueOnce(metricByIndex),
      } as unknown as MetricsQueryService;
      const accessResolver = {
        runWithActiveServerAccess: vi.fn(async (
          _userId: string,
          _serverId: string,
          work: (manager: unknown) => Promise<unknown>,
        ) => work({})),
        resolveServerInTransaction: vi.fn().mockResolvedValue({
          cpuMillis: 0,
          memBytes: 0,
          diskBytes: 0,
          gpuMode,
          gpuIndices: [...gpuIndices],
        }),
      } as unknown as AccessResolverService;
      const controller = makeController(metricsQuery, accessResolver);

      const result = await controller.gpuMetrics(
        'srv-1',
        { id: 'user-1' } as UserRecord,
        '1h',
      );

      expect(result.gpus.map((gpu) => gpu.index)).toEqual(expectedIndices);
    },
  );
});

describe('MetricsController.hostMetrics projection', () => {
  it('shows only granted logical disks and aggregates physical device/interface labels', async () => {
    const diskIo = series(60, [[1000, 10], [1060, 16]]);
    const net = series(60, [[1000, 13]]);
    const metricsQuery = makeHostSeriesQuery(
      new Map([['disk-visible', series(60, [[1000, 20]])]]),
      new Map([['disk-visible', series(60, [[1000, 100]])]]),
      diskIo,
      net,
    );
    const accessResolver = {
      runWithActiveServerAccess: vi.fn(async (
        _userId: string,
        _serverId: string,
        work: (manager: unknown) => Promise<unknown>,
      ) => work({})),
      hasMountSourceAccessInTransaction: vi.fn().mockImplementation(
        async (_manager, _userId, _serverId, source) => source.id === 'disk-visible',
      ),
      resolveMountSources: vi.fn(),
    } as unknown as AccessResolverService;
    const controller = new MetricsController(
      metricsQuery,
      accessResolver,
      {} as UsersService,
      fakeContainerDatabase([]),
      { stateCache: { get: vi.fn().mockReturnValue({
        disks: [
          {
            diskId: 'disk-visible', sourceIdentity: 'xfs:visible',
            mountPoint: '/srv/shared/data', label: 'Shared data',
          },
          {
            diskId: 'disk-private', sourceIdentity: 'xfs:private',
            mountPoint: '/srv/private/admin', label: null,
          },
        ],
      }) } } as never,
    );

    const result = await controller.hostMetrics(
      'srv-1',
      { id: 'user-1' } as UserRecord,
      '1h',
    );

    expect(result.disks).toEqual([expect.objectContaining({
      diskId: 'disk-visible', displayName: 'Shared data',
    })]);
    expect(result.disks[0]).not.toHaveProperty('mountPoint');
    expect(result.diskIo).toEqual([{
      label: 'All disks',
      bps: series(60, [[1000, 10], [1060, 16]]),
    }]);
    expect(result.netIo).toEqual([{ label: 'All interfaces', bps: net }]);
    expect(JSON.stringify(result)).not.toMatch(/srv\/private|nvme0n1|dm-secret|eth-secret/);
    expect(vi.mocked(accessResolver.hasMountSourceAccessInTransaction)).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'srv-1',
      { kind: 'local', id: 'disk-visible' },
      'xfs:visible',
    );
    expect(accessResolver.resolveMountSources).not.toHaveBeenCalled();
    expect(vi.mocked(metricsQuery.queryRangeByLabel).mock.calls.every(
      (call) => call[4] !== 'dev' && call[4] !== 'iface',
    )).toBe(true);
  });

  it('retains physical disk inventory only on the admin plane while I/O stays bounded', async () => {
    const diskIo = series(60, [[1000, 3]]);
    const netIo = series(60, [[1000, 4]]);
    const controller = new AdminMetricsController(
      makeHostSeriesQuery(
        new Map(), new Map(), diskIo, netIo,
      ),
      {} as AccessResolverService,
      {} as UsersService,
      fakeContainerDatabase([]),
      { stateCache: { get: vi.fn().mockReturnValue({
        disks: [{ diskId: 'disk-a', mountPoint: '/srv/admin-only', label: null }],
      }) } } as never,
    );

    await expect(controller.adminHostMetrics('srv-1', '1h')).resolves.toMatchObject({
      disks: [{ diskId: 'disk-a', displayName: 'admin-only', mountPoint: '/srv/admin-only' }],
      diskIo: [{ label: 'All disks', bps: diskIo }],
      netIo: [{ label: 'All interfaces', bps: netIo }],
    });
  });
});

describe('MetricsController.userMetrics', () => {
  it('filters normal users by database container ownership instead of user_id labels', async () => {
    const ownCpu = series(60, [[1000, 1]]);
    const otherCpu = series(60, [[1000, 2]]);
    const otherMem = series(60, [[1000, 2048]]);
    const numericDisk = series(60, [[1000, 12]]);
    const metricsQuery = makeContainerSeriesQuery({
      cpu: new Map([
        ['aaaabbbbcccc', ownCpu],
        ['ddddffffeeee', otherCpu],
      ]),
      memUsed: new Map([['ddddffffeeee', otherMem]]),
      diskUsed: new Map([['12', numericDisk]]),
    });
    const accessResolver = {
      hasCapability: vi.fn(),
      listAccessibleServers: vi.fn().mockResolvedValue(['srv-1']),
      runWithActiveServerAccess: vi.fn(async (
        _userId: string, _serverId: string, work: (manager: unknown) => Promise<unknown>,
      ) => work({})),
    } as unknown as AccessResolverService;
    const usersService = {
      getNumericIdsByUserIds: vi.fn().mockResolvedValue(new Map([['user-1', 12]])),
      getUserIdsByNumericIds: vi.fn().mockResolvedValue(new Map()),
      findByIds: vi.fn().mockResolvedValue([
        { id: 'user-1', numericId: 12, username: 'alice', displayName: 'Alice' },
      ]),
    } as unknown as UsersService;
    const controller = makeController(
      metricsQuery,
      accessResolver,
      usersService,
      [
        { id: 'container-a', serverId: 'srv-1', ownerId: 'user-1', name: 'own-work' },
        { id: 'container-b', serverId: 'srv-1', ownerId: 'other-user', name: 'other-work' },
      ],
      runtimeContainers([
        { runtimeId: 'aaaabbbbcccc0000000000000000000000000000000000000000000000000000', containerId: 'container-a' },
        { runtimeId: 'ddddffffeeee0000000000000000000000000000000000000000000000000000', containerId: 'container-b' },
      ]),
    );

    const result = await controller.userMetrics('srv-1', { id: 'user-1' } as UserRecord, '1h');

    const selectors = vi.mocked(metricsQuery.queryRangeByLabel).mock.calls.map(([selector]) => selector);
    expect(selectors).toHaveLength(8);
    for (const selector of selectors.slice(0, 7)) {
      expect(selector).toContain('server="srv-1"');
      expect(selector).not.toContain('user_id=');
    }
    expect(selectors[7]).toContain('server="srv-1",user_id=~"user-1|12"');
    expect(result.users).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        username: 'alice',
        displayName: 'Alice',
        cpu: ownCpu,
        diskUsed: numericDisk,
      }),
    ]);
    expect(result.users.map((u) => u.userId)).not.toContain('other-user');
    expect(result.users.map((u) => u.userId)).not.toContain('12');
    expect(accessResolver.hasCapability).not.toHaveBeenCalled();
    expect(vi.mocked(accessResolver.runWithActiveServerAccess))
      .toHaveBeenCalledWith('user-1', 'srv-1', expect.any(Function));
  });

  it('does not let ViewMetricsAll widen the user metrics plane', async () => {
    const ownCpu = series(60, [[1000, 1]]);
    const otherMem = series(60, [[1000, 2048]]);
    const metricsQuery = makeContainerSeriesQuery({
      cpu: new Map([['aaaabbbbcccc', ownCpu]]),
      memUsed: new Map([['ddddffffeeee', otherMem]]),
    });
    const accessResolver = {
      hasCapability: vi.fn().mockResolvedValue(true),
      listAccessibleServers: vi.fn().mockResolvedValue(['srv-1']),
      runWithActiveServerAccess: vi.fn(async (
        _userId: string, _serverId: string, work: (manager: unknown) => Promise<unknown>,
      ) => work({})),
    } as unknown as AccessResolverService;
    const usersService = {
      getNumericIdsByUserIds: vi.fn().mockResolvedValue(new Map()),
      getUserIdsByNumericIds: vi.fn().mockResolvedValue(new Map()),
      findByIds: vi.fn().mockResolvedValue([
        { id: 'user-1', numericId: 12, username: 'alice', displayName: 'Alice' },
      ]),
    } as unknown as UsersService;
    const controller = makeController(
      metricsQuery,
      accessResolver,
      usersService,
      [
        { id: 'container-a', serverId: 'srv-1', ownerId: 'user-1', name: 'own-work' },
        { id: 'container-b', serverId: 'srv-1', ownerId: 'other-user', name: 'other-work' },
      ],
      runtimeContainers([
        { runtimeId: 'aaaabbbbcccc0000000000000000000000000000000000000000000000000000', containerId: 'container-a' },
        { runtimeId: 'ddddffffeeee0000000000000000000000000000000000000000000000000000', containerId: 'container-b' },
      ]),
    );

    const result = await controller.userMetrics('srv-1', { id: 'user-1' } as UserRecord, '1h');

    const selectors = vi.mocked(metricsQuery.queryRangeByLabel).mock.calls.map(([selector]) => selector);
    expect(selectors).toHaveLength(8);
    for (const selector of selectors.slice(0, 7)) {
      expect(selector).toContain('server="srv-1"');
      expect(selector).not.toContain('user_id=');
    }
    expect(selectors[7]).toContain('server="srv-1",user_id="user-1"');
    expect(result.users.map((u) => u.userId)).toEqual(['user-1']);
    expect(result.users[0].cpu).toEqual(ownCpu);
    expect(result.users[0].memUsed.points).toEqual([]);
    expect(accessResolver.hasCapability).not.toHaveBeenCalled();
  });
});

describe('AdminMetricsController.userMetrics', () => {
  it('preserves all-user behavior and resolves numeric disk series to usernames', async () => {
    const ownCpu = series(60, [[1000, 1]]);
    const otherMem = series(60, [[1000, 2048]]);
    const numericDisk = series(60, [[1000, 12]]);
    const metricsQuery = makeContainerSeriesQuery({
      cpu: new Map([['aaaabbbbcccc', ownCpu]]),
      memUsed: new Map([['ddddffffeeee', otherMem]]),
      diskUsed: new Map([['12', numericDisk]]),
    });
    const usersService = {
      getUserIdsByNumericIds: vi.fn().mockResolvedValue(new Map([[12, 'user-1']])),
      findByIds: vi.fn().mockResolvedValue([
        { id: 'user-1', numericId: 12, username: 'alice', displayName: 'Alice' },
        { id: 'other-user', numericId: 13, username: 'bob', displayName: 'Bob' },
      ]),
    } as unknown as UsersService;
    const controller = makeAdminController(
      metricsQuery,
      usersService,
      [
        { id: 'container-a', serverId: 'srv-1', ownerId: 'user-1', name: 'own-work' },
        { id: 'container-b', serverId: 'srv-1', ownerId: 'other-user', name: 'other-work' },
      ],
      runtimeContainers([
        { runtimeId: 'aaaabbbbcccc0000000000000000000000000000000000000000000000000000', containerId: 'container-a' },
        { runtimeId: 'ddddffffeeee0000000000000000000000000000000000000000000000000000', containerId: 'container-b' },
      ]),
    );

    const result = await controller.adminUserMetrics('srv-1', { id: 'user-1' } as UserRecord, '1h');

    const selectors = vi.mocked(metricsQuery.queryRangeByLabel).mock.calls.map(([selector]) => selector);
    expect(selectors).toHaveLength(8);
    for (const selector of selectors) {
      expect(selector).toContain('server="srv-1"');
      expect(selector).not.toContain('user_id="user-1"');
    }
    expect(result.users.map((u) => u.userId)).toEqual(['user-1', 'other-user']);
    expect(result.users).toEqual([
      expect.objectContaining({ userId: 'user-1', username: 'alice', displayName: 'Alice', cpu: ownCpu, diskUsed: numericDisk }),
      expect.objectContaining({ userId: 'other-user', username: 'bob', displayName: 'Bob', memUsed: otherMem }),
    ]);
  });
});

describe('MetricsController.containerMetrics', () => {
  it('returns all resource series for the current user from unlabeled container metrics', async () => {
    const ownCpu = series(60, [[1000, 1]]);
    const ownMem = series(60, [[1000, 1024]]);
    const ownRead = series(60, [[1000, 10]]);
    const ownWrite = series(60, [[1000, 20]]);
    const ownNetRx = series(60, [[1000, 30]]);
    const ownNetTx = series(60, [[1000, 40]]);
    const ownGpuFullId = series(60, [[1000, 512]]);
    const otherCpu = series(60, [[1000, 2]]);
    const ownFullRuntimeId = 'aaaabbbbcccc0000000000000000000000000000000000000000000000000000';
    const metricsQuery = makeContainerSeriesQuery({
      cpu: new Map([
        ['aaaabbbbcccc', ownCpu],
        ['ddddffffeeee', otherCpu],
      ]),
      memUsed: new Map([['aaaabbbbcccc', ownMem]]),
      gpuMemUsed: new Map([[ownFullRuntimeId, ownGpuFullId]]),
      diskRead: new Map([['aaaabbbbcccc', ownRead]]),
      diskWrite: new Map([['aaaabbbbcccc', ownWrite]]),
      netRx: new Map([['aaaabbbbcccc', ownNetRx]]),
      netTx: new Map([['aaaabbbbcccc', ownNetTx]]),
    });
    const controller = makeController(
      metricsQuery,
      {
        hasCapability: vi.fn(),
        listAccessibleServers: vi.fn().mockResolvedValue(['srv-1']),
        runWithActiveServerAccess: vi.fn(async (
          _userId: string, _serverId: string, work: (manager: unknown) => Promise<unknown>,
        ) => work({})),
      } as unknown as AccessResolverService,
      defaultUsersService(),
      [
        { id: 'container-a', serverId: 'srv-1', ownerId: 'user-1', name: 'own-work' },
        { id: 'container-b', serverId: 'srv-1', ownerId: 'other-user', name: 'other-work' },
      ],
      runtimeContainers([
        { runtimeId: ownFullRuntimeId, containerId: 'container-a' },
        { runtimeId: 'ddddffffeeee0000000000000000000000000000000000000000000000000000', containerId: 'container-b' },
      ]),
    );

    const result = await controller.containerMetrics('srv-1', { id: 'user-1' } as UserRecord, '1h');

    const selectors = vi.mocked(metricsQuery.queryRangeByLabel).mock.calls.map(([selector]) => selector);
    expect(selectors).toHaveLength(7);
    for (const selector of selectors) {
      expect(selector).toContain('server="srv-1"');
      expect(selector).not.toContain('user_id=');
    }
    expect(result.containers).toEqual([
      expect.objectContaining({
        containerId: 'container-a',
        name: 'own-work',
        ownerId: 'user-1',
        cpu: ownCpu,
        memUsed: ownMem,
        gpuMemUsed: ownGpuFullId,
        diskBps: series(60, [[1000, 30]]),
        netBps: series(60, [[1000, 70]]),
      }),
    ]);
  });
});

interface SeriesQueryInput {
  cpu?: Map<string, MetricSeries>;
  memUsed?: Map<string, MetricSeries>;
  gpuMemUsed?: Map<string, MetricSeries>;
  diskRead?: Map<string, MetricSeries>;
  diskWrite?: Map<string, MetricSeries>;
  netRx?: Map<string, MetricSeries>;
  netTx?: Map<string, MetricSeries>;
  diskUsed?: Map<string, MetricSeries>;
}

function makeContainerSeriesQuery(input: SeriesQueryInput): MetricsQueryService {
  return {
    queryRangeByLabel: vi.fn()
      .mockResolvedValueOnce(input.cpu ?? new Map())
      .mockResolvedValueOnce(input.memUsed ?? new Map())
      .mockResolvedValueOnce(input.gpuMemUsed ?? new Map())
      .mockResolvedValueOnce(input.diskRead ?? new Map())
      .mockResolvedValueOnce(input.diskWrite ?? new Map())
      .mockResolvedValueOnce(input.netRx ?? new Map())
      .mockResolvedValueOnce(input.netTx ?? new Map())
      .mockResolvedValueOnce(input.diskUsed ?? new Map()),
  } as unknown as MetricsQueryService;
}

function makeController(
  metricsQuery: MetricsQueryService,
  accessResolver: AccessResolverService | undefined = undefined,
  usersService: UsersService | undefined = undefined,
  containers: Array<Record<string, unknown>> = [],
  runtimeSnapshots = new Map(),
  gpus: Array<Record<string, unknown>> = [],
): MetricsController {
  const resolvedAccess = accessResolver ?? {
    hasCapability: vi.fn().mockResolvedValue(true),
    listAccessibleServers: vi.fn().mockResolvedValue(['srv-1']),
    runWithActiveServerAccess: vi.fn(async (
      _userId: string, _serverId: string, work: (manager: unknown) => Promise<unknown>,
    ) => work({})),
    resolveServerInTransaction: vi.fn().mockResolvedValue({
      cpuMillis: 0,
      memBytes: 0,
      diskBytes: 0,
      gpuMode: GpuGrantMode.All,
      gpuIndices: [],
    }),
    resolveMountSources: vi.fn().mockResolvedValue(new Set()),
  } as unknown as AccessResolverService;
  return new MetricsController(
    metricsQuery,
    resolvedAccess,
    usersService ?? ({} as unknown as UsersService),
    fakeContainerDatabase(containers),
    { stateCache: { get: vi.fn().mockReturnValue({ disks: [], gpus, containers: runtimeSnapshots }) } } as never,
  );
}

function makeHostSeriesQuery(
  diskUsed: Map<string, MetricSeries>,
  diskTotal: Map<string, MetricSeries>,
  diskIo: MetricSeries,
  netIo: MetricSeries,
): MetricsQueryService {
  return {
    queryRangeSingle: vi.fn()
      .mockResolvedValueOnce({ step: 60, points: [] })
      .mockResolvedValueOnce({ step: 60, points: [] })
      .mockResolvedValueOnce({ step: 60, points: [] })
      .mockResolvedValueOnce({ step: 60, points: [] })
      .mockResolvedValueOnce(diskIo)
      .mockResolvedValueOnce(netIo),
    queryRangeByLabel: vi.fn()
      .mockResolvedValueOnce(diskUsed)
      .mockResolvedValueOnce(diskTotal),
  } as unknown as MetricsQueryService;
}

function makeAdminController(
  metricsQuery: MetricsQueryService,
  usersService: UsersService = {} as unknown as UsersService,
  containers: Array<Record<string, unknown>> = [],
  runtimeSnapshots = new Map(),
): AdminMetricsController {
  return new AdminMetricsController(
    metricsQuery,
    {} as unknown as AccessResolverService,
    usersService,
    fakeContainerDatabase(containers),
    { stateCache: { get: vi.fn().mockReturnValue({ disks: [], containers: runtimeSnapshots }) } } as never,
  );
}

function defaultUsersService(): UsersService {
  return {
    getNumericIdsByUserIds: vi.fn().mockResolvedValue(new Map()),
    getUserIdsByNumericIds: vi.fn().mockResolvedValue(new Map()),
    findByIds: vi.fn().mockResolvedValue([]),
  } as unknown as UsersService;
}

function fakeContainerDatabase(containers: Array<Record<string, unknown>>) {
  return {
    selectFrom: () => {
      const builder = {
        select: () => builder,
        where: () => builder,
        execute: async () => containers.map((container) => ({
          id: container.id,
          name: container.name,
          owner_id: container.ownerId ?? container.owner_id,
        })),
      };
      return builder;
    },
  } as never;
}

function series(step: number, points: Array<[number, number]>): MetricSeries {
  return { step, points: points.map(([t, v]) => ({ t, v })) };
}

function empty(step: number): MetricSeries {
  return { step, points: [] };
}

function runtimeContainers(rows: Array<{ runtimeId: string; containerId: string }>) {
  return new Map(rows.map((row) => [row.runtimeId, {
    runtime: {
      runtimeId: row.runtimeId,
      ip: '10.0.0.2',
      serverId: 'srv-1',
      specGeneration: '1',
      quotaPaths: ['/var/lib/docker/overlay2/runtime/diff', '/var/lib/docker/overlay2/runtime/work'],
    },
    labels: { 'nyabase.container_id': row.containerId },
  }]));
}

function declaredRoutePaths(controller: { prototype: object }): string[] {
  const paths: string[] = [];
  let proto: object | null = controller.prototype;

  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = Object.getOwnPropertyDescriptor(proto, name)?.value;
      if (typeof handler !== 'function') continue;

      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (Array.isArray(path)) {
        paths.push(...path.map(String));
      } else if (path != null) {
        paths.push(String(path));
      }
    }
    proto = Object.getPrototypeOf(proto);
  }

  return paths;
}
