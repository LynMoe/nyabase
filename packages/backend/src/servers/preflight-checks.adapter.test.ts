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
    const adapter = new IncusPreflightChecksAdapter(database() as never);

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
    } as never);

    await expect(adapter.checkNetworkPrerequisites('server-a', { samples: [] })).resolves.toMatchObject({
      networkPrerequisites: false,
      isBridge: false,
      nftAvailable: false,
    });
  });

  it('fails the conjunction when nft is unavailable or a slave still has IPv4', async () => {
    const adapter = new IncusPreflightChecksAdapter(database() as never);
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
});
