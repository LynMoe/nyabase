import { describe, expect, it } from 'vitest';
import { containerUsesDataDir } from './data-dir-identity.js';

const mount = { id: 'm1', sourceKind: 'local' as const, sourceId: 'disk-1', dirName: 'work', containerPath: '/work' };

describe('containerUsesDataDir', () => {
  it('includes source kind and local server identity', () => {
    const container = { serverId: 'server-a', mounts: [mount] };
    expect(containerUsesDataDir(container, {
      serverId: 'server-a', sourceKind: 'local', sourceId: 'disk-1', name: 'work',
    })).toBe(true);
    expect(containerUsesDataDir(container, {
      serverId: 'server-b', sourceKind: 'local', sourceId: 'disk-1', name: 'work',
    })).toBe(false);
    expect(containerUsesDataDir(container, {
      serverId: 'server-a', sourceKind: 'remote', sourceId: 'disk-1', name: 'work',
    })).toBe(false);
  });
});
