import { describe, expect, it } from 'vitest';
import {
  allocateCpuSet,
  allocatableCpus,
  cpuSetStillFits,
  formatCpuSet,
  parseCpuTopology,
} from './cpu-allocation.js';

/** 2 sockets x 4 cores x 2 threads; thread siblings are id and id + 8 per socket. */
const TOPOLOGY = Array.from({ length: 16 }, (_, id) => ({
  id,
  socket: id < 8 ? 0 : 1,
  core: id % 4,
  numa: id < 8 ? 0 : 1,
})).map((entry) => ({ ...entry, core: entry.socket * 4 + (entry.id % 4) }));

describe('CPU set allocation', () => {
  it('formats sets as ranges so a single CPU is never read as a count', () => {
    expect(formatCpuSet([5])).toBe('5-5');
    expect(formatCpuSet([3, 0, 1, 2, 8, 9, 11])).toBe('0-3,8-9,11-11');
    expect(() => formatCpuSet([])).toThrow();
  });

  it('never hands out reserved CPUs', () => {
    expect(allocatableCpus(TOPOLOGY, [0, 4])).not.toContain(0);
    const set = allocateCpuSet({ topology: TOPOLOGY, reserved: [0, 4], cores: 15, current: [], others: [] });
    expect(set).toHaveLength(14);
    expect(set).not.toContain(0);
    expect(set).not.toContain(4);
  });

  it('completes physical cores before spreading', () => {
    const set = allocateCpuSet({ topology: TOPOLOGY, reserved: [], cores: 2, current: [], others: [] });
    const cores = new Set(set.map((cpu) => TOPOLOGY[cpu]!.core));
    expect(cores.size).toBe(1);
  });

  it('avoids CPUs other users hold while free ones remain', () => {
    const first = allocateCpuSet({ topology: TOPOLOGY, reserved: [], cores: 4, current: [], others: [] });
    const second = allocateCpuSet({ topology: TOPOLOGY, reserved: [], cores: 4, current: [], others: [first] });
    expect(second.filter((cpu) => first.includes(cpu))).toEqual([]);
  });

  it('overlaps only once the free CPUs run out', () => {
    const first = allocateCpuSet({ topology: TOPOLOGY, reserved: [], cores: 12, current: [], others: [] });
    const second = allocateCpuSet({ topology: TOPOLOGY, reserved: [], cores: 6, current: [], others: [first] });
    const overlap = second.filter((cpu) => first.includes(cpu));
    expect(overlap).toHaveLength(2);
  });

  it('keeps the current set stable when only the size changes', () => {
    const current = allocateCpuSet({ topology: TOPOLOGY, reserved: [], cores: 4, current: [], others: [] });
    const grown = allocateCpuSet({ topology: TOPOLOGY, reserved: [], cores: 6, current, others: [] });
    expect(current.every((cpu) => grown.includes(cpu))).toBe(true);
    const shrunk = allocateCpuSet({ topology: TOPOLOGY, reserved: [], cores: 2, current: grown, others: [] });
    expect(shrunk.every((cpu) => grown.includes(cpu))).toBe(true);
  });

  it('moves off a CPU that became reserved', () => {
    const current = [0, 1, 2, 3];
    expect(cpuSetStillFits(current, 4, TOPOLOGY, [2])).toBe(false);
    const moved = allocateCpuSet({ topology: TOPOLOGY, reserved: [2], cores: 4, current, others: [] });
    expect(moved).not.toContain(2);
    expect(moved).toEqual(expect.arrayContaining([0, 1, 3]));
    expect(cpuSetStillFits(moved, 4, TOPOLOGY, [2])).toBe(true);
  });

  it('parses Incus resources and skips offline CPUs', () => {
    const topology = parseCpuTopology({
      cpu: {
        sockets: [{
          socket: 0,
          cores: [
            { core: 0, threads: [{ id: 0, numa_node: 0, online: true }, { id: 2, numa_node: 0, online: true }] },
            { core: 1, threads: [{ id: 1, numa_node: 0, online: true }, { id: 3, numa_node: 0, online: false }] },
          ],
        }],
      },
    });
    expect(topology).toEqual([
      { id: 0, core: 0, socket: 0, numa: 0 },
      { id: 1, core: 1, socket: 0, numa: 0 },
      { id: 2, core: 0, socket: 0, numa: 0 },
    ]);
  });
});

describe('CPU set allocation at scale', () => {
  it('allocates on a 256-thread host quickly and deterministically', () => {
    const topology = Array.from({ length: 256 }, (_, id) => ({
      id,
      socket: id < 128 ? 0 : 1,
      core: id % 64 + (id < 128 ? 0 : 64),
      numa: id < 128 ? 0 : 1,
    }));
    const others = Array.from({ length: 20 }, (_, index) => Array.from({ length: 8 }, (__, cpu) => index * 8 + cpu));
    const started = performance.now();
    const set = allocateCpuSet({ topology, reserved: [0, 64], cores: 96, current: [], others });
    expect(performance.now() - started).toBeLessThan(250);
    expect(set).toHaveLength(96);
    expect(set).not.toContain(0);
    expect(set.filter((cpu) => others.flat().includes(cpu))).toEqual([]);
    expect(allocateCpuSet({ topology, reserved: [0, 64], cores: 96, current: [], others })).toEqual(set);
  });
});
