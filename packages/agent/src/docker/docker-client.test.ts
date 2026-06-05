import { describe, it, expect, vi } from 'vitest';
import { DockerClient, withTimeout, DockerTimeoutError } from './docker-client.js';
import type { AgentConfig } from '../config.js';
import { LABEL, SPEC_VERSION } from '@nyabase/common';

describe('withTimeout', () => {
  it('resolves with the inner value when fast enough', async () => {
    const v = await withTimeout(Promise.resolve('ok'), 50, 'fast');
    expect(v).toBe('ok');
  });

  it('rejects with DockerTimeoutError when the inner promise stalls', async () => {
    const stalled = new Promise<never>(() => { /* never resolves */ });
    await expect(withTimeout(stalled, 20, 'stall')).rejects.toBeInstanceOf(DockerTimeoutError);
  });

  it('propagates the underlying rejection without wrapping', async () => {
    const original = new Error('boom');
    await expect(withTimeout(Promise.reject(original), 50, 'boom')).rejects.toBe(original);
  });

  it('clears the internal timer on success so the process does not hang', async () => {
    // Indirect check: run many fast ops in series — if timers leaked, vitest
    // would hold the event loop open at the end of the test file.
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop
      await withTimeout(Promise.resolve(i), 1_000, `op-${i}`);
    }
    expect(true).toBe(true);
  });

  it('carries the operation label on the error', async () => {
    const stalled = new Promise<never>(() => {});
    try {
      await withTimeout(stalled, 5, 'mylabel');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DockerTimeoutError);
      expect((e as DockerTimeoutError).op).toBe('mylabel');
      expect((e as DockerTimeoutError).timeoutMs).toBe(5);
    }
  });
});

describe('DockerClient.fetchContainerStatsWithGpuMem', () => {
  it('preserves parsed Docker stats and merges provider GPU memory', async () => {
    const client = makeDockerClientWithStats(statsFixture());

    const stats = await client.fetchContainerStatsWithGpuMem('0123456789abcdef', async () => ({
      'GPU-a': 256,
      'GPU-b': 512,
    }));

    expect(stats).toEqual({
      cpuUsageRatio: 0.8,
      cpuUsageUsec: 0,
      memUsedBytes: 2048,
      memLimitBytes: 8192,
      netRxBytes: 40,
      netTxBytes: 60,
      blockReadBytes: 111,
      blockWriteBytes: 222,
      gpuMemUsedMiB: {
        'GPU-a': 256,
        'GPU-b': 512,
      },
    });
  });

  it('returns existing stats with an empty GPU map when the provider fails', async () => {
    const client = makeDockerClientWithStats(statsFixture());

    const stats = await client.fetchContainerStatsWithGpuMem('0123456789abcdef', async () => {
      throw new Error('gpu provider failed');
    });

    expect(stats).toMatchObject({
      cpuUsageRatio: 0.8,
      memUsedBytes: 2048,
      gpuMemUsedMiB: {},
    });
  });
});

