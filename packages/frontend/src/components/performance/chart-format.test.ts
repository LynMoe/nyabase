import { describe, expect, it } from 'vitest';
import { formatChartAxis, formatChartStamp } from './chart-format.js';

describe('chart time', () => {
  const iso = '2026-09-23T06:12:30.000Z';
  const date = new Date(iso);

  it('formats a local stamp instead of the raw timestamp', () => {
    const stamp = formatChartStamp(iso, true);
    expect(stamp).not.toContain('T');
    expect(stamp).toBe(`${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`);
    expect(formatChartAxis(iso, true)).toBe(`${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`);
  });
});
