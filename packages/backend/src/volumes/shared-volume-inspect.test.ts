import { describe, expect, it } from 'vitest';
import { occupancyForCatalogItem } from './shared-volume-inspect.js';

describe('shared catalog occupancy matcher', () => {
  it('emits the six occupancies and skips never-seen nodes', () => {
    expect(occupancyForCatalogItem({
      pgCatalogState: 'absent',
      incusPresent: false,
      hasAttachment: false,
    })).toBe('skip');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'present',
      incusPresent: null,
      hasAttachment: true,
    })).toBe('unreachable');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'present',
      incusPresent: false,
      hasAttachment: true,
    })).toBe('dangling_pg');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'ensuring',
      incusPresent: false,
      hasAttachment: false,
    })).toBe('dangling_pg');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'absent',
      incusPresent: true,
      hasAttachment: false,
    })).toBe('dangling_incus');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'present',
      incusPresent: true,
      hasAttachment: true,
    })).toBe('in_use');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'present',
      incusPresent: true,
      hasAttachment: false,
    })).toBe('cache');
    expect(occupancyForCatalogItem({
      pgCatalogState: 'ensuring',
      incusPresent: true,
      hasAttachment: false,
    })).toBe('ensuring');
  });
});
