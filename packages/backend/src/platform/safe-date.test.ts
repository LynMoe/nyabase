import { describe, expect, it } from 'vitest';
import { ECMASCRIPT_DATE_MAX_EPOCH_MS } from '@nyabase/common';
import { safeEpochToIso } from './safe-date.js';

describe('safeEpochToIso', () => {
  it('projects safe ECMAScript epochs and rejects poisoned cached values', () => {
    expect(safeEpochToIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(safeEpochToIso(ECMASCRIPT_DATE_MAX_EPOCH_MS)).toBe('+275760-09-13T00:00:00.000Z');
    for (const value of [
      -1,
      ECMASCRIPT_DATE_MAX_EPOCH_MS + 1,
      Number.MAX_SAFE_INTEGER + 1,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      '1',
      null,
    ]) expect(safeEpochToIso(value)).toBeNull();
  });
});
