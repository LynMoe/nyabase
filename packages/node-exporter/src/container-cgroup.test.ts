import { describe, expect, it } from 'vitest';
import { CORE_NODE_METRIC_CATALOG, validateNodeMetricSample } from '@nyabase/common';
import { collectContainerCgroupMetrics } from './container-cgroup.js';
import type { ReadOnlyNodeFileSystem } from './collector.js';

const HEX = '11111111111141118111111111111111';
const ID = '11111111-1111-4111-8111-111111111111';

class FakeFileSystem implements ReadOnlyNodeFileSystem {
  constructor(private readonly files: Record<string, string>) {}

  async readFile(path: string): Promise<string> {
    const value = this.files[path];
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  }

  async readdir(path: string): Promise<string[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const children = new Set<string>();
    for (const key of Object.keys(this.files)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const name = rest.split('/')[0];
      if (name) children.add(name);
    }
    if (children.size === 0 && path !== '/sys/fs/cgroup' && !Object.keys(this.files).some((key) => key.startsWith(prefix))) {
      throw new Error(`missing dir ${path}`);
    }
    return [...children];
  }
}

function payload(hex: string, files: Record<string, string>): Record<string, string> {
  const directory = `/sys/fs/cgroup/system.slice/incus.service/lxc.payload.nyc-${hex}`;
  return Object.fromEntries(Object.entries(files).map(([name, value]) => [`${directory}/${name}`, value]));
}

describe('collectContainerCgroupMetrics', () => {
  it('reads payload cgroups and validates the catalog', async () => {
    const samples = await collectContainerCgroupMetrics({
      fileSystem: new FakeFileSystem({
        ...payload(HEX, {
          'cpu.stat': 'usage_usec 2500000\n',
          'cpu.max': 'max 100000\n',
          'cpuset.cpus': '0-1\n',
          'memory.current': '1048576\n',
          'memory.max': 'max\n',
          'io.stat': '259:0 rbytes=10 wbytes=20 rios=1 wios=1\n8:0 rbytes=5 wbytes=7 rios=1 wios=1\n',
        }),
        '/sys/fs/cgroup/system.slice/incus.service/lxc.monitor.nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/cpu.stat': 'usage_usec 1\n',
      }),
      command: async () => { throw new Error('unused'); },
    });
    for (const sample of samples) validateNodeMetricSample(sample, CORE_NODE_METRIC_CATALOG);
    expect(samples).toEqual(expect.arrayContaining([
      { name: 'nyabase_container_cpu_usage_seconds_total', labels: { container_id: ID }, value: 2.5 },
      { name: 'nyabase_container_cpu_limit_cores', labels: { container_id: ID }, value: 2 },
      { name: 'nyabase_container_mem_used_bytes', labels: { container_id: ID }, value: 1_048_576 },
      { name: 'nyabase_container_mem_limit_bytes', labels: { container_id: ID }, value: 0 },
      { name: 'nyabase_container_disk_io_read_bytes_total', labels: { container_id: ID }, value: 15 },
      { name: 'nyabase_container_disk_io_write_bytes_total', labels: { container_id: ID }, value: 27 },
      { name: 'nyabase_container_cgroup_observed', labels: {}, value: 1 },
    ]));
    expect(samples.some((sample) => JSON.stringify(sample.labels).includes('pid'))).toBe(false);
    expect(samples.some((sample) => sample.labels.container_id?.includes('aaaaaaaa'))).toBe(false);
  });

  it('uses the kernel quota for a fractional allowance and not the cpuset size', async () => {
    const samples = await collectContainerCgroupMetrics({
      fileSystem: new FakeFileSystem(payload(HEX, {
        'cpu.max': '2500000 3000000\n',
        'cpuset.cpus': '0-2\n',
      })),
      command: async () => { throw new Error('unused'); },
    });
    expect(samples).toContainEqual({
      name: 'nyabase_container_cpu_limit_cores',
      labels: { container_id: ID },
      value: 2500000 / 3000000,
    });
  });

  it('emits one sample when both the scope and the payload exist', async () => {
    const scope = `/sys/fs/cgroup/incus-nyc-${HEX}.scope`;
    const samples = await collectContainerCgroupMetrics({
      fileSystem: new FakeFileSystem({
        [`${scope}/cpu.stat`]: 'usage_usec 9\n',
        [`${scope}/lxc.payload.nyc-${HEX}/cpu.stat`]: 'usage_usec 1000000\n',
      }),
      command: async () => { throw new Error('unused'); },
    });
    const cpu = samples.filter((sample) => sample.name === 'nyabase_container_cpu_usage_seconds_total');
    expect(cpu).toEqual([
      { name: 'nyabase_container_cpu_usage_seconds_total', labels: { container_id: ID }, value: 1 },
    ]);
    expect(samples).toContainEqual({ name: 'nyabase_container_cgroup_observed', labels: {}, value: 1 });
  });

  it('falls back to a scope directory when the payload is absent', async () => {
    const samples = await collectContainerCgroupMetrics({
      fileSystem: new FakeFileSystem({
        [`/sys/fs/cgroup/incus-nyc-${HEX}.scope/cpu.stat`]: 'usage_usec 500000\n',
      }),
      command: async () => { throw new Error('unused'); },
    });
    expect(samples).toContainEqual({
      name: 'nyabase_container_cpu_usage_seconds_total',
      labels: { container_id: ID },
      value: 0.5,
    });
  });

  it('sets truncated when the walk stops before a deeper payload', async () => {
    const deep = `/sys/fs/cgroup/a/b/c/d/e/f/g/lxc.payload.nyc-${HEX}/cpu.stat`;
    const samples = await collectContainerCgroupMetrics({
      fileSystem: new FakeFileSystem({ [deep]: 'usage_usec 1\n' }),
      command: async () => { throw new Error('unused'); },
    });
    expect(samples).toContainEqual({ name: 'nyabase_container_cgroup_truncated', labels: {}, value: 1 });
    expect(samples.some((sample) => sample.labels.container_id === ID)).toBe(false);
  });

  it('marks truncation at the 512 container cap', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 513; index += 1) {
      const hex = `11111111111141118111${index.toString(16).padStart(12, '0')}`;
      files[`/sys/fs/cgroup/p/lxc.payload.nyc-${hex}/cpu.stat`] = 'usage_usec 1\n';
    }
    const samples = await collectContainerCgroupMetrics({
      fileSystem: new FakeFileSystem(files),
      command: async () => { throw new Error('unused'); },
    });
    expect(samples).toContainEqual({ name: 'nyabase_container_cgroup_truncated', labels: {}, value: 1 });
    expect(samples.filter((sample) => sample.name === 'nyabase_container_cpu_usage_seconds_total')).toHaveLength(512);
  });
});
