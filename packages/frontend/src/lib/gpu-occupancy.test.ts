import { describe, expect, it } from 'vitest';
import type { PerformanceHostGpu } from '@nyabase/common';
import { freeGpuCount, GPU_HELD_MEMORY_BYTES, grantedGpuCards, gpuCardRows, gpuCardState } from './gpu-occupancy.js';

const GIB = 1024 ** 3;

function card(pci: string, index: number | null, patch: Partial<PerformanceHostGpu> = {}): PerformanceHostGpu {
  return { pci, index, usedBytes: 0, totalBytes: 80 * GIB, ratio: 0, utilRatio: 0, users: [], ...patch };
}

describe('gpuCardState', () => {
  it('is free with no process and only driver memory', () => {
    expect(gpuCardState(card('a', 0, { usedBytes: 4 * 1024 ** 2 }), 'me')).toBe('free');
  });

  it('is mine as soon as one of my processes is on it, even shared', () => {
    const shared = card('a', 0, {
      users: [
        { userId: 'bob', displayName: '李娜', memoryBytes: 30 * GIB, smRatio: 0.4 },
        { userId: 'me', displayName: '我', memoryBytes: 2 * GIB, smRatio: 0.1 },
      ],
    });
    expect(gpuCardState(shared, 'me')).toBe('mine');
    expect(gpuCardState(shared, 'carol')).toBe('others');
  });

  it('counts held memory without a listed process as taken', () => {
    expect(gpuCardState(card('a', 0, { usedBytes: GPU_HELD_MEMORY_BYTES }), 'me')).toBe('others');
  });

  it('is unknown without a memory reading', () => {
    expect(gpuCardState(card('a', 0, { usedBytes: null }), 'me')).toBe('unknown');
  });
});

describe('gpuCardRows', () => {
  it('names me 你, unattributed processes 其他, and scales memory to the card', () => {
    const rows = gpuCardRows(card('a', 0, {
      users: [
        { userId: 'me', displayName: '我', memoryBytes: 40 * GIB, smRatio: 0.9 },
        { userId: null, displayName: null, memoryBytes: 8 * GIB, smRatio: null },
      ],
    }), 'me');
    expect(rows).toEqual([
      { key: 'me', name: '你', mine: true, memoryBytes: 40 * GIB, memoryRatio: 0.5, smRatio: 0.9 },
      { key: 'others', name: '其他', mine: false, memoryBytes: 8 * GIB, memoryRatio: 0.1, smRatio: null },
    ]);
  });

  it('shows held memory without processes as one 其他 row with the card utilization', () => {
    const rows = gpuCardRows(card('a', 0, { usedBytes: 20 * GIB, utilRatio: 0.3 }), 'me');
    expect(rows).toEqual([{ key: 'others', name: '其他', mine: false, memoryBytes: 20 * GIB, memoryRatio: 0.25, smRatio: 0.3 }]);
  });
});

describe('grantedGpuCards', () => {
  it('keeps only granted cards, in nvidia-smi order, matching PCI addresses canonically', () => {
    const host = [
      card('0000:03:00.0', 2),
      card('0000:01:00.0', 0, { users: [{ userId: 'bob', displayName: '李娜', memoryBytes: GIB, smRatio: 0.5 }] }),
      card('0000:02:00.0', 1),
    ];
    const cards = grantedGpuCards(['0000:03:00.0', '0000:01:00.0'], host, 'me');
    expect(cards.map((item) => [item.index, item.state])).toEqual([[0, 'others'], [2, 'free']]);
    expect(freeGpuCount(cards)).toBe(1);
  });

  it('marks granted cards the snapshot lacks as unknown', () => {
    const cards = grantedGpuCards(['0000:01:00.0'], null, 'me');
    expect(cards).toEqual([{ pci: '0000:01:00.0', index: null, state: 'unknown', totalBytes: null, rows: [] }]);
    expect(freeGpuCount(cards)).toBe(0);
  });
});
