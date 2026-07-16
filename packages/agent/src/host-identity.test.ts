import { describe, expect, it } from 'vitest';
import { parseAgentConfig } from './config.js';
import { getAgentConfigFingerprint, getHostFingerprint } from './host-identity.js';

describe('getHostFingerprint', () => {
  it('is stable for a static server configuration and machine identity', () => {
    const first = getHostFingerprint();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(getHostFingerprint()).toBe(first);
  });

  it('changes when physical addressing configuration changes', () => {
    const base = parseAgentConfig({
      backendUrl: 'ws://localhost:3001/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      dockerRoot: '/var/lib/nyabase-docker',
      isGpuServer: false,
      localDataSources: [{ id: 'disk-a', mountPoint: '/data/a' }],
    });
    const disks = [{
      diskId: 'disk-a', mountPoint: '/data/a', sourceIdentity: 'local:xfs:uuid-a:fsroot=%2Fa',
      totalBytes: 1, usedBytes: 0, pquotaEnabled: true,
    }];
    const dockerIdentity = 'local:xfs:uuid-a:fsroot=%2Fdocker';
    const fingerprint = getAgentConfigFingerprint(base, disks, dockerIdentity);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(getAgentConfigFingerprint({ ...base, metricsIntervalMs: 1 }, disks, dockerIdentity))
      .toBe(fingerprint);
    expect(getAgentConfigFingerprint({ ...base, dockerRoot: '/different' }, disks, dockerIdentity))
      .not.toBe(fingerprint);
    expect(getAgentConfigFingerprint({ ...base, isGpuServer: true }, disks, dockerIdentity))
      .not.toBe(fingerprint);
    expect(getAgentConfigFingerprint(
      base,
      [{ ...disks[0], sourceIdentity: 'local:xfs:uuid-b:fsroot=%2Fa' }],
      dockerIdentity,
    ))
      .not.toBe(fingerprint);
    expect(getAgentConfigFingerprint(base, disks, 'local:xfs:uuid-a:fsroot=%2Fwrong'))
      .not.toBe(fingerprint);
  });
});
