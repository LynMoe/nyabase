import { describe, expect, it } from 'vitest';
import {
  ContainerStatus,
  ServerStatus,
  type ContainerDto,
  type EffectiveServerAccessDto,
  type LiveServerAccessDto,
  type PerformanceServerUsage,
  type UserServerDto,
} from '@nyabase/common';
import { dashboardFreeGpus, dashboardServers } from './dashboard-servers.js';

const GIB = 1024 ** 3;

function server(id: string, name: string, status = ServerStatus.Online): UserServerDto {
  return { id, name, slug: name, status, lastSeenAt: null, preflightStatus: 'passed' as UserServerDto['preflightStatus'], gpuEnabled: true };
}

function live(serverId: string, gpuPciAddresses: string[]): LiveServerAccessDto {
  return {
    accessPhase: 'live',
    serverId,
    cpuCores: null,
    serverCpuCores: null,
    memBytes: null,
    diskBytes: 100 * GIB,
    rootDiskBytes: null,
    rootDiskCommittedBytes: 0,
    rootDiskAvailableBytes: 100 * GIB,
    gpuCount: null,
    gpuPciAddresses,
    dataDisks: [],
    expiresAt: null,
    allowedImageIds: [],
  };
}

function usage(serverId: string, cards: Array<[string, number, string | null]>): PerformanceServerUsage {
  return {
    serverId,
    serverName: serverId,
    stale: false,
    sampledAt: null,
    people: [],
    sparkline: null,
    host: {
      cpuRatio: 0.5,
      cpuCount: 8,
      memory: { usedBytes: null, limitBytes: null, ratio: null },
      network: { rxBytesPerSec: null, txBytesPerSec: null },
      disks: [],
      gpus: cards.map(([pci, index, userId]) => ({
        pci,
        index,
        usedBytes: userId ? 10 * GIB : 0,
        totalBytes: 80 * GIB,
        ratio: null,
        utilRatio: null,
        users: userId ? [{ userId, displayName: userId, memoryBytes: 10 * GIB, smRatio: 0.5 }] : [],
      })),
    },
  };
}

function container(id: string, serverId: string, name: string, status: ContainerStatus): ContainerDto {
  return { id, serverId, serverName: serverId, name, actual: { status } } as unknown as ContainerDto;
}

describe('dashboardServers', () => {
  const servers = [server('s1', 'a800-2'), server('s2', 'h100-1', ServerStatus.Unreachable), server('s3', 'l40-1')];
  const access: EffectiveServerAccessDto[] = [
    live('s2', ['0000:01:00.0']),
    live('s1', ['0000:01:00.0', '0000:02:00.0']),
    { accessPhase: 'grace', serverId: 's3', expiresAt: '2026-11-20T00:00:00Z', purgeAt: '2026-12-04T00:00:00Z' },
  ];
  const containers = [
    container('c1', 's1', 'b-stopped', ContainerStatus.Stopped),
    container('c2', 's1', 'z-running', ContainerStatus.Running),
    container('c3', 's9', 'elsewhere', ContainerStatus.Running),
  ];
  const cards = dashboardServers({
    servers,
    access,
    usage: [usage('s1', [['0000:02:00.0', 1, 'me'], ['0000:01:00.0', 0, null], ['0000:03:00.0', 2, null]]), usage('s2', [['0000:01:00.0', 0, null]])],
    containers,
    selfId: 'me',
  });

  it('orders granted online servers first, then offline, then containers without a grant, grace last', () => {
    expect(cards.map((card) => card.name)).toEqual(['a800-2', 'h100-1', 's9', 'l40-1']);
  });

  it('shows only the granted cards, and none as known while the server is offline', () => {
    expect(cards[0]?.gpus.map((card) => [card.index, card.state])).toEqual([[0, 'free'], [1, 'mine']]);
    expect(cards[1]?.gpus.map((card) => card.state)).toEqual(['unknown']);
    expect(dashboardFreeGpus(cards)).toBe(1);
  });

  it('lists running containers first', () => {
    expect(cards[0]?.containers.map((item) => item.name)).toEqual(['z-running', 'b-stopped']);
    expect(cards[3]?.grace?.purgeAt).toBe('2026-12-04T00:00:00Z');
  });
});
