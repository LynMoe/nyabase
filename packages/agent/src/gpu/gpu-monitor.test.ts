import { execFile } from 'child_process';
import * as fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GpuMonitor, type GpuStats } from './gpu-monitor.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const execFileMock = vi.mocked(execFile);
const existsSyncMock = vi.mocked(fs.existsSync);
const readFileSyncMock = vi.mocked(fs.readFileSync);

type ExecFileCallback = (
  err: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

function getExecCallback(args: unknown[]): ExecFileCallback {
  const callback = args[args.length - 1];
  if (typeof callback !== 'function') {
    throw new Error('expected execFile callback');
  }
  return callback as ExecFileCallback;
}

function mockExecFileStdout(stdout: string): void {
  execFileMock.mockImplementation(((_cmd: string, _args: readonly string[], ...rest: unknown[]) => {
    getExecCallback(rest)(null, { stdout, stderr: '' });
  }) as typeof execFile);
}

function mockExecFileError(error: Error): void {
  execFileMock.mockImplementation(((_cmd: string, _args: readonly string[], ...rest: unknown[]) => {
    getExecCallback(rest)(error, { stdout: '', stderr: '' });
  }) as typeof execFile);
}

describe('GpuMonitor stats metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
  });

  it('queries and parses clocks.gr into graphicsClockMHz when supported', async () => {
    mockExecFileStdout([
      '0, GPU-0, 25, 1024, 46080, 39, 72.5, 1410',
      '1, GPU-1, 0, 0, 46080, 35, 44.0, N/A',
      '2, GPU-2, 5, 128, 46080, 36, 50.0, unknown',
    ].join('\n'));

    const stats = await new GpuMonitor(true).getGpuStats();

    expect(execFileMock).toHaveBeenCalledWith(
      'nvidia-smi',
      [
        '--query-gpu=index,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 5_000 },
      expect.any(Function),
    );
    expect(stats[0]).toMatchObject({
      index: 0,
      uuid: 'GPU-0',
      utilizationPercent: 25,
      memUsedMiB: 1024,
      graphicsClockMHz: 1410,
    });
    expect(stats[1]).not.toHaveProperty('graphicsClockMHz');
    expect(stats[2]).not.toHaveProperty('graphicsClockMHz');
  });

  it('emits graphics clock metrics only for finite non-negative clock values', () => {
    const stats: GpuStats[] = [
      baseStats(0, { graphicsClockMHz: 1410 }),
      baseStats(1),
      baseStats(2, { graphicsClockMHz: Number.NaN }),
      baseStats(3, { graphicsClockMHz: -1 }),
    ];

    const points = new GpuMonitor(true).buildMetrics(stats, [], new Map(), 'srv-1');

    expect(points.filter((p) => p.name === 'nyabase_gpu_util_ratio')).toHaveLength(4);
    expect(points.filter((p) => p.name === 'nyabase_gpu_mem_used_bytes')).toHaveLength(4);
    expect(points.filter((p) => p.name === 'nyabase_gpu_clock_graphics_mhz')).toEqual([
      expect.objectContaining({
        labels: { server: 'srv-1', gpu_index: '0' },
        value: 1410,
      }),
    ]);
  });

  it('coalesces overlapping nvidia-smi stats calls into one process', async () => {
    let callback!: ExecFileCallback;
    execFileMock.mockImplementation(((_cmd: string, _args: readonly string[], ...rest: unknown[]) => {
      callback = getExecCallback(rest);
    }) as typeof execFile);
    const monitor = new GpuMonitor(true);

    const first = monitor.getGpuStats();
    const second = monitor.getGpuStats();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      'nvidia-smi',
      [
        '--query-gpu=index,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 5_000 },
      expect.any(Function),
    );

    callback(null, { stdout: '0, GPU-0, 25, 1024, 46080, 39, 72.5, 1410\n', stderr: '' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      [expect.objectContaining({ uuid: 'GPU-0', memUsedMiB: 1024 })],
      [expect.objectContaining({ uuid: 'GPU-0', memUsedMiB: 1024 })],
    ]);

    mockExecFileStdout('0, GPU-0, 0, 0, 46080, 35, 40.0, 1200\n');
    await monitor.getGpuStats();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('emits GPU process memory only for known managed containers', () => {
    const knownId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const unknownId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const processes = [
      { pid: 111, usedMemoryMiB: 256, gpuUuid: 'GPU-a', containerId: knownId },
      { pid: 222, usedMemoryMiB: 512, gpuUuid: 'GPU-a', containerId: unknownId },
      { pid: 333, usedMemoryMiB: 128, gpuUuid: 'GPU-b' },
    ];
    const points = new GpuMonitor(true).buildMetrics(
      [],
      processes,
      new Map([
        [knownId, { metricContainerId: 'container-a' }],
      ]),
      'srv-1',
    );

    expect(points).toEqual([
      expect.objectContaining({
        name: 'nyabase_gpu_proc_mem_used_bytes',
        labels: {
          server: 'srv-1',
          gpu_uuid: 'GPU-a',
          container_id: 'container-a',
        },
        value: 256 * 1024 * 1024,
      }),
    ]);
  });

  it('emits no Agent-owned user identity label', () => {
    const knownId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const points = new GpuMonitor(true).buildMetrics(
      [],
      [{ pid: 111, usedMemoryMiB: 256, gpuUuid: 'GPU-a', containerId: knownId }],
      new Map([[knownId, { metricContainerId: knownId.slice(0, 12) }]]),
      'srv-1',
    );

    expect(points).toEqual([
      expect.objectContaining({
        labels: {
          server: 'srv-1',
          gpu_uuid: 'GPU-a',
          container_id: knownId.slice(0, 12),
        },
      }),
    ]);
  });
});

describe('GpuMonitor container GPU memory attribution', () => {
  const fullId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const otherId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
  });

  it('sums MiB by GPU UUID for matching full and short Docker IDs', async () => {
    mockExecFileStdout([
      '111, 100, GPU-a',
      '222, 50, GPU-a',
      '333, 25, GPU-b',
      '444, 75, GPU-b',
    ].join('\n'));
    existsSyncMock.mockImplementation((path) =>
      ['/proc/111/cgroup', '/proc/222/cgroup', '/proc/333/cgroup', '/proc/444/cgroup'].includes(String(path)));
    readFileSyncMock.mockImplementation(((path) => {
      switch (String(path)) {
        case '/proc/111/cgroup':
          return `0::/system.slice/docker-${fullId}.scope`;
        case '/proc/222/cgroup':
          return `0::/docker/${fullId}`;
        case '/proc/333/cgroup':
          return `12:memory:/docker/${fullId}`;
        case '/proc/444/cgroup':
          return `0::/docker/${otherId}`;
        default:
          throw new Error(`unexpected path ${String(path)}`);
      }
    }) as typeof fs.readFileSync);

    await expect(new GpuMonitor(true).getContainerGpuMemUsedMiB(fullId)).resolves.toEqual({
      'GPU-a': 150,
      'GPU-b': 25,
    });
    await expect(new GpuMonitor(true).getContainerGpuMemUsedMiB(fullId.slice(0, 12))).resolves.toEqual({
      'GPU-a': 150,
      'GPU-b': 25,
    });
  });

  it('returns an empty map when disabled', async () => {
    await expect(new GpuMonitor(false).getContainerGpuMemUsedMiB(fullId)).resolves.toEqual({});
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('skips bad nvidia-smi rows, unresolved cgroups, and nvidia-smi failures safely', async () => {
    mockExecFileStdout([
      '111, N/A, GPU-a',
      '222, nope, GPU-a',
      '333, 25, GPU-b',
    ].join('\n'));
    existsSyncMock.mockReturnValue(false);

    await expect(new GpuMonitor(true).getContainerGpuMemUsedMiB(fullId)).resolves.toEqual({});

    mockExecFileError(new Error('nvidia-smi unavailable'));
    await expect(new GpuMonitor(true).getContainerGpuMemUsedMiB(fullId)).resolves.toEqual({});
  });
});

function baseStats(index: number, overrides: Partial<GpuStats> = {}): GpuStats {
  return {
    index,
    uuid: `GPU-${index}`,
    utilizationPercent: 10,
    memUsedMiB: 20,
    memTotalMiB: 100,
    temperatureCelsius: 30,
    powerWatts: 40,
    ...overrides,
  };
}
