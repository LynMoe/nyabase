import { describe, expect, it } from 'vitest';
import { GIB } from './utils.js';
import {
  formatAllocatedCpuMem,
  formatConsumedQuotaParts,
  formatGrantBytes,
  formatGrantQuotaLine,
  formatGrantQuotaParts,
  formatQuotaDimension,
  formatRemainingBytes,
  formatRemainingCpu,
} from './grant-quota.js';

describe('formatGrantQuotaParts', () => {
  it('maps null and 0 grant ceilings to 不限', () => {
    expect(formatGrantQuotaParts({ cpuMillis: null, memBytes: null, diskBytes: null })).toEqual([
      '不限',
      '不限',
      '不限',
    ]);
    expect(formatGrantQuotaParts({ cpuMillis: 0, memBytes: 0, diskBytes: 0 })).toEqual([
      '不限',
      '不限',
      '不限',
    ]);
  });

  it('formats 1000ms + 2GiB + 100GiB as 1 核 / 2 GiB / 100 GiB', () => {
    expect(formatGrantQuotaLine({
      cpuMillis: 1000,
      memBytes: 2 * GIB,
      diskBytes: 100 * GIB,
    })).toBe('1 核 / 2 GiB / 100 GiB');
    expect(formatGrantQuotaParts({
      cpuMillis: 1000,
      memBytes: 2 * GIB,
      diskBytes: 100 * GIB,
    })).toEqual(['1 核', '2 GiB', '100 GiB']);
  });
});

describe('formatGrantQuotaLine', () => {
  it('defaults extension chips to an empty list', () => {
    expect(formatGrantQuotaLine({ cpuMillis: 2000, memBytes: 2 * GIB, diskBytes: 100 * GIB }))
      .toBe('2 核 / 2 GiB / 100 GiB');
  });

  it('appends caller-supplied extension chips', () => {
    expect(formatGrantQuotaLine(
      { cpuMillis: 2000, memBytes: 2 * GIB, diskBytes: 100 * GIB },
      ['2 张 GPU'],
    )).toBe('2 核 / 2 GiB / 100 GiB / 2 张 GPU');
  });
});

describe('formatConsumedQuotaParts', () => {
  it('prints zeros as 0 核 / 0 GiB, never 不限', () => {
    expect(formatConsumedQuotaParts({ cpuMillis: 0, memBytes: 0, diskBytes: 0 }))
      .toEqual(['0 核', '0 GiB', '0 GiB']);
    expect(formatConsumedQuotaParts({ cpuMillis: 0, memBytes: 0, diskBytes: 0 }).join(' / '))
      .toBe('0 核 / 0 GiB / 0 GiB');
    expect(formatConsumedQuotaParts({ cpuMillis: 0, memBytes: 0, diskBytes: 0 }).join(' / '))
      .not.toMatch(/不限/);
  });

  it('omits null consumed dimensions', () => {
    expect(formatConsumedQuotaParts({ cpuMillis: null, memBytes: 0, diskBytes: null }))
      .toEqual(['0 GiB']);
  });
});

describe('formatGrantBytes', () => {
  it('maps 0/null shared limits to 不限', () => {
    expect(formatGrantBytes(0)).toBe('不限');
    expect(formatGrantBytes(null)).toBe('不限');
    expect(formatGrantBytes(100 * GIB)).toBe('100 GiB');
  });
});

describe('formatAllocatedCpuMem', () => {
  it('prints an empty container list as 0 核 / 0 GiB, never 不限', () => {
    expect(formatAllocatedCpuMem([])).toBe('0 核 / 0 GiB');
    expect(formatAllocatedCpuMem([])).not.toMatch(/不限/);
  });

  it('sums allocated spec across containers', () => {
    expect(formatAllocatedCpuMem([
      { cpuMillis: 500, memBytes: GIB },
      { cpuMillis: 500, memBytes: GIB },
    ])).toBe('1 核 / 2 GiB');
  });
});

describe('formatRemainingCpu / formatRemainingBytes', () => {
  it('prints 不限 for unlimited grants and consumed zeros otherwise', () => {
    expect(formatRemainingCpu(null, 0)).toBe('不限');
    expect(formatRemainingCpu(0, 0)).toBe('不限');
    expect(formatRemainingBytes(null, 0)).toBe('不限');
    expect(formatRemainingBytes(0, 0)).toBe('不限');
    expect(formatRemainingBytes(100 * GIB, 0)).toBe('100 GiB');
    expect(formatRemainingBytes(100 * GIB, 20 * GIB)).toBe('80 GiB');
    expect(formatRemainingBytes(100 * GIB, 200 * GIB)).toBe('0 GiB');
    expect(formatRemainingCpu(2000, 0)).toBe('2 核');
  });
});

describe('formatQuotaDimension', () => {
  it('pairs used / limit / remaining for cpu and bytes', () => {
    expect(formatQuotaDimension(4000, 1000, 'cpu')).toEqual({
      used: '1 核',
      limit: '4 核',
      remaining: '3 核',
    });
    expect(formatQuotaDimension(100 * GIB, 20 * GIB, 'bytes')).toEqual({
      used: '20 GiB',
      limit: '100 GiB',
      remaining: '80 GiB',
    });
    expect(formatQuotaDimension(null, 20 * GIB, 'bytes')).toEqual({
      used: '20 GiB',
      limit: '不限',
      remaining: '不限',
    });
  });
});
