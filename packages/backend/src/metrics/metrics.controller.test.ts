import { describe, expect, it, vi } from 'vitest';
import type { MetricSeries } from '@nyabase/common';
import { MetricsController } from './metrics.controller.js';
import { AdminMetricsController } from './admin-metrics.controller.js';
import type { MetricsQueryService } from './metrics-query.service.js';
import type { AccessResolverService } from '../access/access-resolver.service.js';
import type { UsersService } from '../users/users.service.js';
import type { UserEntity } from '../entities/user.entity.js';

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

    const result = await controller.gpuMetrics('srv-1', { id: 'user-1' } as UserEntity, '1h');

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
      [
        { runtimeId: 'aaaabbbbcccc0000000000000000000000000000000000000000000000000000', containerId: 'container-a', ownerId: null },
        { runtimeId: 'ddddffffeeee0000000000000000000000000000000000000000000000000000', containerId: 'container-b', ownerId: null },
      ],
    );

    const result = await controller.userMetrics('srv-1', { id: 'user-1' } as UserEntity, '1h');

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
    expect(vi.mocked(accessResolver.listAccessibleServers)).toHaveBeenCalledWith('user-1');
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
      [
        { runtimeId: 'aaaabbbbcccc0000000000000000000000000000000000000000000000000000', containerId: 'container-a', ownerId: null },
        { runtimeId: 'ddddffffeeee0000000000000000000000000000000000000000000000000000', containerId: 'container-b', ownerId: null },
      ],
    );

    const result = await controller.userMetrics('srv-1', { id: 'user-1' } as UserEntity, '1h');

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
      [
        { runtimeId: 'aaaabbbbcccc0000000000000000000000000000000000000000000000000000', containerId: 'container-a', ownerId: null },
        { runtimeId: 'ddddffffeeee0000000000000000000000000000000000000000000000000000', containerId: 'container-b', ownerId: null },
      ],
    );

    const result = await controller.adminUserMetrics('srv-1', { id: 'user-1' } as UserEntity, '1h');

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
      } as unknown as AccessResolverService,
      defaultUsersService(),
      [
        { id: 'container-a', serverId: 'srv-1', ownerId: 'user-1', name: 'own-work' },
        { id: 'container-b', serverId: 'srv-1', ownerId: 'other-user', name: 'other-work' },
      ],
      [
        { runtimeId: ownFullRuntimeId, containerId: 'container-a', ownerId: null },
        { runtimeId: 'ddddffffeeee0000000000000000000000000000000000000000000000000000', containerId: 'container-b', ownerId: null },
      ],
    );

    const result = await controller.containerMetrics('srv-1', { id: 'user-1' } as UserEntity, '1h');

    const selectors = vi.mocked(metricsQuery.queryRangeByLabel).mock.calls.map(([selector]) => selector);
    expect(selectors).toHaveLength(7);
    for (const selector of selectors) {
      expect(selector).toContain('server="srv-1"');
      expect(selector).not.toContain('user_id=');
    }
    expect(result.containers).toEqual([
      expect.objectContaining({
        containerId: 'aaaabbbbcccc',
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
  accessResolver: AccessResolverService = {
    hasCapability: vi.fn().mockResolvedValue(true),
    listAccessibleServers: vi.fn().mockResolvedValue(['srv-1']),
  } as unknown as AccessResolverService,
  usersService: UsersService = {} as unknown as UsersService,
  containers: Array<Record<string, unknown>> = [],
  runtimeContainers: Array<Record<string, unknown>> = [],
): MetricsController {
  return new MetricsController(
    metricsQuery,
    accessResolver,
    usersService,
    { find: vi.fn().mockResolvedValue([]) } as never,
    { find: vi.fn().mockResolvedValue(containers) } as never,
    { find: vi.fn().mockResolvedValue(runtimeContainers) } as never,
  );
}

function makeAdminController(
  metricsQuery: MetricsQueryService,
  usersService: UsersService = {} as unknown as UsersService,
  containers: Array<Record<string, unknown>> = [],
  runtimeContainers: Array<Record<string, unknown>> = [],
): AdminMetricsController {
  return new AdminMetricsController(
    metricsQuery,
    {} as unknown as AccessResolverService,
    usersService,
    { find: vi.fn().mockResolvedValue([]) } as never,
    { find: vi.fn().mockResolvedValue(containers) } as never,
    { find: vi.fn().mockResolvedValue(runtimeContainers) } as never,
  );
}

function defaultUsersService(): UsersService {
  return {
    getNumericIdsByUserIds: vi.fn().mockResolvedValue(new Map()),
    getUserIdsByNumericIds: vi.fn().mockResolvedValue(new Map()),
    findByIds: vi.fn().mockResolvedValue([]),
  } as unknown as UsersService;
}

function series(step: number, points: Array<[number, number]>): MetricSeries {
  return { step, points: points.map(([t, v]) => ({ t, v })) };
}
