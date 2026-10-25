import { describe, expect, it } from 'vitest';
import { zCreateContainerRequest, zCreateVolumeRequest } from '@nyabase/common';
import { dateStamp, defaultResourceName } from './default-names.js';

const OCT_25 = new Date(2026, 9, 25, 23, 59);

describe('dateStamp', () => {
  it('formats the local date as yymmdd', () => {
    expect(dateStamp(OCT_25)).toBe('261025');
    expect(dateStamp(new Date(2030, 0, 5, 0, 0))).toBe('300105');
  });
});

describe('defaultResourceName', () => {
  it('uses the bare date name when it is free', () => {
    expect(defaultResourceName('ins', [], OCT_25)).toBe('ins-261025');
    expect(defaultResourceName('vol', ['ins-261025'], OCT_25)).toBe('vol-261025');
  });

  it('appends -2, -3, … past taken names', () => {
    expect(defaultResourceName('ins', ['ins-261025'], OCT_25)).toBe('ins-261025-2');
    expect(defaultResourceName('ins', ['ins-261025', 'ins-261025-2', 'ins-261025-4'], OCT_25)).toBe('ins-261025-3');
  });

  it('compares names case-insensitively and ignores surrounding spaces', () => {
    expect(defaultResourceName('vol', [' VOL-261025 ', 'Vol-261025-2'], OCT_25)).toBe('vol-261025-3');
  });

  it('passes the container and volume name validation', () => {
    const container = defaultResourceName('ins', ['ins-261025'], OCT_25);
    expect(zCreateContainerRequest.shape.name.safeParse(container).success).toBe(true);
    const volume = defaultResourceName('vol', [], OCT_25);
    expect(zCreateVolumeRequest.shape.name.safeParse(volume).success).toBe(true);
  });
});