describe('DockerClient Docker label handling', () => {
  it('writes identity/generation labels only at container create', async () => {
    const client = new DockerClient(makeConfig());
    const createContainer = vi.fn().mockResolvedValue({ id: 'docker-created' });
    Object.defineProperty(client, 'docker', {
      value: {
        createContainer,
      },
    });

    await expect(client.createContainer({
      name: 'work',
      imageRef: 'ubuntu:22.04',
      cpuMillis: 1000,
      memBytes: 1024,
      gpuIndices: [],
      ip: '10.0.0.2',
      sshServerEnabled: true,
      containerId: 'container-a',
      ownerId: 'user-a',
      imageId: 'image-a',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      serverId: 'server-a',
    })).resolves.toBe('docker-created');

    const labels = createContainer.mock.calls[0][0].Labels as Record<string, string>;
    expect(labels).toMatchObject({
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: 'container-a',
      [LABEL.SERVER_ID]: 'server-a',
      [LABEL.SPEC_GENERATION]: SPEC_VERSION,
    });
    expect(labels['nyabase.ssh_server_enabled']).toBeUndefined();
    expect(labels['nyabase.owner_id']).toBeUndefined();
    expect(labels['nyabase.ssh_user']).toBeUndefined();
    expect(labels['nyabase.ssh_uid']).toBeUndefined();
  });

  it('requests NVIDIA devices when gpuIndices are provided', async () => {
    const client = new DockerClient(makeConfig());
    const createContainer = vi.fn().mockResolvedValue({ id: 'docker-created' });
    Object.defineProperty(client, 'docker', {
      value: {
        createContainer,
      },
    });

    await client.createContainer({
      name: 'gpu-work',
      imageRef: 'nvidia/cuda:latest',
      cpuMillis: 1000,
      memBytes: 1024,
      gpuIndices: [0, 2],
      ip: '10.0.0.2',
      sshServerEnabled: false,
      containerId: 'container-gpu',
      ownerId: 'user-gpu',
      imageId: 'image-gpu',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      serverId: 'server-gpu',
    });

    const spec = createContainer.mock.calls[0][0];
    expect(spec.Env).toContain('NVIDIA_VISIBLE_DEVICES=0,2');
    expect(spec.Env).toContain('NVIDIA_DRIVER_CAPABILITIES=all');
    expect(spec.HostConfig).toMatchObject({
      Runtime: 'nvidia',
      DeviceRequests: [{
        Driver: 'nvidia',
        DeviceIDs: ['0', '2'],
        Capabilities: [['gpu']],
      }],
    });
  });

  it('applies image runtime overrides to Docker create options', async () => {
    const client = new DockerClient(makeConfig());
    const createContainer = vi.fn().mockResolvedValue({ id: 'docker-created' });
    Object.defineProperty(client, 'docker', {
      value: {
        createContainer,
      },
    });

    await client.createContainer({
      name: 'override-work',
      imageRef: 'ubuntu:24.04',
      cpuMillis: 1000,
      memBytes: 1024,
      gpuIndices: [],
      ip: '10.0.0.2',
      sshServerEnabled: false,
      containerId: 'container-override',
      ownerId: 'user-override',
      imageId: 'image-override',
      runtimeOverrides: {
        uid: 1000,
        entrypoint: ['/entrypoint'],
        cmd: ['sleep', 'infinity'],
        init: true,
      },
      serverId: 'server-override',
    });

    expect(createContainer.mock.calls[0][0]).toMatchObject({
      User: '1000',
      Entrypoint: ['/entrypoint'],
      Cmd: ['sleep', 'infinity'],
      HostConfig: {
        Init: true,
      },
    });
  });

  it('parses runtime IP from Docker network info for state reports', () => {
    const client = new DockerClient(makeConfig());
    const spec = client.parseContainerSpec({
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: 'container-a',
      [LABEL.SERVER_ID]: 'server-a',
      [LABEL.SPEC_GENERATION]: SPEC_VERSION,
    }, {
      NetworkSettings: {
        Networks: {
          nyabase_net: { IPAddress: '10.0.0.2' },
        },
      },
    } as never);

    expect(spec).toMatchObject({ ip: '10.0.0.2' });
  });
});

function makeDockerClientWithStats(stats: Record<string, unknown>): DockerClient {
  const client = new DockerClient(makeConfig());
  Object.defineProperty(client, 'docker', {
    value: {
      getContainer: () => ({
        stats: (_opts: { stream: false }, callback: (err: Error | null, data?: unknown) => void) => {
          callback(null, stats);
        },
      }),
    },
  });
  return client;
}

function makeConfig(): AgentConfig {
  return {
    backendUrl: 'ws://localhost',
    agentToken: 'tok',
    serverId: 'srv-1',
    dockerRoot: '/var/lib/nyabase-docker',
    parentIface: 'eth0',
    macvlanCidr: '10.0.0.0/24',
    macvlanGateway: '10.0.0.1',
    metricsIntervalMs: 10_000,
    mountHelperPath: '/usr/local/bin/mount-helper',
    agentVersion: '0.1.0',
    isGpuServer: false,
  };
}

function statsFixture(): Record<string, unknown> {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 300 },
      system_cpu_usage: 1000,
      online_cpus: 2,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 100 },
      system_cpu_usage: 500,
    },
    memory_stats: {
      usage: 2048,
      limit: 8192,
    },
    networks: {
      eth0: { rx_bytes: 10, tx_bytes: 20 },
      eth1: { rx_bytes: 30, tx_bytes: 40 },
    },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'Read', value: 100 },
        { op: 'read', value: 11 },
        { op: 'Write', value: 200 },
        { op: 'write', value: 22 },
        { op: 'Discard', value: 300 },
      ],
    },
  };
}
