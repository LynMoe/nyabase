import { describe, expect, it } from 'vitest';
import { absoluteChart, absoluteUsed, buildSeries, buildUsage, cpuLimitCores, toUserUsage, type InventoryContainer } from './performance-model.js';

const serverId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const containerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

function container(overrides: Partial<InventoryContainer> = {}): InventoryContainer {
  return {
    id: containerId,
    serverId,
    serverName: 'lab',
    ownerId: userId,
    displayName: 'Ada',
    username: 'ada',
    name: 'box',
    lifecyclePhase: 'active',
    powerIntent: 'running',
    cpuMillis: 2500,
    createdAt: 0,
    pciAddresses: ['00000000:81:00.0'],
    volumes: [],
    ...overrides,
  };
}

describe('performance model', () => {
  it('keeps container memory in bytes instead of a share of its own limit', () => {
    const series = new Map([
      ['mem_used_bytes', [{ ts: 1000, labels: { container_id: containerId }, value: 2_110_140_416 }]],
      ['mem_limit_bytes', [{ ts: 1000, labels: { container_id: containerId }, value: 2_147_483_648 }]],
    ]);
    expect(absoluteUsed('memory', [container()], series, 1000)).toBe(2_110_140_416);
  });

  it('fills missing samples with zero after the container exists', () => {
    const series = new Map<string, Array<{ ts: number; labels: Record<string, string>; value: number }>>();
    const chart = absoluteChart({
      metric: 'gpu',
      containers: [container({ createdAt: 2_000 })],
      series,
      timeline: [1_000, 2_000, 3_000],
      pci: '00000000:81:00.0',
    });
    expect(chart.lines[0]?.points.map((point) => point.v)).toEqual([null, 0, 0]);
  });

  it('uses cpu_millis / 1000 instead of the kernel quota', () => {
    expect(cpuLimitCores(2500, 2500000 / 3000000)).toBe(2.5);
    expect(cpuLimitCores(0, 0)).toBeNull();
    const usage = buildUsage({
      containers: [container()],
      samples: [{
        family: 'cpu_usage_cores',
        labels: { container_id: containerId, server_id: serverId },
        value: 0.833,
        ts: Date.now(),
      }],
      scrapeUp: new Map([[serverId, { value: 1, ts: Date.now() }]]),
      now: Date.now(),
      admin: true,
    });
    expect(usage.servers[0]?.people[0]?.cpu).toEqual({
      usageCores: 0.833,
      limitCores: 2.5,
      ratio: 0.833 / 2.5,
    });
    expect(JSON.stringify(toUserUsage(usage))).not.toContain('containerId');
  });

  it('sums one owner and keeps unattributed GPU off the user payload', () => {
    const usage = buildUsage({
      containers: [
        container({ cpuMillis: 1000 }),
        container({ id: otherId, name: 'box-2', cpuMillis: 1000 }),
      ],
      samples: [
        { family: 'cpu_usage_cores', labels: { container_id: containerId, server_id: serverId }, value: 0.4, ts: 1 },
        { family: 'cpu_usage_cores', labels: { container_id: otherId, server_id: serverId }, value: 0.1, ts: 1 },
        { family: 'root_used_bytes', labels: { container_id: containerId, server_id: serverId }, value: 10, ts: 1 },
        { family: 'root_size_bytes', labels: { container_id: containerId, server_id: serverId }, value: 40, ts: 1 },
        { family: 'volume_used_bytes', labels: { container_id: containerId, server_id: serverId, volume_id: '33333333-3333-4333-8333-333333333333' }, value: 99, ts: 1 },
        { family: 'gpu_process_bytes', labels: { container_id: '__unattributed__', server_id: serverId, gpu_pci: '00000000:81:00.0' }, value: 50, ts: 1 },
        { family: 'gpu_limit_bytes', labels: { container_id: containerId, server_id: serverId }, value: 100, ts: 1 },
      ],
      scrapeUp: new Map([[serverId, { value: 1, ts: Date.now() }]]),
      now: Date.now(),
      admin: true,
    });
    const person = usage.servers[0]?.people[0];
    expect(person?.cpu.usageCores).toBeCloseTo(0.5);
    expect(person?.cpu.limitCores).toBe(2);
    expect(person?.disk).toMatchObject({ usedBytes: 10, sizeBytes: 40, ratio: 0.25 });
    expect(person?.gpu.ratio).toBeNull();
    expect(toUserUsage(usage).servers[0]).not.toHaveProperty('unattributedGpu');
    expect(usage.servers[0]?.unattributedGpu).toEqual([{ gpuPci: '00000000:81:00.0', usedBytes: 50 }]);
  });

  it('marks a server stale when a container family is older than 45s', () => {
    const now = Date.now();
    const usage = buildUsage({
      containers: [container()],
      samples: [
        { family: 'cpu_usage_cores', labels: { container_id: containerId, server_id: serverId, user_id: userId }, value: 0.1, ts: now },
        { family: 'root_used_bytes', labels: { container_id: containerId, server_id: serverId, user_id: userId }, value: 10, ts: now - 120_000 },
      ],
      scrapeUp: new Map([[serverId, { value: 1, ts: now }]]),
      now,
      admin: true,
    });
    expect(usage.servers[0]?.stale).toBe(true);
  });

  it('drops a previous owner series and does not chart unlimited memory as a percent', () => {
    const usage = buildUsage({
      containers: [container()],
      samples: [
        { family: 'mem_used_bytes', labels: { container_id: containerId, server_id: serverId, user_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, value: 9_000, ts: 1 },
        { family: 'mem_used_bytes', labels: { container_id: containerId, server_id: serverId, user_id: userId }, value: 20, ts: 2 },
      ],
      scrapeUp: new Map([[serverId, { value: 1, ts: Date.now() }]]),
      now: Date.now(),
      admin: true,
    });
    expect(usage.servers[0]?.people[0]?.memory.usedBytes).toBe(20);
    const lines = buildSeries({
      metric: 'memory',
      containers: [container(), container({ id: otherId, name: 'open' })],
      series: new Map([
        ['mem_used_bytes', [
          { ts: 1_000, labels: { container_id: containerId, user_id: userId }, value: 10 },
          { ts: 1_000, labels: { container_id: otherId, user_id: userId }, value: 10 },
        ]],
        ['mem_limit_bytes', [
          { ts: 1_000, labels: { container_id: containerId, user_id: userId }, value: 100 },
          { ts: 1_000, labels: { container_id: otherId, user_id: userId }, value: 0 },
        ]],
      ]),
    });
    expect(lines[0]?.points[0]?.v).toBeNull();
  });

  it('does not put container ids on user series', () => {
    const lines = buildSeries({
      metric: 'cpu',
      containers: [container({ cpuMillis: 1000 })],
      series: new Map([['cpu_usage_cores', [
        { ts: 1_000, labels: { container_id: containerId }, value: 0.5 },
      ]]]),
    });
    expect(lines.map((line) => line.key)).toEqual([userId]);
    expect(JSON.stringify(lines)).not.toContain(containerId);
    expect(lines[0]?.points[0]?.v).toBe(0.5);
  });
});
