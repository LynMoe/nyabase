import type { PerformanceSeriesLine } from '@nyabase/common';

const COLORS = [
  'hsl(221 83% 53%)',
  'hsl(173 58% 39%)',
  'hsl(32 90% 42%)',
  'hsl(346 72% 48%)',
  'hsl(262 47% 50%)',
  'hsl(199 80% 38%)',
  'hsl(142 45% 34%)',
  'hsl(24 75% 42%)',
];

/** Stable colour per line key, so one person has one colour on every chart. */
export function chartColor(key: string): string {
  if (key === 'host' || key === 'other') return 'hsl(221 83% 53%)';
  let result = 0;
  for (const char of key) result = (result * 33 + char.charCodeAt(0)) >>> 0;
  return COLORS[result % COLORS.length] ?? COLORS[0];
}

export function latestValue(line: PerformanceSeriesLine): number | null {
  for (let index = line.points.length - 1; index >= 0; index -= 1) {
    const value = line.points[index]?.v;
    if (value != null) return value;
  }
  return null;
}
