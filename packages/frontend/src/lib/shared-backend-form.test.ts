import { describe, expect, it } from 'vitest';
import { maxVolumesPerUserLabel, parseMaxVolumesPerUser } from './shared-backend-form.js';

describe('shared backend per-user volume cap', () => {
  it('reads empty as no cap and refuses anything but a whole number from 1', () => {
    expect(parseMaxVolumesPerUser('')).toBeNull();
    expect(parseMaxVolumesPerUser(' 3 ')).toBe(3);
    for (const bad of ['0', '-1', '1.5', 'abc', '10001']) expect(parseMaxVolumesPerUser(bad)).toBeUndefined();
  });

  it('labels the cap', () => {
    expect(maxVolumesPerUserLabel(null)).toBe('不限');
    expect(maxVolumesPerUserLabel(2)).toBe('2 个');
  });
});
