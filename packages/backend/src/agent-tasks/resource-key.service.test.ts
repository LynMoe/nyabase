import { describe, expect, it } from 'vitest';
import { ResourceKeyService } from './resource-key.service.js';

describe('ResourceKeyService physical identities', () => {
  const keys = new ResourceKeyService();

  it('does not split one data directory by logical owner', () => {
    expect(keys.dataDir({
      serverId: 'server-a',
      sourceKind: 'local',
      sourceId: 'disk-a',
      name: 'work',
    })).toBe('datadir:server-a:local:disk-a:work');
  });

  it('serializes a shared remote directory across servers', () => {
    const first = keys.dataDir({
      serverId: 'server-a',
      sourceKind: 'remote',
      sourceId: 'remote-a',
      name: 'work',
    });
    const second = keys.dataDir({
      serverId: 'server-b',
      sourceKind: 'remote',
      sourceId: 'remote-a',
      name: 'work',
    });
    expect(first).toBe('datadir:remote:remote-a:work');
    expect(second).toBe(first);
  });

  it('isolates RemoteFS physical operations by server assignment', () => {
    expect(keys.generic('server-a', 'remote_fs_mount', 'remote-a')).toBe(
      keys.remoteFsAssignment('server-a', 'remote-a'),
    );
    expect(keys.generic('server-b', 'remote_fs_mount', 'remote-a')).toBe(
      keys.remoteFsAssignment('server-b', 'remote-a'),
    );
    expect(keys.remoteFsAssignment('server-a', 'remote-a')).not.toBe(
      keys.remoteFsAssignment('server-b', 'remote-a'),
    );
  });

  it('isolates exact runtime ids by physical server', () => {
    expect(keys.runtime('server-a', 'runtime-a')).toBe('runtime:server-a:runtime-a');
    expect(keys.runtime('server-a', 'runtime-a')).not.toBe(keys.runtime('server-b', 'runtime-a'));
  });
});
