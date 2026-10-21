import { describe, expect, it } from 'vitest';
import { scopedPath } from './scoped-paths.js';

describe('scopedPath', () => {
  it('omits scope=mine and keeps filters', () => {
    expect(scopedPath('/performance/usage', 'mine')).toBe('/performance/usage');
    expect(scopedPath('/performance/usage', 'mine', { serverId: 's1', userId: undefined }))
      .toBe('/performance/usage?serverId=s1');
  });

  it('adds scope=all first', () => {
    expect(scopedPath('/servers', 'all')).toBe('/servers?scope=all');
    expect(scopedPath('/performance/series', 'all', { serverId: 's1', range: '1h' }))
      .toBe('/performance/series?scope=all&serverId=s1&range=1h');
  });
});
