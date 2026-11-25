import type { PerformanceGpuUser, PerformanceHostGpu } from '@nyabase/common';
import { PERFORMANCE_FRESHNESS_MS, type InventoryContainer, type ObservedSample } from './performance-model.js';

interface NodeRow {
  labels: Record<string, string>;
  value: number;
}

/** The node series of one server's cards, keyed by `gpu_pci`. */
export interface NodeGpuSeries {
  used: readonly NodeRow[];
  total: readonly NodeRow[];
  index: readonly NodeRow[];
  util: readonly NodeRow[];
}

/** Users per card, keyed by {@link cardKey}. */
export type GpuUsersByCard = ReadonlyMap<string, PerformanceGpuUser[]>;

export function cardKey(serverId: string, pci: string): string {
  return `${serverId}\0${pci}`;
}

/**
 * One server's cards as nvidia-smi reports them, in `nvidia-smi` index order,
 * each with the owners of its compute processes (`users`; empty without them).
 */
export function hostGpuCards(serverId: string, series: NodeGpuSeries, users?: GpuUsersByCard): PerformanceHostGpu[] {
  const pcis = new Set<string>();
  for (const row of [...series.used, ...series.total, ...series.index]) {
    if (row.labels.server_id === serverId && row.labels.gpu_pci) pcis.add(row.labels.gpu_pci);
  }
  return [...pcis].map((pci) => {
    const usedBytes = cardValue(series.used, serverId, pci);
    const totalBytes = cardValue(series.total, serverId, pci);
    return {
      pci,
      index: cardValue(series.index, serverId, pci),
      usedBytes,
      totalBytes,
      ratio: usedBytes !== null && totalBytes !== null && totalBytes > 0 ? usedBytes / totalBytes : null,
      utilRatio: cardValue(series.util, serverId, pci),
      users: users?.get(cardKey(serverId, pci)) ?? [],
    };
  }).sort((left, right) => (left.index ?? 999) - (right.index ?? 999) || left.pci.localeCompare(right.pci));
}

/**
 * Who runs on each card: the fresh per-process memory and SM samples (one per
 * container and card) summed per container owner. A process outside the
 * platform's containers (`__unattributed__`, or a container the inventory no
 * longer has) counts toward one `userId: null` row. A sample older than
 * {@link PERFORMANCE_FRESHNESS_MS} is a process that has ended.
 */
export function gpuCardUsers(
  samples: readonly ObservedSample[],
  containers: readonly InventoryContainer[],
  now: number,
): Map<string, PerformanceGpuUser[]> {
  const owners = new Map(containers.map((container) => [container.id, container]));
  const latest = new Map<string, ObservedSample>();
  for (const sample of samples) {
    if (sample.family !== 'gpu_process_bytes' && sample.family !== 'gpu_process_sm') continue;
    const { server_id: serverId, gpu_pci: pci, container_id: containerId } = sample.labels;
    if (!serverId || !pci || !containerId || now - sample.ts > PERFORMANCE_FRESHNESS_MS) continue;
    const key = [sample.family, serverId, pci, containerId].join('\0');
    const current = latest.get(key);
    if (!current || sample.ts >= current.ts) latest.set(key, sample);
  }
  const cards = new Map<string, Map<string | null, PerformanceGpuUser>>();
  for (const sample of latest.values()) {
    const { server_id: serverId = '', gpu_pci: pci = '', container_id: containerId = '' } = sample.labels;
    const owner = owners.get(containerId);
    const userId = owner?.ownerId ?? null;
    const card = cards.get(cardKey(serverId, pci)) ?? new Map<string | null, PerformanceGpuUser>();
    const displayName = owner ? owner.displayName || owner.username : null;
    const user = card.get(userId) ?? { userId, displayName, memoryBytes: 0, smRatio: null };
    if (sample.family === 'gpu_process_bytes') user.memoryBytes += Math.max(0, sample.value);
    else user.smRatio = Math.min(1, (user.smRatio ?? 0) + Math.max(0, sample.value));
    card.set(userId, user);
    cards.set(cardKey(serverId, pci), card);
  }
  const result = new Map<string, PerformanceGpuUser[]>();
  for (const [key, card] of cards) {
    result.set(key, [...card.values()].sort((left, right) =>
      Number(left.userId === null) - Number(right.userId === null)
      || right.memoryBytes - left.memoryBytes
      || (left.displayName ?? '').localeCompare(right.displayName ?? '')));
  }
  return result;
}

function cardValue(rows: readonly NodeRow[], serverId: string, pci: string): number | null {
  return rows.find((row) => row.labels.server_id === serverId && row.labels.gpu_pci === pci)?.value ?? null;
}
