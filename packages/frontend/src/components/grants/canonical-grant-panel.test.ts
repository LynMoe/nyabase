import { describe, expect, it } from 'vitest';
import { toDatetimeLocalValue } from './canonical-grant-panel.js';

describe('toDatetimeLocalValue', () => {
  it('formats local calendar time without seconds or timezone', () => {
    const date = new Date(2026, 0, 15, 9, 5, 30);
    expect(toDatetimeLocalValue(date)).toBe('2026-01-15T09:05');
  });
});
