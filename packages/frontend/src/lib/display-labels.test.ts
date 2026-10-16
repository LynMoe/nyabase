import { describe, expect, it } from 'vitest';
import { storageOvercommitLabel } from './display-labels.js';

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
