import { RootPlacement, RootPlacementExclusion } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { aboveWatermark, chooseRootPool, stickyPoolId, type RootPlacementPool } from './root-placement.js';

function pool(id: string, overrides: Partial<RootPlacementPool> = {}): RootPlacementPool {
  return {
    id,
    resizeFamily: 'quota_online',
    quotaEffective: true,
    totalBytes: 1_000,
    usedBytes: 100,
    weight: 1,
    maxUsedPercent: null,
    availableBytes: 1_000,
    ...overrides,
  };
}

function choose(
  pools: RootPlacementPool[],
  options: Partial<{
    placement: RootPlacement;
    sticky: boolean;
    owner: Array<[string, number]>;
    requestedBytes: number;
    ticket: number;
  }> = {},
) {
  const bounds: number[] = [];
  const decision = chooseRootPool({
    placement: options.placement ?? RootPlacement.Random,
    sticky: options.sticky ?? false,
    pools,
    ownerRootBytesByPool: new Map(options.owner ?? []),
    requestedBytes: options.requestedBytes ?? 10,
    randomInt: (bound) => {
      bounds.push(bound);
      return options.ticket ?? 0;
    },
  });
  return { decision, bounds };
}

describe('root placement', () => {
  it('reports a server without system pools', () => {
    expect(choose([]).decision).toEqual({ kind: 'no_system_pool' });
  });

  it('single placement takes the one system pool without drawing', () => {
    const { decision, bounds } = choose([pool('a')], { placement: RootPlacement.Single });
    expect(decision).toEqual({ kind: 'chosen', poolId: 'a' });
    expect(bounds).toEqual([]);
  });

  it('random placement draws by weight over the usable pools in id order', () => {
    const pools = [pool('c', { weight: 1 }), pool('a', { weight: 2 }), pool('b', { weight: 3 })];
    // a: tickets 0-1, b: 2-4, c: 5
    expect(choose(pools, { ticket: 0 })).toEqual({ decision: { kind: 'chosen', poolId: 'a' }, bounds: [6] });
    expect(choose(pools, { ticket: 1 }).decision).toEqual({ kind: 'chosen', poolId: 'a' });
    expect(choose(pools, { ticket: 2 }).decision).toEqual({ kind: 'chosen', poolId: 'b' });
    expect(choose(pools, { ticket: 4 }).decision).toEqual({ kind: 'chosen', poolId: 'b' });
    expect(choose(pools, { ticket: 5 }).decision).toEqual({ kind: 'chosen', poolId: 'c' });
  });

  it('leaves out pools without an effective quota, above the mark, or without room', () => {
    const pools = [
      pool('a', { quotaEffective: false }),
      pool('b', { maxUsedPercent: 90, usedBytes: 900 }),
      pool('c', { availableBytes: 5 }),
      pool('d'),
    ];
    const { decision, bounds } = choose(pools, { requestedBytes: 10, ticket: 0 });
    expect(decision).toEqual({ kind: 'chosen', poolId: 'd' });
    expect(bounds).toEqual([]);
    // A block-backed pool needs no quota probe; unknown capacity means no capacity limit.
    expect(choose([pool('e', { resizeFamily: 'block_backed', quotaEffective: null, availableBytes: null })], {
      requestedBytes: 10 ** 12,
    }).decision).toEqual({ kind: 'chosen', poolId: 'e' });
  });

  it('says why no system pool can take the disk', () => {
    const { decision } = choose([
      pool('b', { maxUsedPercent: 50, usedBytes: 500 }),
      pool('a', { quotaEffective: null }),
      pool('c', { availableBytes: 9 }),
    ], { requestedBytes: 10 });
    expect(decision).toEqual({
      kind: 'none_usable',
      excluded: [
        { poolId: 'a', reason: RootPlacementExclusion.QuotaIneffective, availableBytes: 1_000 },
        { poolId: 'b', reason: RootPlacementExclusion.AboveWatermark, availableBytes: 1_000 },
        { poolId: 'c', reason: RootPlacementExclusion.Capacity, availableBytes: 9 },
      ],
    });
  });

  it('sticky placement keeps the owner on the pool holding most of their root disks', () => {
    const pools = [pool('a'), pool('b'), pool('c')];
    const owner: Array<[string, number]> = [['c', 300], ['b', 200], ['a', 100]];
    const { decision, bounds } = choose(pools, { sticky: true, owner });
    expect(decision).toEqual({ kind: 'chosen', poolId: 'c' });
    expect(bounds).toEqual([]);
    // Without sticky the same owner is drawn at random.
    expect(choose(pools, { owner, ticket: 0 }).decision).toEqual({ kind: 'chosen', poolId: 'a' });
  });

  it('sticky placement falls back to random when the owner has no usable pool', () => {
    // No containers yet.
    expect(choose([pool('a'), pool('b')], { sticky: true, ticket: 1 }))
      .toEqual({ decision: { kind: 'chosen', poolId: 'b' }, bounds: [2] });
    // The owner's pool lost the role (not among the system pools) or is above its mark.
    expect(choose([pool('a'), pool('b')], { sticky: true, owner: [['z', 100]], ticket: 0 }).decision)
      .toEqual({ kind: 'chosen', poolId: 'a' });
    expect(choose([pool('a', { maxUsedPercent: 10 }), pool('b')], { sticky: true, owner: [['a', 100]] }).decision)
      .toEqual({ kind: 'chosen', poolId: 'b' });
  });

  it('sticky is ignored under single placement', () => {
    expect(choose([pool('a')], { placement: RootPlacement.Single, sticky: true, owner: [['z', 1]] }).decision)
      .toEqual({ kind: 'chosen', poolId: 'a' });
  });

  it('breaks sticky ties by pool id', () => {
    expect(stickyPoolId(new Map([['b', 5], ['a', 5]]))).toBe('a');
    expect(stickyPoolId(new Map())).toBeNull();
  });

  it('applies the high-water mark only when usage and capacity are known', () => {
    expect(aboveWatermark({ maxUsedPercent: 90, totalBytes: 1_000, usedBytes: 899 })).toBe(false);
    expect(aboveWatermark({ maxUsedPercent: 90, totalBytes: 1_000, usedBytes: 900 })).toBe(true);
    expect(aboveWatermark({ maxUsedPercent: 90, totalBytes: null, usedBytes: 900 })).toBe(false);
    expect(aboveWatermark({ maxUsedPercent: 90, totalBytes: 1_000, usedBytes: null })).toBe(false);
    expect(aboveWatermark({ maxUsedPercent: null, totalBytes: 1_000, usedBytes: 1_000 })).toBe(false);
    expect(aboveWatermark({ maxUsedPercent: 100, totalBytes: 0, usedBytes: 0 })).toBe(true);
  });
});
