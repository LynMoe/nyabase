import { describe, expect, it } from 'vitest';
import { formatAggregateGpuText, formatAssignedGpuText, formatBytesCompact, formatGpuText, formatHostGpuText, formatRate } from './utils.js';

describe('performance number formatting', () => {
  it('rounds sub-kilobyte rates and byte totals', () => {
    expect(formatRate(446.42023865075663)).toBe('446 B/s');
    expect(formatRate(1.2 * 1024)).toBe('1.2 KB/s');
    expect(formatRate(3.4 * 1024 * 1024)).toBe('3.4 MB/s');
    expect(formatRate(0)).toBe('0 B/s');
    expect(formatRate(12 * 1024)).toBe('12 KB/s');
    expect(formatRate(Number.NaN)).toBe('—');
    expect(formatBytesCompact(446.42023865075663)).toBe('446B');
  });

  it('omits VRAM when there is no used amount and no ratio', () => {
    expect(formatGpuText(null)).toBeNull();
    expect(formatGpuText({ usedBytes: 0, totalBytes: null })).toBeNull();
    expect(formatGpuText({ usedBytes: 1.2 * 1024 ** 3, totalBytes: null })).toBe('1.2G');
    expect(formatGpuText({ usedBytes: 12, totalBytes: 100 })).toBe('12.0%');
    expect(formatAssignedGpuText({ usedBytes: 1.2 * 1024 ** 3, pciAddresses: [] })).toBe('1.2G');
    expect(formatAssignedGpuText({ usedBytes: 0, limitBytes: 100, ratio: 0, pciAddresses: ['0000:81:00.0'] })).toBe('0.0%');
    expect(formatAssignedGpuText({ usedBytes: null, limitBytes: null, pciAddresses: [] })).toBeNull();
    expect(formatHostGpuText([])).toBeNull();
    expect(formatHostGpuText([{ usedBytes: null, totalBytes: 100 }])).toBeNull();
    expect(formatHostGpuText([{ usedBytes: null, totalBytes: 100 }, { usedBytes: 40, totalBytes: 100 }])).toBe('40B');
    expect(formatHostGpuText([{ usedBytes: 12, totalBytes: 100 }, { usedBytes: 0, totalBytes: 100 }])).toBe('6.0%');
    expect(formatAggregateGpuText([
      { usedBytes: null, limitBytes: null, pciAddresses: [] },
      { usedBytes: 50, limitBytes: 100, pciAddresses: ['0000:21:00.0'] },
    ])).toBe('50.0%');
  });
});
