import { describe, expect, it } from 'vitest';
import { GIB } from './utils.js';
import {
  formatAllocatedCpuMem,
  formatConsumedQuotaParts,
  formatGrantBytes,
  formatGrantQuotaLine,
  formatGrantQuotaParts,
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

  it('formats 1000ms + 2GiB + 100GiB as 1C / 2G / 100G', () => {
    expect(formatGrantQuotaLine({
      cpuMillis: 1000,
      memBytes: 2 * GIB,
      diskBytes: 100 * GIB,
    })).toBe('1C / 2G / 100G');
    expect(formatGrantQuotaParts({
      cpuMillis: 1000,
      memBytes: 2 * GIB,
      diskBytes: 100 * GIB,
    })).toEqual(['1C', '2G', '100G']);
  });
});

describe('formatGrantQuotaLine', () => {
  it('defaults extension chips to an empty list', () => {
    expect(formatGrantQuotaLine({ cpuMillis: 2000, memBytes: 2 * GIB, diskBytes: 100 * GIB }))
      .toBe('2C / 2G / 100G');
  });

  it('appends caller-supplied extension chips', () => {
    expect(formatGrantQuotaLine(
      { cpuMillis: 2000, memBytes: 2 * GIB, diskBytes: 100 * GIB },
      ['2GPU'],
    )).toBe('2C / 2G / 100G / 2GPU');
  });
});

describe('formatConsumedQuotaParts', () => {
  it('prints zeros as 0C / 0G, never 不限', () => {
    expect(formatConsumedQuotaParts({ cpuMillis: 0, memBytes: 0, diskBytes: 0 }))
      .toEqual(['0C', '0G', '0G']);
    expect(formatConsumedQuotaParts({ cpuMillis: 0, memBytes: 0, diskBytes: 0 }).join(' / '))
      .toBe('0C / 0G / 0G');
    expect(formatConsumedQuotaParts({ cpuMillis: 0, memBytes: 0, diskBytes: 0 }).join(' / '))
      .not.toMatch(/不限/);
  });

  it('omits null consumed dimensions', () => {
    expect(formatConsumedQuotaParts({ cpuMillis: null, memBytes: 0, diskBytes: null }))
      .toEqual(['0G']);
  });
});

describe('formatGrantBytes', () => {
  it('maps 0/null shared limits to 不限', () => {
    expect(formatGrantBytes(0)).toBe('不限');
    expect(formatGrantBytes(null)).toBe('不限');
    expect(formatGrantBytes(100 * GIB)).toBe('100G');
  });
});

describe('formatAllocatedCpuMem', () => {
  it('prints an empty container list as 0C / 0G, never 不限', () => {
    expect(formatAllocatedCpuMem([])).toBe('0C / 0G');
    expect(formatAllocatedCpuMem([])).not.toMatch(/不限/);
  });

  it('sums allocated spec across containers', () => {
    expect(formatAllocatedCpuMem([
      { cpuMillis: 500, memBytes: GIB },
      { cpuMillis: 500, memBytes: GIB },
    ])).toBe('1C / 2G');
  });
});

describe('formatRemainingCpu / formatRemainingBytes', () => {
  it('prints 不限 for unlimited grants and consumed zeros otherwise', () => {
    expect(formatRemainingCpu(null, 0)).toBe('不限');
    expect(formatRemainingCpu(0, 0)).toBe('不限');
    expect(formatRemainingBytes(null, 0)).toBe('不限');
    expect(formatRemainingBytes(0, 0)).toBe('不限');
    expect(formatRemainingBytes(100 * GIB, 0)).toBe('100G');
    expect(formatRemainingBytes(100 * GIB, 20 * GIB)).toBe('80G');
    expect(formatRemainingBytes(100 * GIB, 200 * GIB)).toBe('0G');
    expect(formatRemainingCpu(2000, 0)).toBe('2C');
  });
});
