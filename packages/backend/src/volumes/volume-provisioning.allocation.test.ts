import { describe, expect, it } from 'vitest';
import { allocateQuotas, quotaFloor, type AllocationVolume } from './volume-provisioning.js';

const MIN_VOLUME_BYTES = 1024 ** 3;

const GiB = 1024 ** 3;

function volume(id: string, values: Partial<AllocationVolume> & { usedBytes: number | null; sizeBytes: number }): AllocationVolume {
  return {
    id,
    committedBytes: values.sizeBytes,
    belowUsage: true,
    capBytes: null,
    ceilingBytes: null,
    ...values,
  };
}

function sizes(result: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...result.entries()].map(([id, size]) => [id, size / GiB]));
}

describe('allocateQuotas: a group of one', () => {
  it('sets the quota to the limit, also below the data where the filesystem allows it', () => {
    expect(sizes(allocateQuotas(100 * GiB, [volume('a', { usedBytes: 10 * GiB, sizeBytes: 50 * GiB })])))
      .toEqual({ a: 100 });
    expect(sizes(allocateQuotas(20 * GiB, [volume('a', { usedBytes: 60 * GiB, sizeBytes: 100 * GiB })])))
      .toEqual({ a: 20 });
    // No usage needed for a capable filesystem.
    expect(sizes(allocateQuotas(20 * GiB, [volume('a', { usedBytes: null, sizeBytes: 100 * GiB })])))
      .toEqual({ a: 20 });
    expect(allocateQuotas(100 * GiB, [volume('a', { usedBytes: 1, sizeBytes: 100 * GiB })]).size).toBe(0);
  });

  it('ratchets a filesystem that refuses a quota below its data', () => {
    const zfs = (usedBytes: number | null, sizeBytes: number) =>
      [volume('a', { usedBytes, sizeBytes, belowUsage: false })];
    // Over the limit: down to the data, never up.
    expect(sizes(allocateQuotas(20 * GiB, zfs(60 * GiB, 100 * GiB)))).toEqual({ a: 60 });
    expect(allocateQuotas(20 * GiB, zfs(60 * GiB, 60 * GiB)).size).toBe(0);
    expect(allocateQuotas(20 * GiB, zfs(70 * GiB, 60 * GiB)).size).toBe(0);
    // The user deletes: the quota follows (in steps of at least 1 GiB), then stops at the limit.
    expect(sizes(allocateQuotas(20 * GiB, zfs(40 * GiB, 60 * GiB)))).toEqual({ a: 40 });
    expect(allocateQuotas(20 * GiB, zfs(40 * GiB - 1, 40 * GiB)).size).toBe(0);
    expect(sizes(allocateQuotas(20 * GiB, zfs(20 * GiB + 1, 20.5 * GiB)))).toEqual({});
    expect(sizes(allocateQuotas(20 * GiB, zfs(19 * GiB, 20.5 * GiB)))).toEqual({ a: 20 });
    expect(sizes(allocateQuotas(20 * GiB, zfs(5 * GiB, 40 * GiB)))).toEqual({ a: 20 });
    // Unknown usage: no shrink this pass, but a grow needs none.
    expect(allocateQuotas(20 * GiB, zfs(null, 60 * GiB)).size).toBe(0);
    expect(sizes(allocateQuotas(80 * GiB, zfs(null, 60 * GiB)))).toEqual({ a: 80 });
  });

  it('grows only as far as the disk can give', () => {
    expect(sizes(allocateQuotas(100 * GiB, [volume('a', { usedBytes: 0, sizeBytes: 10 * GiB, capBytes: 30 * GiB })])))
      .toEqual({ a: 30 });
  });

  it('never sets a zero quota, and keeps a small grant small', () => {
    const MiB = 1024 ** 2;
    expect(allocateQuotas(1, [volume('a', { usedBytes: 0, sizeBytes: 5 * GiB })]).get('a')).toBe(MiB);
    expect(allocateQuotas(200 * MiB, [volume('a', { usedBytes: 300 * MiB, sizeBytes: 2 * GiB })]).get('a'))
      .toBe(200 * MiB);
    expect(quotaFloor(100 * GiB, 3)).toBe(GiB);
    expect(quotaFloor(300 * MiB, 3)).toBe(100 * MiB);
  });
});

