import { describe, expect, it } from 'vitest';
import { formatBytesCompact, formatRate } from './utils.js';

describe('performance number formatting', () => {
  it('rounds sub-kilobyte rates and byte totals', () => {
    expect(formatRate(446.42023865075663)).toBe('446 B/s');
    expect(formatRate(1.2 * 1024)).toBe('1.2 KiB/s');
    expect(formatRate(3.4 * 1024 * 1024)).toBe('3.4 MiB/s');
    expect(formatRate(0)).toBe('0 B/s');
    expect(formatRate(12 * 1024)).toBe('12 KiB/s');
    expect(formatRate(Number.NaN)).toBe('—');
    expect(formatBytesCompact(446.42023865075663)).toBe('446 B');
    expect(formatBytesCompact(1400 * 1024 ** 3)).toBe('1.4 TiB');
    expect(formatRate(3 * 1024 ** 4)).toBe('3.0 TiB/s');
  });
});
