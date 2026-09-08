import { describe, expect, it } from 'vitest';
import { isLocalStoragePool } from './storage-pool-product.js';

describe('isLocalStoragePool', () => {
  it('keeps unmapped non-shareable pools', () => {
    expect(isLocalStoragePool({
      shareable: false,
      driver: 'dir',
      sharedBackendId: null,
    })).toBe(true);
  });

  it('excludes CephFS executors even before registration', () => {
    expect(isLocalStoragePool({ shareable: true, driver: 'cephfs', sharedBackendId: null })).toBe(false);
  });

  it('excludes pools mapped to a shared backend', () => {
    expect(isLocalStoragePool({
      shareable: false,
      driver: 'dir',
      sharedBackendId: '11111111-1111-4111-8111-111111111111',
    })).toBe(false);
  });
});