describe('allocateQuotas: several disks sharing a limit', () => {
  it('gives every disk the data it holds plus an equal share of what is left', () => {
    const result = allocateQuotas(1000 * GiB, [
      volume('a', { usedBytes: 600 * GiB, sizeBytes: 600 * GiB }),
      volume('b', { usedBytes: 0, sizeBytes: 200 * GiB }),
      volume('c', { usedBytes: 0, sizeBytes: 200 * GiB }),
    ]);
    // Shrinks first; the grow waits until they free the room (the committed sizes fill the limit).
    expect(Object.keys(sizes(result))).toEqual(['b', 'c']);
    expect(result.get('b')).toBe(Math.floor(400 / 3 * GiB));
    expect(result.get('c')).toBe(Math.floor(400 / 3 * GiB));
    const next = allocateQuotas(1000 * GiB, [
      volume('a', { usedBytes: 600 * GiB, sizeBytes: 600 * GiB }),
      volume('b', { usedBytes: 0, sizeBytes: 400 / 3 * GiB }),
      volume('c', { usedBytes: 0, sizeBytes: 400 / 3 * GiB }),
    ]);
    expect(Math.round(next.get('a')! / GiB)).toBe(733);
  });

  it('never lets the committed sizes exceed the limit while a shrink is pending', () => {
    const result = allocateQuotas(1000 * GiB, [
      volume('a', { usedBytes: 600 * GiB, sizeBytes: 600 * GiB }),
      // b was just shrunk from 400: Incus may still hold 400 until verified.
      volume('b', { usedBytes: 0, sizeBytes: 200 * GiB, committedBytes: 400 * GiB }),
    ]);
    expect(result.size).toBe(0);
  });

  it('leaves small moves alone', () => {
    const result = allocateQuotas(1000 * GiB, [
      volume('a', { usedBytes: 101 * GiB, sizeBytes: 550 * GiB }),
      volume('b', { usedBytes: 0, sizeBytes: 450 * GiB }),
    ]);
    expect(sizes(result)).toEqual({});
  });

  it('passes a full disk\'s share on to the others', () => {
    const result = allocateQuotas(300 * GiB, [
      volume('a', { usedBytes: 0, sizeBytes: 10 * GiB, capBytes: 20 * GiB }),
      volume('b', { usedBytes: 0, sizeBytes: 10 * GiB }),
      volume('c', { usedBytes: 0, sizeBytes: 10 * GiB }),
    ]);
    expect(sizes(result)).toEqual({ a: 20, b: 140, c: 140 });
  });

  it('over the limit, shrinks every disk by the same ratio (capable) or to its data (ratchet)', () => {
    expect(sizes(allocateQuotas(600 * GiB, [
      volume('a', { usedBytes: 500 * GiB, sizeBytes: 700 * GiB }),
      volume('b', { usedBytes: 200 * GiB, sizeBytes: 300 * GiB }),
    ]))).toEqual({ a: Math.floor(600 * GiB * 5 / 7) / GiB, b: Math.floor(600 * GiB * 2 / 7) / GiB });
    expect(sizes(allocateQuotas(600 * GiB, [
      volume('a', { usedBytes: 500 * GiB, sizeBytes: 700 * GiB, belowUsage: false }),
      volume('b', { usedBytes: 200 * GiB, sizeBytes: 300 * GiB, belowUsage: false }),
      volume('c', { usedBytes: 0, sizeBytes: 10 * GiB, belowUsage: false }),
    ]))).toEqual({ a: 500, b: 200, c: 1 });
  });

  it('skips the pass while a volume\'s usage is unknown', () => {
    expect(allocateQuotas(1000 * GiB, [
      volume('a', { usedBytes: null, sizeBytes: 500 * GiB }),
      volume('b', { usedBytes: 0, sizeBytes: 10 * GiB }),
    ]).size).toBe(0);
  });

  it('sizes a new disk out of the others\' headroom over two passes', () => {
    // b was created at the floor next to a, which held the whole limit.
    const first = allocateQuotas(100 * GiB, [
      volume('a', { usedBytes: 10 * GiB, sizeBytes: 100 * GiB }),
      volume('b', { usedBytes: 0, sizeBytes: MIN_VOLUME_BYTES }),
    ]);
    expect(sizes(first)).toEqual({ a: 55 });
    const second = allocateQuotas(100 * GiB, [
      volume('a', { usedBytes: 10 * GiB, sizeBytes: 55 * GiB }),
      volume('b', { usedBytes: 0, sizeBytes: MIN_VOLUME_BYTES }),
    ]);
    expect(sizes(second)).toEqual({ b: 45 });
  });
});

