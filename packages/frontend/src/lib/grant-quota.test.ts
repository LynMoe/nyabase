import { describe, expect, it } from 'vitest';
import { ContainerPhase, ContainerPowerIntent } from '@nyabase/common';
import { GIB } from './utils.js';
import {
  formatConsumedQuotaParts,
  formatGrantBytes,
  formatGrantQuotaLine,
  formatGpuCount,
  formatGrantQuotaParts,
  formatQuotaDimension,
  formatRemainingBytes,
  runningMemBytes,
} from './grant-quota.js';

describe('formatGrantQuotaParts', () => {
  it('maps null grant ceilings to 不限', () => {
    expect(formatGrantQuotaParts({ cpuCores: null, memBytes: null, rootDiskBytes: null })).toEqual([
      '不限',
      '不限',
      '不限',
    ]);
  });

  it('formats 1 core + 2GiB + 100GiB as 1 核 / 2 GiB / 100 GiB', () => {
    expect(formatGrantQuotaLine({
      cpuCores: 1,
      memBytes: 2 * GIB,
      rootDiskBytes: 100 * GIB,
    })).toBe('1 核 / 2 GiB / 100 GiB');
    expect(formatGrantQuotaParts({
      cpuCores: 1,
      memBytes: 2 * GIB,
      rootDiskBytes: 100 * GIB,
    })).toEqual(['1 核', '2 GiB', '100 GiB']);
  });
});

describe('formatGrantQuotaLine', () => {
  it('omits the GPU summary by default', () => {
    expect(formatGrantQuotaLine({ cpuCores: 2, memBytes: 2 * GIB, rootDiskBytes: 100 * GIB }))
      .toBe('2 核 / 2 GiB / 100 GiB');
  });

  it('appends the GPU summary', () => {
    expect(formatGrantQuotaLine(
      { cpuCores: 2, memBytes: 2 * GIB, rootDiskBytes: 100 * GIB },
      '2 张 GPU',
    )).toBe('2 核 / 2 GiB / 100 GiB / 2 张 GPU');
  });
});

describe('formatConsumedQuotaParts', () => {
  it('prints zeros as 0 核 / 0 GiB, never 不限', () => {
    expect(formatConsumedQuotaParts({ cpuCores: 0, memBytes: 0, rootDiskBytes: 0 }))
      .toEqual(['0 核', '0 GiB', '0 GiB']);
    expect(formatConsumedQuotaParts({ cpuCores: 0, memBytes: 0, rootDiskBytes: 0 }).join(' / '))
      .toBe('0 核 / 0 GiB / 0 GiB');
    expect(formatConsumedQuotaParts({ cpuCores: 0, memBytes: 0, rootDiskBytes: 0 }).join(' / '))
      .not.toMatch(/不限/);
  });

  it('omits null consumed dimensions', () => {
    expect(formatConsumedQuotaParts({ cpuCores: null, memBytes: 0, rootDiskBytes: null }))
      .toEqual(['0 GiB']);
  });
});

describe('formatGpuCount', () => {
  it('reads null as every card and 0 as none', () => {
    expect(formatGpuCount(null)).toBe('全部 GPU');
    expect(formatGpuCount(0)).toBe('无');
    expect(formatGpuCount(2)).toBe('2 张 GPU');
  });
});

describe('formatGrantBytes', () => {
  it('maps null shared limits to 不限', () => {
    expect(formatGrantBytes(null)).toBe('不限');
    expect(formatGrantBytes(100 * GIB)).toBe('100 GiB');
  });
});

describe('formatRemainingBytes', () => {
  it('prints 不限 for unlimited grants and consumed zeros otherwise', () => {
    expect(formatRemainingBytes(null, 0)).toBe('不限');
    expect(formatRemainingBytes(100 * GIB, 0)).toBe('100 GiB');
    expect(formatRemainingBytes(100 * GIB, 20 * GIB)).toBe('80 GiB');
    expect(formatRemainingBytes(100 * GIB, 200 * GIB)).toBe('0 GiB');
  });
});

describe('formatQuotaDimension', () => {
  it('pairs used / limit / remaining for byte grants', () => {
    expect(formatQuotaDimension(100 * GIB, 20 * GIB)).toEqual({
      used: '20 GiB',
      limit: '100 GiB',
      remaining: '80 GiB',
    });
    expect(formatQuotaDimension(null, 20 * GIB)).toEqual({
      used: '20 GiB',
      limit: '不限',
      remaining: '不限',
    });
  });
});

describe('runningMemBytes', () => {
  const row = (memBytes: number, powerIntent: ContainerPowerIntent, lifecyclePhase = ContainerPhase.Active) =>
    ({ memBytes, powerIntent, lifecyclePhase });

  it('counts only desired-running containers', () => {
    expect(runningMemBytes([
      row(2 * GIB, ContainerPowerIntent.Running),
      row(4 * GIB, ContainerPowerIntent.Stopped),
      row(GIB, ContainerPowerIntent.Running, ContainerPhase.Failed),
      row(GIB, ContainerPowerIntent.Running, ContainerPhase.Deleting),
    ])).toBe(2 * GIB);
  });
});
