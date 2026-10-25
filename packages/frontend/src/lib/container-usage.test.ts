import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContainerStatus, type ContainerDto } from '@nyabase/common';
import {
  cpuReading,
  formatBytesPair,
  gpuReading,
  liveSample,
  memoryReading,
  rootDiskReading,
  sharedUnitPair,
  type ContainerLiveUsage,
} from './container-usage.js';
import { readSource } from './read-source.test-helper.js';

const GIB = 1024 ** 3;
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function sample(overrides: Partial<ContainerLiveUsage> = {}): ContainerLiveUsage {
  return {
    cpu: { usageCores: 0.42, limitCores: null, ratio: null },
    memory: { usedBytes: 1.2 * GIB, limitBytes: 4 * GIB, ratio: 0.3 },
    gpu: { usedBytes: null, limitBytes: null, ratio: null, pciAddresses: [] },
    disk: { usedBytes: 3 * GIB, sizeBytes: 20 * GIB, ratio: 0.15, readBytesPerSec: null, writeBytesPerSec: null },
    network: { rxBytesPerSec: null, txBytesPerSec: null },
    ...overrides,
  };
}

const container = {
  cpuSet: [4, 5, 6, 7],
  memBytes: 4 * GIB,
  rootSizeBytes: 20 * GIB,
  rootUsedBytes: 2 * GIB,
  gpu: null,
  actual: { status: ContainerStatus.Running },
} as unknown as ContainerDto;

describe('container usage readings', () => {
  it('reads CPU as a core count, never the pinned ids', () => {
    expect(cpuReading(container, sample())).toEqual({ used: '0.4', total: '4 核', ratio: 0.105 });
    expect(cpuReading(container, undefined)).toEqual({ used: null, total: '4 核', ratio: null });
    expect(cpuReading({ cpuSet: null }, undefined).total).toBe('待分配');
  });

  it('shares the unit between used and allocated when they match', () => {
    expect(memoryReading(container, sample())).toMatchObject({ used: '1.2', total: '4 GiB' });
    expect(formatBytesPair(512 * 1024 ** 2, 4 * GIB)).toEqual({ used: '512 MiB', total: '4 GiB' });
    expect(sharedUnitPair('12 GiB', '不限')).toEqual({ used: '12 GiB', total: '不限' });
  });

  it('falls back to the observed root usage without a live sample', () => {
    expect(rootDiskReading(container, sample())).toMatchObject({ used: '3', total: '20 GiB' });
    expect(rootDiskReading(container, undefined)).toMatchObject({ used: '2', total: '20 GiB', ratio: 0.1 });
  });

  it('drops samples of containers that are not running', () => {
    const stopped = { ...container, actual: { ...container.actual, status: ContainerStatus.Stopped } };
    expect(liveSample(stopped, sample())).toBeUndefined();
    expect(liveSample(container, sample())).toBeDefined();
  });

  it('reads GPU as cards plus VRAM, or nothing without cards', () => {
    expect(gpuReading(container, sample())).toBeNull();
    const withGpu = { ...container, gpu: { nvidiaRuntime: true, pciAddresses: ['00000000:41:00.0'] } };
    expect(gpuReading(withGpu, undefined)).toEqual({ used: null, total: null, ratio: null, lead: '1 卡' });
    const reading = gpuReading(withGpu, sample({
      gpu: { usedBytes: 3 * GIB, limitBytes: 24 * GIB, ratio: 0.125, pciAddresses: ['00000000:41:00.0'] },
    }));
    expect(reading).toMatchObject({ lead: '1 卡', used: '3', total: '24 GiB', ratio: 0.125 });
  });
});

describe('user surfaces carry no CPU pinning', () => {
  it('never shows pinned CPU ids or the binding wording', () => {
    const surfaces = [
      'components/containers/container-table.tsx',
      'components/containers/overview-panel.tsx',
      'components/containers/spec-panel.tsx',
      'components/quota/quota-summary.tsx',
      'pages/dashboard-page.tsx',
      'pages/container-detail-page.tsx',
      'pages/usage-page.tsx',
      'pages/container-usage-page.tsx',
    ].map((path) => readSource(srcRoot, path)).join('\n');
    expect(surfaces).not.toMatch(/formatCpuList|cpuSetLabel|绑定|整核|CPU 组/);
    expect(surfaces).not.toMatch(/label="实例名"/);
  });
});