describe('allocateQuotas: per-disk ceilings', () => {
  it('caps a group of one at its ceiling below the limit, exactly', () => {
    expect(sizes(allocateQuotas(100 * GiB, [volume('a', { usedBytes: null, sizeBytes: 50 * GiB, ceilingBytes: 30 * GiB })])))
      .toEqual({ a: 30 });
    expect(allocateQuotas(100 * GiB, [volume('a', { usedBytes: null, sizeBytes: 30 * GiB, ceilingBytes: 30 * GiB })]).size)
      .toBe(0);
    // The limit, when it is lower, wins.
    expect(sizes(allocateQuotas(20 * GiB, [volume('a', { usedBytes: null, sizeBytes: 50 * GiB, ceilingBytes: 30 * GiB })])))
      .toEqual({ a: 20 });
  });

  it('passes a capped disk\'s share of the headroom to the others', () => {
    const result = allocateQuotas(100 * GiB, [
      volume('a', { usedBytes: 0, sizeBytes: 50 * GiB, ceilingBytes: 10 * GiB }),
      volume('b', { usedBytes: 0, sizeBytes: 50 * GiB }),
    ]);
    // a shrinks to its ceiling; b's grow waits for a's reservation (committed sizes fill the limit).
    expect(sizes(result)).toEqual({ a: 10 });
    const settled = allocateQuotas(100 * GiB, [
      volume('a', { usedBytes: 0, sizeBytes: 10 * GiB, ceilingBytes: 10 * GiB }),
      volume('b', { usedBytes: 0, sizeBytes: 50 * GiB }),
    ]);
    expect(sizes(settled)).toEqual({ b: 90 });
  });

  it('holds data over a lowered ceiling at the ceiling, or ratchets it down on a filesystem that refuses that', () => {
    const over = (belowUsage: boolean, usedBytes: number | null) => allocateQuotas(1_000 * GiB, [
      volume('a', { usedBytes, sizeBytes: 100 * GiB, ceilingBytes: 20 * GiB, belowUsage }),
      volume('b', { usedBytes: 0, sizeBytes: 10 * GiB }),
    ]);
    expect(sizes(over(true, 60 * GiB)).a).toBe(20);
    expect(sizes(over(false, 60 * GiB)).a).toBe(60);
    // Usage unknown: the ceiling holds where the filesystem takes it, nothing else moves.
    expect(sizes(over(true, null))).toEqual({ a: 20 });
    expect(over(false, null).size).toBe(0);
  });

  it('never floors a volume above its ceiling', () => {
    expect(sizes(allocateQuotas(100 * GiB, [volume('a', { usedBytes: null, sizeBytes: 5 * GiB, ceilingBytes: GiB / 2 })])))
      .toEqual({ a: 0.5 });
    expect(quotaFloor(0, 1)).toBe(1024 ** 2);
  });

  it('gives the data disks a floor when the system disks took the whole total', () => {
    expect(sizes(allocateQuotas(0, [volume('a', { usedBytes: 5 * GiB, sizeBytes: 50 * GiB })])))
      .toEqual({ a: 1 / 1024 });
  });
});
