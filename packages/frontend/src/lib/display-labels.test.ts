import { describe, expect, it } from 'vitest';
import { knownPreflightChecks, preflightCheckLabel, storageOvercommitLabel } from './display-labels.js';

describe('storageOvercommitLabel', () => {
  it('says plainly when there is no overcommit', () => {
    expect(storageOvercommitLabel(1)).toBe('1×（不超分，按物理容量分配）');
  });

  it('spells out the multiplier above 1', () => {
    expect(storageOvercommitLabel('1.5')).toBe('1.5×（最多分配物理容量的 1.5 倍）');
  });

  it('passes through values it cannot read', () => {
    expect(storageOvercommitLabel('abc')).toBe('abc');
  });
});

describe('knownPreflightChecks', () => {
  it('lists known checks in display order and drops retired ones from old reports', () => {
    const shown = knownPreflightChecks({
      nodeMetrics: 'warn',
      guestCanReachHost: 'fail',
      api: 'pass',
      egress: 'fail',
    });
    expect(shown).toEqual([['api', 'pass'], ['nodeMetrics', 'warn']]);
    expect(preflightCheckLabel('guestAddress')).toBe('容器 IP');
  });
});
