import { describe, expect, it } from 'vitest';
import { cardKey, gpuCardUsers, hostGpuCards } from './performance-host-gpus.js';
import type { InventoryContainer, ObservedSample } from './performance-model.js';

const NOW = 1_000_000;
const SCRAPED = new Map([['srv-1', NOW]]);
const SERVER = 'srv-1';
const PCI_A = '0000:01:00.0';
const PCI_B = '0000:02:00.0';

function container(id: string, ownerId: string, displayName: string): InventoryContainer {
  return {
    id,
    serverId: SERVER,
    serverName: 'a800-2',
    ownerId,
    displayName,
    username: ownerId,
    name: `${ownerId}-${id}`,
    lifecyclePhase: 'active',
    powerIntent: 'running',
    cpuSet: null,
    createdAt: 0,
    pciAddresses: [],
    volumes: [],
  };
}

function sample(family: string, containerId: string, pci: string, value: number, ts = NOW): ObservedSample {
  return { family, labels: { server_id: SERVER, gpu_pci: pci, container_id: containerId }, value, ts };
}

const containers = [
  container('c1', 'alice', '张伟'),
  container('c2', 'alice', '张伟'),
  container('c3', 'bob', '李娜'),
];

describe('gpuCardUsers', () => {
  it('sums each owner over their containers on a card, most memory first, others last', () => {
    const users = gpuCardUsers([
      sample('gpu_process_bytes', 'c1', PCI_A, 10),
      sample('gpu_process_bytes', 'c2', PCI_A, 20),
      sample('gpu_process_sm', 'c1', PCI_A, 0.5),
      sample('gpu_process_sm', 'c2', PCI_A, 0.7),
      sample('gpu_process_bytes', 'c3', PCI_A, 40),
      sample('gpu_process_sm', 'c3', PCI_A, 0.1),
      sample('gpu_process_bytes', '__unattributed__', PCI_A, 99),
      sample('gpu_process_bytes', 'c3', PCI_B, 7),
    ], containers, SCRAPED);
    expect(users.get(cardKey(SERVER, PCI_A))).toEqual([
      { userId: 'bob', displayName: '李娜', memoryBytes: 40, smRatio: 0.1 },
      { userId: 'alice', displayName: '张伟', memoryBytes: 30, smRatio: 1 },
      { userId: null, displayName: null, memoryBytes: 99, smRatio: null },
    ]);
    expect(users.get(cardKey(SERVER, PCI_B))).toEqual([
      { userId: 'bob', displayName: '李娜', memoryBytes: 7, smRatio: null },
    ]);
  });

  it('counts a container the inventory no longer has as others', () => {
    const users = gpuCardUsers([sample('gpu_process_bytes', 'gone', PCI_A, 5)], containers, SCRAPED);
    expect(users.get(cardKey(SERVER, PCI_A))).toEqual([
      { userId: null, displayName: null, memoryBytes: 5, smRatio: null },
    ]);
  });

  it('keeps the processes of the last two scrapes and drops older ones, however old the newest scrape is', () => {
    const scraped = new Map([[SERVER, NOW - 40_000]]);
    const users = gpuCardUsers([
      sample('gpu_process_bytes', 'c1', PCI_A, 10, NOW - 40_000),
      sample('gpu_process_bytes', 'c3', PCI_A, 20, NOW - 55_000),
      sample('gpu_process_bytes', 'c3', PCI_B, 30, NOW - 61_000),
    ], containers, scraped);
    expect(users.get(cardKey(SERVER, PCI_A))?.map((user) => user.userId)).toEqual(['bob', 'alice']);
    expect(users.has(cardKey(SERVER, PCI_B))).toBe(false);
  });

  it('measures against the newest process sample while the latest scrape failed', () => {
    const users = gpuCardUsers([
      sample('gpu_process_bytes', 'c1', PCI_A, 10, NOW - 300_000),
      sample('gpu_process_bytes', 'c3', PCI_B, 30, NOW - 400_000),
    ], containers, new Map());
    expect(users.has(cardKey(SERVER, PCI_A))).toBe(true);
    expect(users.has(cardKey(SERVER, PCI_B))).toBe(false);
  });

  it('reads one series per container and card, the newest one', () => {
    const users = gpuCardUsers([
      sample('gpu_process_bytes', 'c3', PCI_A, 3, NOW - 15_000),
      sample('gpu_process_bytes', 'c3', PCI_A, 8, NOW),
    ], containers, SCRAPED);
    expect(users.get(cardKey(SERVER, PCI_A))?.[0]?.memoryBytes).toBe(8);
  });
});

describe('hostGpuCards', () => {
  it('lists the cards in nvidia-smi order with utilization and their users', () => {
    const row = (pci: string, value: number) => ({ labels: { server_id: SERVER, gpu_pci: pci }, value });
    const users = new Map([[cardKey(SERVER, PCI_B), [{ userId: 'bob', displayName: '李娜', memoryBytes: 7, smRatio: 0.2 }]]]);
    const cards = hostGpuCards(SERVER, {
      used: [row(PCI_A, 1), row(PCI_B, 8)],
      total: [row(PCI_A, 80), row(PCI_B, 80)],
      index: [row(PCI_A, 1), row(PCI_B, 0)],
      util: [row(PCI_B, 0.25)],
    }, users);
    expect(cards.map((card) => card.pci)).toEqual([PCI_B, PCI_A]);
    expect(cards[0]).toMatchObject({ index: 0, usedBytes: 8, totalBytes: 80, ratio: 0.1, utilRatio: 0.25, users: users.get(cardKey(SERVER, PCI_B)) });
    expect(cards[1]).toMatchObject({ index: 1, utilRatio: null, users: [] });
  });
});
