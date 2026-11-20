import { RootPlacement, RootPlacementExclusion } from '@nyabase/common';

/** A system pool of the target server, as root placement sees it. */
export interface RootPlacementPool {
  id: string;
  resizeFamily: string;
  quotaEffective: boolean | null;
  totalBytes: number | null;
  usedBytes: number | null;
  weight: number;
  maxUsedPercent: number | null;
  /** What the pool's overcommit rule still admits for this owner; null = unknown capacity, no limit. */
  availableBytes: number | null;
}

export interface RootPlacementInput {
  placement: RootPlacement;
  sticky: boolean;
  /** The server's system pools. */
  pools: readonly RootPlacementPool[];
  /** The owner's live committed root bytes on this server, per pool (any pool, system or not). */
  ownerRootBytesByPool: ReadonlyMap<string, number>;
  requestedBytes: number;
  /** A uniform integer in [0, bound). */
  randomInt: (bound: number) => number;
}

export interface RootPlacementExcludedPool {
  poolId: string;
  reason: RootPlacementExclusion;
  availableBytes: number | null;
}

export type RootPlacementDecision =
  | { kind: 'chosen'; poolId: string }
  | { kind: 'no_system_pool' }
  | { kind: 'none_usable'; excluded: RootPlacementExcludedPool[] };

/** True when the pool's observed usage has reached its high-water mark. */
export function aboveWatermark(pool: Pick<RootPlacementPool, 'maxUsedPercent' | 'totalBytes' | 'usedBytes'>): boolean {
  if (pool.maxUsedPercent === null || pool.totalBytes === null || pool.usedBytes === null) return false;
  if (pool.totalBytes <= 0) return true;
  return pool.usedBytes * 100 >= pool.maxUsedPercent * pool.totalBytes;
}

function exclusion(pool: RootPlacementPool, requestedBytes: number): RootPlacementExclusion | null {
  if (pool.resizeFamily === 'quota_online' && pool.quotaEffective !== true) {
    return RootPlacementExclusion.QuotaIneffective;
  }
  if (aboveWatermark(pool)) return RootPlacementExclusion.AboveWatermark;
  if (pool.availableBytes !== null && requestedBytes > pool.availableBytes) return RootPlacementExclusion.Capacity;
  return null;
}

/** The pool holding most of the owner's live root bytes on the server (ties by pool id). */
export function stickyPoolId(ownerRootBytesByPool: ReadonlyMap<string, number>): string | null {
  let best: { id: string; bytes: number } | null = null;
  for (const [id, bytes] of ownerRootBytesByPool) {
    if (best === null || bytes > best.bytes || (bytes === best.bytes && id < best.id)) best = { id, bytes };
  }
  return best?.id ?? null;
}

function weightedPick(pools: readonly RootPlacementPool[], randomInt: (bound: number) => number): RootPlacementPool {
  const total = pools.reduce((sum, pool) => sum + pool.weight, 0);
  let ticket = randomInt(total);
  for (const pool of pools) {
    if (ticket < pool.weight) return pool;
    ticket -= pool.weight;
  }
  return pools[pools.length - 1]!;
}

/**
 * Where a new container's root disk goes (AGENTS.md, 存储池用途与系统盘分配):
 * the system pools that can take it (effective quota, below the high-water
 * mark, room under the overcommit rule), then `single` = the one pool,
 * `random` = weighted random, sticky = the owner's pool on this server while
 * it can take the disk.
 */
export function chooseRootPool(input: RootPlacementInput): RootPlacementDecision {
  if (input.pools.length === 0) return { kind: 'no_system_pool' };
  const pools = [...input.pools].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const usable: RootPlacementPool[] = [];
  const excluded: RootPlacementExcludedPool[] = [];
  for (const pool of pools) {
    const reason = exclusion(pool, input.requestedBytes);
    if (reason === null) usable.push(pool);
    else excluded.push({ poolId: pool.id, reason, availableBytes: pool.availableBytes });
  }
  if (usable.length === 0) return { kind: 'none_usable', excluded };
  if (input.placement === RootPlacement.Random && input.sticky) {
    const home = stickyPoolId(input.ownerRootBytesByPool);
    const chosen = usable.find((pool) => pool.id === home);
    if (chosen) return { kind: 'chosen', poolId: chosen.id };
  }
  if (input.placement === RootPlacement.Single || usable.length === 1) {
    return { kind: 'chosen', poolId: usable[0]!.id };
  }
  return { kind: 'chosen', poolId: weightedPick(usable, input.randomInt).id };
}
