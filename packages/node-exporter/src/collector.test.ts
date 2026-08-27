import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  joinGpuProcesses,
  LinuxNodeMetricsCollector,
  parseGpuStats,
  type ReadOnlyCommand,
  type ReadOnlyNodeFileSystem,
} from './collector.js';
import { validateNodeMetricSample } from '@nyabase/common';

class FakeFileSystem implements ReadOnlyNodeFileSystem {
  constructor(private readonly files: Record<string, string>, private readonly dirs: string[] = []) {}

  async readFile(path: string): Promise<string> {
    const value = this.files[path];
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  }

  async readdir(): Promise<string[]> {
    return this.dirs;
  }
}

function commandForFixtures(): ReadOnlyCommand {
  return async (file, args) => {
    if (file === 'nvidia-smi' && args[0] === '--query-gpu=index,pci.bus_id,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw') {
      return { stdout: '0, 0000:41:00.0, GPU-a, 25, 128, 4096, 55, 80\n1, 0000:42:00.0, GPU-b, N/A, N/A, 8192, N/A, N/A\n' };
    }
    if (file === 'nvidia-smi') {
      return { stdout: '123, 64, GPU-a\n' };
    }
    if (file === 'smartctl') {
      return { stdout: JSON.stringify({ smart_status: { passed: true } }) };
    }
    if (file === 'nft') {
      return { stdout: 'fib saddr . iif oif 0 drop\n' };
    }
    throw new Error(`unexpected command ${file}`);
  };
}

describe('LinuxNodeMetricsCollector', () => {
  it('collects read-only CPU, PSI, disk, SMART, GPU PCI, and network evidence', async () => {
    const files = {
      '/proc/stat': [
        'cpu0 110 0 20 870 0 0 0 0 0 0',
        'cpu1 100 0 20 880 0 0 0 0 0 0',
      ].join('\n'),
      '/proc/pressure/cpu': 'some avg10=1.00 avg60=2.00 avg300=3.00 total=4\n',
      '/proc/diskstats': '8 0 sda 1 0 2048 4 2 0 1024 2 0 0 0 0 0 0 0 0 0\n',
      '/sys/class/block/sda/device/wwid': 'wwn-0x1234\n',
      '/proc/123/cgroup': '0::/system.slice/nyabase-11111111-1111-4111-8111-111111111111.scope\n',
      '/proc/sys/net/ipv4/conf/eno1/forwarding': '1\n',
      '/proc/sys/net/ipv4/conf/eno1/rp_filter': '1\n',
    };
    const fileSystem = new FakeFileSystem(files, ['eno1']);
    const collector = new LinuxNodeMetricsCollector({
      parentInterface: 'eno1',
      fileSystem,
      command: commandForFixtures(),
    });

    const first = await collector.collect();
    expect(first.some((sample) => sample.name === 'nyabase_node_cpu_usage_ratio')).toBe(false);
    files['/proc/stat'] = [
      'cpu0 120 0 25 875 0 0 0 0 0 0',
      'cpu1 110 0 25 885 0 0 0 0 0 0',
    ].join('\n');
    const second = await collector.collect();
    for (const sample of [...first, ...second]) validateNodeMetricSample(sample);

    expect(second).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'nyabase_node_cpu_usage_ratio',
        labels: { cpu: '0' },
      }),
      expect.objectContaining({
        name: 'nyabase_node_disk_io_read_bytes_total',
        labels: { device_id: 'wwn-0x1234' },
      }),
      expect.objectContaining({
        name: 'nyabase_node_disk_smart_health',
        value: 1,
      }),
      expect.objectContaining({
        name: 'nyabase_node_gpu_util_ratio',
        labels: { gpu_pci: '00000000:41:00.0' },
        value: 0.25,
      }),
      expect.objectContaining({
        name: 'nyabase_node_gpu_mem_total_bytes',
        labels: { gpu_pci: '00000000:42:00.0' },
      }),
      expect.objectContaining({
        name: 'nyabase_node_gpu_process_mem_used_bytes',
        labels: {
          gpu_pci: '00000000:41:00.0',
          container_id: '11111111-1111-4111-8111-111111111111',
        },
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_fib_rule_present',
        labels: { interface: 'eno1' },
        value: 1,
      }),
    ]));
    expect(second.some((sample) => sample.labels && 'pid' in sample.labels)).toBe(false);
  });

  it('joins process usage by PCI address instead of an nvidia-smi index', () => {
    const result = joinGpuProcesses(
      [
        { index: 0, pci: '00000000:41:00.0', uuid: 'GPU-a' },
        { index: 1, pci: '0000:42:00.0', uuid: 'GPU-b' },
      ],
      [
        {
          gpuUuid: 'GPU-a',
          memoryUsedBytes: 10,
          containerId: '__unattributed__',
        },
        {
          gpuUuid: 'GPU-b',
          memoryUsedBytes: 20,
          containerId: '__unattributed__',
        },
      ],
    );
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ pci: '00000000:41:00.0', memoryUsedBytes: 10 }),
      expect.objectContaining({ pci: '00000000:42:00.0', memoryUsedBytes: 20 }),
    ]));
  });

  it('canonicalizes four- and eight-digit PCI domains for the join key', () => {
    for (const domain of ['0000', '00000000']) {
      expect(parseGpuStats(
        `0, ${domain}:41:00.0, GPU-a, 25, 128, 4096, 55, 80`,
      )).toEqual([expect.objectContaining({
        index: 0,
        pci: '00000000:41:00.0',
        uuid: 'GPU-a',
      })]);
    }
  });

  it('emits eight-digit PCI addresses in GPU metric labels', async () => {
    const collector = new LinuxNodeMetricsCollector({
      fileSystem: new FakeFileSystem({}, []),
      command: async (file, args) => {
        if (file === 'nvidia-smi' && args[0]?.startsWith('--query-gpu=')) {
          return { stdout: '0, 00000000:41:00.0, GPU-a, 25, 128, 4096, 55, 80\n' };
        }
        if (file === 'nvidia-smi') return { stdout: '' };
        throw new Error(`unexpected command ${file}`);
      },
    });

    const samples = await collector.collect();
    expect(samples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'nyabase_node_gpu_smi_index',
        labels: { gpu_pci: '00000000:41:00.0' },
        value: 0,
      }),
      expect.objectContaining({
        name: 'nyabase_node_gpu_util_ratio',
        labels: { gpu_pci: '00000000:41:00.0' },
        value: 0.25,
      }),
    ]));
  });

  it('does not fabricate unavailable capabilities or expose a mutation surface', async () => {
    const collector = new LinuxNodeMetricsCollector({
      fileSystem: new FakeFileSystem({}, []),
      command: async () => {
        throw new Error('unavailable');
      },
    });
    expect(await collector.collect()).toEqual([]);

    const source = [
      readFileSync(resolve(process.cwd(), 'src/collector.ts'), 'utf8'),
      readFileSync(resolve(process.cwd(), 'src/server.ts'), 'utf8'),
    ].join('\n');
    expect(source).not.toMatch(/\b(?:writeFile|appendFile|unlink|rm|rename)\s*\(/);
    expect(source).not.toMatch(/\b(?:incus|docker|WebSocket)\b/i);
  });
});
