import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { parseAgentConfig } from './config.js';
import {
  assertQuotaMountTopology,
  HostStorageIdentityGuard,
  parseMountInfo,
} from './host-storage.js';

describe('parseMountInfo', () => {
  it('captures exact XFS project-quota mount identity and decodes paths', () => {
    const mounts = parseMountInfo([
      '36 25 8:1 / / rw,relatime - ext4 /dev/root rw',
      '42 36 8:2 / /var/lib/nyabase-docker rw,relatime,pquota - xfs /dev/sdb rw,attr2,inode64,pquota',
      '43 36 8:3 / /data\\040main rw,prjquota - xfs /dev/sdc rw,prjquota',
    ].join('\n'));
    expect(mounts).toEqual([
      expect.objectContaining({ deviceId: '8:1', fsRoot: '/', mountPoint: '/', fsType: 'ext4' }),
      expect.objectContaining({ deviceId: '8:2', fsRoot: '/', mountPoint: '/var/lib/nyabase-docker', fsType: 'xfs' }),
      expect.objectContaining({ deviceId: '8:3', fsRoot: '/', mountPoint: '/data main', fsType: 'xfs' }),
    ]);
    expect(mounts[1].superOptions.has('pquota')).toBe(true);
    expect(mounts[2].mountOptions.has('prjquota')).toBe(true);
  });

  it('rejects two aliases of the same physical filesystem root', () => {
    const mounts = parseMountInfo([
      '42 36 8:2 /docker /var/lib/nyabase-docker rw,pquota - xfs /dev/sdb rw,pquota',
      '43 36 8:2 /docker /data rw,pquota - xfs /dev/sdb rw,pquota',
    ].join('\n'));
    expect(() => assertQuotaMountTopology(
      ['/var/lib/nyabase-docker', '/data'], mounts,
    )).toThrow('distinct filesystem roots');
  });

  it('accepts distinct bind roots on one XFS device', () => {
    const mounts = parseMountInfo([
      '42 36 8:2 /docker /var/lib/nyabase-docker rw,pquota - xfs /dev/sdb rw,pquota',
      '43 36 8:2 /users /data rw,pquota - xfs /dev/sdb rw,pquota',
    ].join('\n'));
    expect(() => assertQuotaMountTopology(
      ['/var/lib/nyabase-docker', '/data'], mounts,
    )).not.toThrow();
  });

  it('rejects multiple quota filesystems and non-XFS roots', () => {
    const mounts = parseMountInfo([
      '42 36 8:2 / /var/lib/nyabase-docker rw,pquota - xfs /dev/sdb rw,pquota',
      '43 36 8:3 / /data rw,pquota - xfs /dev/sdc rw,pquota',
    ].join('\n'));
    expect(() => assertQuotaMountTopology(
      ['/var/lib/nyabase-docker', '/data'], mounts,
    )).toThrow('one shared XFS filesystem');
    expect(() => assertQuotaMountTopology(['/missing'], mounts)).toThrow('exact filesystem mount');
  });
});

describe('HostStorageIdentityGuard', () => {
  it('fail-stops when a configured mount is hot-swapped', () => {
    const config = parseAgentConfig({
      backendUrl: 'ws://localhost:3001/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      dockerRoot: '/var/lib/nyabase-docker',
      isGpuServer: false,
      localDataSources: [{ id: 'disk-a', mountPoint: '/data/a' }],
    });
    const identities = new Map([
      ['/var/lib/nyabase-docker', 'local:xfs:uuid:fsroot=%2Fdocker'],
      ['/data/a', 'local:xfs:uuid:fsroot=%2Fdata-a'],
    ]);
    const fatalHook = vi.fn();
    const guard = new HostStorageIdentityGuard(config, {
      readIdentity: (root) => identities.get(root)!,
      assertLayout: vi.fn(),
      fatalHook,
    });
    guard.assertCurrent();

    identities.set('/data/a', 'local:xfs:uuid:fsroot=%2Fdata-b');

    expect(() => guard.assertCurrent()).toThrow('storage identity changed');
    expect(fatalHook).toHaveBeenCalledTimes(1);
  });
});
