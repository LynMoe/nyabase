import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentConfig, parseAgentConfig } from './config.js';

describe('loadAgentConfig', () => {
  const tempDirs: string[] = [];
  const originalArgv = [...process.argv];

  afterEach(async () => {
    process.argv.splice(0, process.argv.length, ...originalArgv);
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('parses string localDataSources from config/env-shaped input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nyabase-agent-config-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'agent.yaml');
    await writeFile(configPath, [
      'backendUrl: ws://localhost:3001/ws/agent',
      'agentToken: "0123456789abcdef"',
      'serverId: "server-a"',
      'dockerRoot: "/var/lib/nyabase-docker"',
      'parentIface: "eth0"',
      'macvlanCidr: "192.168.100.0/24"',
      'macvlanGateway: "192.168.100.1"',
      'reservedIps: []',
      'metricsIntervalMs: 10000',
      'isGpuServer: false',
      'dockerResourceLimit:',
      '  enabled: false',
      'localDataSources: \'[{"id":"local-main","mountPoint":"/data","label":"Main data"}]\'',
      '',
    ].join('\n'));
    await chmod(configPath, 0o600);
    process.argv.push('--config', configPath);

    const config = loadAgentConfig();
    expect(config.localDataSources).toEqual([{
      id: 'local-main',
      mountPoint: '/data',
      label: 'Main data',
    }]);
  });

  it('rejects plaintext non-loopback Backend transport', () => {
    expect(() => parseAgentConfig({
      backendUrl: 'ws://backend.example/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      isGpuServer: false,
      localDataSources: [],
    })).toThrow('backendUrl must use wss://');
    expect(() => parseAgentConfig({
      backendUrl: 'http://backend.example/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      isGpuServer: false,
      localDataSources: [],
    })).toThrow('backendUrl must use wss://');
  });

  it('rejects ambiguous or unbounded Agent and local-source identities', () => {
    const base = {
      backendUrl: 'ws://localhost:3001/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      dockerRoot: '/var/lib/nyabase-docker',
      isGpuServer: false,
      localDataSources: [],
    };
    expect(() => parseAgentConfig({ ...base, serverId: '../server' })).toThrow(
      'serverId contains unsupported characters',
    );
    expect(() => parseAgentConfig({
      ...base,
      localDataSources: [{ id: '../disk', mountPoint: '/srv/data' }],
    })).toThrow('localDataSources.id contains unsupported characters');
    expect(() => parseAgentConfig({
      ...base,
      localDataSources: [{ id: 'disk-a', mountPoint: '/srv/data', typo: true }],
    })).toThrow();
    expect(() => parseAgentConfig({
      ...base,
      dockerResourceLimit: { enabled: false, typo: true },
    })).toThrow();
  });

  it('rejects the retired stateDir instead of silently stripping it', () => {
    expect(() => parseAgentConfig({
      backendUrl: 'ws://localhost:3001/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      stateDir: '/tmp/legacy-agent-state',
      isGpuServer: false,
      localDataSources: [],
    })).toThrow('Unrecognized key');
  });

  it('bounds the lossy metrics cadence away from timer and queue overload', () => {
    const base = {
      backendUrl: 'ws://localhost:3001/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      isGpuServer: false,
      localDataSources: [],
    };
    expect(() => parseAgentConfig({ ...base, metricsIntervalMs: 4_999 }))
      .toThrow();
    expect(parseAgentConfig({ ...base, metricsIntervalMs: 5_000 }).metricsIntervalMs)
      .toBe(5_000);
    expect(() => parseAgentConfig({ ...base, metricsIntervalMs: 300_001 }))
      .toThrow();
  });

  it('coerces only exact env scalar grammar and rejects explicit malformed values', () => {
    const base = {
      backendUrl: 'ws://localhost:3001/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      localDataSources: [],
    };
    expect(parseAgentConfig({
      ...base,
      metricsIntervalMs: '10000',
      isGpuServer: 'false',
      dockerResourceLimit: { enabled: '1' },
    })).toMatchObject({
      metricsIntervalMs: 10_000,
      isGpuServer: false,
      dockerResourceLimit: { enabled: true },
    });
    expect(parseAgentConfig({ ...base, isGpuServer: '0' }).isGpuServer).toBe(false);
    expect(parseAgentConfig({ ...base, isGpuServer: 'true' }).isGpuServer).toBe(true);
    expect(parseAgentConfig({ ...base, isGpuServer: '1' }).isGpuServer).toBe(true);

    for (const metricsIntervalMs of ['', '10000garbage', ' 10000', {}, [], null]) {
      expect(() => parseAgentConfig({ ...base, metricsIntervalMs })).toThrow();
    }
    for (const isGpuServer of ['', 'definitely', 'TRUE', {}, [], null]) {
      expect(() => parseAgentConfig({ ...base, isGpuServer })).toThrow();
    }
    for (const enabled of ['', 'yes', 'FALSE', {}, [], null]) {
      expect(() => parseAgentConfig({
        ...base,
        dockerResourceLimit: { enabled },
      })).toThrow();
    }
    for (const dockerResourceLimit of [{}, { enabled: undefined }]) {
      expect(() => parseAgentConfig({ ...base, dockerResourceLimit })).toThrow();
    }
    expect(parseAgentConfig({ ...base }).dockerResourceLimit).toEqual({ enabled: false });
  });

  it('defaults absent collections but rejects explicitly malformed collection shapes', () => {
    const base = {
      backendUrl: 'ws://localhost:3001/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      isGpuServer: false,
    };
    expect(parseAgentConfig(base)).toMatchObject({ localDataSources: [], reservedIps: [] });
    expect(parseAgentConfig({
      ...base,
      localDataSources: '[{"id":"disk-a","mountPoint":"/data"}]',
      reservedIps: '192.168.100.2, 192.168.100.3',
    })).toMatchObject({
      localDataSources: [{ id: 'disk-a', mountPoint: '/data' }],
      reservedIps: ['192.168.100.2', '192.168.100.3'],
    });
    expect(parseAgentConfig({ ...base, localDataSources: '', reservedIps: '' }))
      .toMatchObject({ localDataSources: [], reservedIps: [] });

    for (const localDataSources of [{ id: 'disk-a', mountPoint: '/data' }, null, 7, true]) {
      expect(() => parseAgentConfig({ ...base, localDataSources })).toThrow();
    }
    for (const reservedIps of [{ value: '192.168.100.2' }, null, 7, true, '192.168.100.2,,192.168.100.3']) {
      expect(() => parseAgentConfig({ ...base, reservedIps })).toThrow();
    }
  });

  it('rejects overlapping local, Docker, and RemoteFS host roots', () => {
    const base = {
      backendUrl: 'ws://localhost:3001/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      dockerRoot: '/srv/docker',
      isGpuServer: false,
    };
    expect(() => parseAgentConfig({
      ...base,
      localDataSources: [{ id: 'local-a', mountPoint: '/srv/docker/data' }],
    })).toThrow('must not overlap dockerRoot');
    expect(() => parseAgentConfig({
      ...base,
      localDataSources: [{ id: 'local-a', mountPoint: '/mnt/remote-fs/nested' }],
    })).toThrow('must not overlap /mnt/remote-fs');
    expect(() => parseAgentConfig({
      ...base,
      localDataSources: [
        { id: 'local-a', mountPoint: '/data' },
        { id: 'local-b', mountPoint: '/data/nested' },
      ],
    })).toThrow('overlaps entry');
  });

  it('rejects dangerous Docker roots and non-canonical paths', () => {
    const base = {
      backendUrl: 'ws://localhost:3001/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      isGpuServer: false,
      localDataSources: [],
    };
    expect(() => parseAgentConfig({ ...base, dockerRoot: '/etc/nyabase-docker' }))
      .toThrow('dedicated data filesystem');
    expect(() => parseAgentConfig({ ...base, dockerRoot: '/var/lib/nyabase-docker/../other' }))
      .toThrow('normalized path');
    for (const dockerRoot of [
      '/var/lib/docker root',
      '/var/lib/docker%h',
      '/var/lib/docker\nroot',
      '/var/lib/docker\\root',
      '/var/lib/docker"root',
    ]) {
      expect(() => parseAgentConfig({ ...base, dockerRoot })).toThrow(
        'systemd-safe path characters',
      );
    }
  });

  it('accepts only a bounded canonical macvlan with unique usable addresses', () => {
    const base = {
      backendUrl: 'ws://localhost:3001/ws/agent',
      agentToken: '0123456789abcdef',
      serverId: 'server-a',
      dockerRoot: '/var/lib/nyabase-docker',
      isGpuServer: false,
      localDataSources: [],
    };
    expect(() => parseAgentConfig({ ...base, macvlanCidr: '0.0.0.0/0' }))
      .toThrow('between /16 and /30');
    expect(() => parseAgentConfig({ ...base, macvlanCidr: '10.0.0.3/24' }))
      .toThrow('canonical network address');
    expect(() => parseAgentConfig({
      ...base,
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.1.1',
    })).toThrow('usable host address');
    expect(() => parseAgentConfig({
      ...base,
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      reservedIps: ['10.0.0.1'],
    })).toThrow('duplicates');
    expect(parseAgentConfig({
      ...base,
      macvlanCidr: '10.0.0.0/30',
      macvlanGateway: '10.0.0.1',
      reservedIps: [],
    }).macvlanCidr).toBe('10.0.0.0/30');
  });
});
