import { describe, expect, it } from 'vitest';
import {
  collectNvidiaGpuMetrics,
  joinGpuProcesses,
  parseGpuStats,
  type ReadOnlyCommand,
  type ReadOnlyNodeFileSystem,
} from './collector.js';

class FakeFileSystem implements ReadOnlyNodeFileSystem {
  constructor(private readonly files: Record<string, string>) {}
  async readFile(path: string): Promise<string> {
    const value = this.files[path];
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  }
}

describe('parseGpuStats', () => {
  it('canonicalizes four- and eight-digit PCI domains', () => {
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
});

describe('joinGpuProcesses', () => {
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
});

describe('collectNvidiaGpuMetrics', () => {
  it('emits eight-digit PCI addresses in GPU metric labels', async () => {
    const command: ReadOnlyCommand = async (file, args) => {
      if (file === 'nvidia-smi' && args[0]?.startsWith('--query-gpu=')) {
        return { stdout: '0, 00000000:41:00.0, GPU-a, 25, 128, 4096, 55, 80\n' };
      }
      if (file === 'nvidia-smi') return { stdout: '' };
      throw new Error(`unexpected command ${file}`);
    };
    const samples = await collectNvidiaGpuMetrics({
      fileSystem: new FakeFileSystem({}),
      command,
    });
    expect(samples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'nyabase_node_gpu_driver_present',
        labels: {},
        value: 1,
      }),
      expect.objectContaining({
        name: 'nyabase_node_gpu_toolkit_present',
        labels: {},
        value: 0,
      }),
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

  it('attributes a compute process inside an Incus payload cgroup', async () => {
    const hex = '11111111111141118111111111111111';
    const command: ReadOnlyCommand = async (file, args) => {
      if (file === 'nvidia-smi' && args[0]?.startsWith('--query-gpu=')) {
        return { stdout: '0, 00000000:41:00.0, GPU-a, 0, 0, 4096, 40, 10\n' };
      }
      if (file === 'nvidia-smi' && args[0]?.startsWith('--query-compute-apps=')) {
        return { stdout: '42, 128, GPU-a\n' };
      }
      throw new Error('ENOENT');
    };
    const samples = await collectNvidiaGpuMetrics({
      fileSystem: new FakeFileSystem({
        '/proc/42/cgroup': '0::/lxc.payload.nyc-' + hex + '\n',
      }),
      command,
    });
    expect(samples).toContainEqual({
      name: 'nyabase_node_gpu_process_mem_used_bytes',
      labels: {
        gpu_pci: '00000000:41:00.0',
        container_id: '11111111-1111-4111-8111-111111111111',
      },
      value: 128 * 1024 * 1024,
    });
  });

  it('keeps a hyphenated scope id and leaves unknown cgroups unattributed', async () => {
    const command: ReadOnlyCommand = async (file, args) => {
      if (file === 'nvidia-smi' && args[0]?.startsWith('--query-gpu=')) {
        return { stdout: '0, 00000000:41:00.0, GPU-a, 0, 0, 1024, 40, 10\n1, 00000000:42:00.0, GPU-b, 0, 0, 1024, 40, 10\n' };
      }
      if (file === 'nvidia-smi' && args[0]?.startsWith('--query-compute-apps=')) {
        return { stdout: '7, 1, GPU-a\n8, 1, GPU-b\n' };
      }
      throw new Error('ENOENT');
    };
    const samples = await collectNvidiaGpuMetrics({
      fileSystem: new FakeFileSystem({
        '/proc/7/cgroup': '0::/system.slice/nyabase-11111111-1111-4111-8111-111111111111.scope\n',
        '/proc/8/cgroup': '0::/user.slice/session\n',
      }),
      command,
    });
    expect(samples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'nyabase_node_gpu_process_mem_used_bytes',
        labels: { gpu_pci: '00000000:41:00.0', container_id: '11111111-1111-4111-8111-111111111111' },
      }),
      expect.objectContaining({
        name: 'nyabase_node_gpu_process_mem_used_bytes',
        labels: { gpu_pci: '00000000:42:00.0', container_id: '__unattributed__' },
      }),
    ]));
  });

  it('still emits presence gauges when nvidia-smi is missing', async () => {
    const samples = await collectNvidiaGpuMetrics({
      fileSystem: new FakeFileSystem({}),
      command: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(samples).toEqual([
      { name: 'nyabase_node_gpu_driver_present', labels: {}, value: 0 },
      { name: 'nyabase_node_gpu_toolkit_present', labels: {}, value: 0 },
    ]);
  });

  it('marks the toolkit present when nvidia-container-cli answers', async () => {
    const samples = await collectNvidiaGpuMetrics({
      fileSystem: new FakeFileSystem({}),
      command: async (file) => {
        if (file === 'nvidia-container-cli') return { stdout: '1.0.0' };
        throw new Error('ENOENT');
      },
    });
    expect(samples).toEqual([
      { name: 'nyabase_node_gpu_driver_present', labels: {}, value: 0 },
      { name: 'nyabase_node_gpu_toolkit_present', labels: {}, value: 1 },
    ]);
  });
});
