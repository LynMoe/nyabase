import { describe, expect, it } from 'vitest';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';

describe('AccessCacheEpochService', () => {
  it('advances monotonically for post-commit invalidation fences', () => {
    const epoch = new AccessCacheEpochService();
    expect(epoch.current()).toBe(0);
    expect(epoch.bump()).toBe(1);
    expect(epoch.bump()).toBe(2);
    expect(epoch.current()).toBe(2);
  });
});
