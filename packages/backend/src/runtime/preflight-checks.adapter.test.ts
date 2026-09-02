import { describe, expect, it, vi } from 'vitest';
import { IncusPreflightChecksAdapter } from './preflight-checks.adapter.js';

function database() {
  const updates: Array<Record<string, unknown>> = [];
  return {
    selectFrom: vi.fn(() => ({
      select: vi.fn(() => ({
        where: vi.fn(() => ({
          executeTakeFirst: vi.fn().mockResolvedValue({
            parent_interface: 'vmbr0',
          }),
        })),
      })),
    })),
    updateTable: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        return {
        where: vi.fn(() => ({
          execute: vi.fn().mockResolvedValue(undefined),
        })),
        };
      }),
    })),
    updates,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'incus.preflightEgressUrl': 'https://egress.example.test/health',
    'incus.operationWaitTimeoutMs': 120_000,
    ...overrides,
  };
  return {
    get: vi.fn((key: string) => values[key]),
  };
}

function lanSamples() {
  return [
    {
      name: 'nyabase_node_network_is_bridge',
      labels: { interface: 'vmbr0' },
      value: 1,
    },
    {
      name: 'nyabase_node_network_ipv4_present',
      labels: { interface: 'vmbr0' },
      value: 1,
    },
    {
      name: 'nyabase_node_network_ipv4_present',
      labels: { interface: 'bond0' },
      value: 0,
    },
    {
      name: 'nyabase_node_network_bridge_slave',
      labels: { bridge: 'vmbr0', interface: 'bond0' },
      value: 1,
    },
    {
      name: 'nyabase_node_network_nft_available',
      labels: {},
      value: 1,
    },
  ];
}

describe('IncusPreflightChecksAdapter', () => {
  it('passes the bridge/nft/ipv4_present conjunction when parent is an unmanaged LAN bridge', async () => {
    const adapter = new IncusPreflightChecksAdapter(database() as never, config() as never);

    await expect(adapter.checkNetworkPrerequisites('server-a', {
      samples: lanSamples(),
    })).resolves.toEqual({
      serverId: 'server-a',
      parentInterface: 'vmbr0',
      isBridge: true,
      nftAvailable: true,
      slaves: ['bond0'],
      ipv4Present: { vmbr0: true, bond0: false },
      slavesWithIpv4: [],
      slavesWithUnknownIpv4: [],
      hasUplink: true,
      networkPrerequisites: true,
    });
  });

  it('fails network prerequisites when parent_interface is missing', async () => {
    const adapter = new IncusPreflightChecksAdapter({
      ...database(),
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({
            executeTakeFirst: vi.fn().mockResolvedValue({
              parent_interface: null,
            }),
          })),
        })),
      })),
    } as never, config() as never);

    await expect(adapter.checkNetworkPrerequisites('server-a', { samples: [] })).resolves.toMatchObject({
      networkPrerequisites: false,
      isBridge: false,
      nftAvailable: false,
    });
  });

  it('fails the conjunction when nft is unavailable or a slave still has IPv4', async () => {
    const adapter = new IncusPreflightChecksAdapter(database() as never, config() as never);
    await expect(adapter.checkNetworkPrerequisites('server-a', {
      samples: lanSamples().map((sample) => (
        sample.name === 'nyabase_node_network_nft_available'
          ? { ...sample, value: 0 }
          : sample
      )),
    })).resolves.toMatchObject({
      nftAvailable: false,
      networkPrerequisites: false,
    });
    await expect(adapter.checkNetworkPrerequisites('server-a', {
      samples: lanSamples().map((sample) => (
        sample.name === 'nyabase_node_network_ipv4_present'
          && sample.labels.interface === 'bond0'
          ? { ...sample, value: 1 }
          : sample
      )),
    })).resolves.toMatchObject({
      slavesWithIpv4: ['bond0'],
      slavesWithUnknownIpv4: [],
      networkPrerequisites: false,
    });
    await expect(adapter.checkNetworkPrerequisites('server-a', {
      samples: lanSamples().filter((sample) => (
        sample.name !== 'nyabase_node_network_ipv4_present'
        || sample.labels.interface !== 'bond0'
      )),
    })).resolves.toMatchObject({
      slavesWithIpv4: [],
      slavesWithUnknownIpv4: ['bond0'],
      networkPrerequisites: false,
    });
  });

  it('runs egress through the fixed HTTPS target and records the operation proof', async () => {
    const execInstance = vi.fn().mockResolvedValue({
      status: 202,
      envelope: {
        type: 'async',
        operation: '/1.0/operations/probe-op',
      },
    });
    const getOperationWait = vi.fn().mockResolvedValue({
      status: 200,
      envelope: { type: 'sync' },
      metadata: {
        status: 'Success',
        status_code: 200,
        metadata: { return: 0 },
      },
    });
    const adapter = new IncusPreflightChecksAdapter(database() as never, config() as never);
    const client = { execInstance, getOperationWait } as never;

    await expect(adapter.checkEgress('server-a', client, 'probe-a')).resolves.toMatchObject({
      status: 'pass',
      target: 'https://egress.example.test/health',
    });
    expect(execInstance).toHaveBeenCalledWith(
      'probe-a',
      expect.objectContaining({
        command: [
          'wget',
          '-q',
          '-T',
          '10',
          '-O',
          '/dev/null',
          'https://egress.example.test/health',
        ],
        'record-output': true,
      }),
      expect.anything(),
    );
    expect(getOperationWait).toHaveBeenCalledWith(
      'probe-op',
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('fails closed when the configured egress target is missing', async () => {
    const adapter = new IncusPreflightChecksAdapter(
      database() as never,
      config({ 'incus.preflightEgressUrl': '' }) as never,
    );

    await expect(adapter.checkEgress(
      'server-a',
      {} as never,
      'probe-a',
    )).rejects.toMatchObject({
      code: 'PREFLIGHT_FAILED',
      details: { reason: 'preflight_egress_target_unconfigured' },
    });
  });

  it('pings the host IPv4 from the probe and maps missing ping to a typed failure', async () => {
    const execInstance = vi.fn().mockResolvedValue({
      status: 202,
      envelope: {
        type: 'async',
        operation: '/1.0/operations/ping-op',
      },
    });
    const getOperationWait = vi.fn().mockResolvedValue({
      status: 200,
      envelope: { type: 'sync' },
      metadata: {
        status: 'Success',
        status_code: 200,
        metadata: { return: 0 },
      },
    });
    const adapter = new IncusPreflightChecksAdapter(database() as never, config() as never);
    const client = { execInstance, getOperationWait } as never;

    await expect(adapter.checkGuestCanReachHost(
      'server-a',
      client,
      'probe-a',
      '192.0.2.1',
    )).resolves.toMatchObject({
      status: 'pass',
      hostAddress: '192.0.2.1',
    });
    expect(execInstance).toHaveBeenCalledWith(
      'probe-a',
      expect.objectContaining({
        command: ['ping', '-c', '1', '-W', '3', '192.0.2.1'],
      }),
      expect.anything(),
    );

    getOperationWait.mockResolvedValue({
      status: 200,
      envelope: { type: 'sync' },
      metadata: {
        status: 'Success',
        status_code: 200,
        metadata: { return: 127 },
      },
    });
    await expect(adapter.checkGuestCanReachHost(
      'server-a',
      client,
      'probe-a',
      '192.0.2.1',
    )).rejects.toMatchObject({
      details: { reason: 'preflight_probe_ping_missing' },
    });
  });
});
