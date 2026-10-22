import { describe, expect, it } from 'vitest';
import { cpuCoresLabel, cpuSetLabel, formatCpuList, groupCpuTopology, parseCpuList } from './cpu-set.js';

describe('formatCpuList', () => {
  it('folds consecutive ids into ranges', () => {
    expect(formatCpuList([])).toBe('');
    expect(formatCpuList([3])).toBe('3');
    expect(formatCpuList([8, 2, 3])).toBe('2-3,8');
    expect(formatCpuList([0, 1, 2, 3, 8, 10, 11])).toBe('0-3,8,10-11');
  });
});

describe('parseCpuList', () => {
  it('accepts lists, ranges and empty input', () => {
    expect(parseCpuList('')).toEqual({ ok: true, cpus: [] });
    expect(parseCpuList('0,1')).toEqual({ ok: true, cpus: [0, 1] });
    expect(parseCpuList(' 0-2，8 1 ')).toEqual({ ok: true, cpus: [0, 1, 2, 8] });
  });

  it('rejects malformed tokens and reversed ranges', () => {
    expect(parseCpuList('a').ok).toBe(false);
    expect(parseCpuList('3-1').ok).toBe(false);
    expect(parseCpuList('-1').ok).toBe(false);
    expect(parseCpuList('99999').ok).toBe(false);
  });
});

describe('cpu labels', () => {
  it('labels container CPU sets and grant cores', () => {
    expect(cpuSetLabel(null)).toBe('待分配');
    expect(cpuSetLabel([2, 3, 8])).toBe('3 核 · 2-3,8');
    expect(cpuCoresLabel(null)).toBe('不限');
    expect(cpuCoresLabel(4)).toBe('4 核');
  });
});

describe('groupCpuTopology', () => {
  it('groups by socket and NUMA node with hyperthread siblings per core', () => {
    const groups = groupCpuTopology([
      { id: 0, core: 0, socket: 0, numa: 0 },
      { id: 2, core: 0, socket: 0, numa: 0 },
      { id: 1, core: 1, socket: 0, numa: 0 },
      { id: 3, core: 0, socket: 1, numa: 1 },
    ]);
    expect(groups).toEqual([
      { key: '0:0', socket: 0, numa: 0, cores: [{ core: 0, cpus: [0, 2] }, { core: 1, cpus: [1] }] },
      { key: '1:1', socket: 1, numa: 1, cores: [{ core: 0, cpus: [3] }] },
    ]);
  });
});
