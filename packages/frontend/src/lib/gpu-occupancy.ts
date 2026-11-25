import { canonicalPciAddress, type PerformanceHostGpu } from '@nyabase/common';

/**
 * Memory on a card with no listed process still means someone holds it (a
 * context nvidia-smi could not attribute); below this it is driver noise.
 */
export const GPU_HELD_MEMORY_BYTES = 1024 ** 3;

export type GpuCardState = 'free' | 'mine' | 'others' | 'unknown';

/** One owner of a card's processes, as the dashboard tooltip shows it. */
export interface GpuCardUserRow {
  key: string;
  /** 你 / the owner's display name / 其他 (processes outside the platform's containers). */
  name: string;
  mine: boolean;
  memoryBytes: number;
  /** Share of the card's memory, 0..1; null while the card size is unknown. */
  memoryRatio: number | null;
  smRatio: number | null;
}

export interface GrantedGpuCard {
  pci: string;
  /** nvidia-smi index; null while the card is not reporting. */
  index: number | null;
  state: GpuCardState;
  totalBytes: number | null;
  rows: GpuCardUserRow[];
}

function pciKey(pci: string): string {
  return canonicalPciAddress(pci) ?? pci.trim().toLowerCase();
}

/**
 * The cards granted to the user, read from the server's live snapshot, in
 * nvidia-smi order. Cards outside the grant are left out; a granted card the
 * snapshot lacks (server offline, collector down) is `unknown`.
 */
export function grantedGpuCards(
  grantedPcis: readonly string[],
  host: readonly PerformanceHostGpu[] | null,
  selfId: string | null,
): GrantedGpuCard[] {
  const byPci = new Map((host ?? []).map((card) => [pciKey(card.pci), card]));
  return grantedPcis.map((pci): GrantedGpuCard => {
    const card = byPci.get(pciKey(pci));
    if (!card) return { pci, index: null, state: 'unknown', totalBytes: null, rows: [] };
    return {
      pci,
      index: card.index,
      state: gpuCardState(card, selfId),
      totalBytes: card.totalBytes,
      rows: gpuCardRows(card, selfId),
    };
  }).sort((left, right) => (left.index ?? 999) - (right.index ?? 999) || left.pci.localeCompare(right.pci));
}

/** Mine when any of my containers runs on it; free only with no process and no held memory. */
export function gpuCardState(card: PerformanceHostGpu, selfId: string | null): GpuCardState {
  if (selfId !== null && card.users.some((user) => user.userId === selfId)) return 'mine';
  if (card.users.length > 0 || (card.usedBytes ?? 0) >= GPU_HELD_MEMORY_BYTES) return 'others';
  if (card.usedBytes === null) return 'unknown';
  return 'free';
}

/** One row per owner; held memory without a listed process is one 其他 row. */
export function gpuCardRows(card: PerformanceHostGpu, selfId: string | null): GpuCardUserRow[] {
  const share = (bytes: number) =>
    card.totalBytes !== null && card.totalBytes > 0 ? Math.min(1, bytes / card.totalBytes) : null;
  const rows = card.users.map((user): GpuCardUserRow => {
    const mine = selfId !== null && user.userId === selfId;
    return {
      key: user.userId ?? 'others',
      name: mine ? '你' : user.userId === null ? '其他' : user.displayName ?? '其他',
      mine,
      memoryBytes: user.memoryBytes,
      memoryRatio: share(user.memoryBytes),
      smRatio: user.smRatio,
    };
  });
  const held = card.usedBytes ?? 0;
  if (rows.length === 0 && held >= GPU_HELD_MEMORY_BYTES) {
    rows.push({ key: 'others', name: '其他', mine: false, memoryBytes: held, memoryRatio: share(held), smRatio: card.utilRatio });
  }
  return rows;
}

export function freeGpuCount(cards: readonly GrantedGpuCard[]): number {
  return cards.filter((card) => card.state === 'free').length;
}
