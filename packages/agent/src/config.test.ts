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
