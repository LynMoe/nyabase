import { NotFoundException } from '@nestjs/common';
import {
  CEPHFS_USAGE_SOURCE_KEY,
  CEPHFS_USAGE_SOURCE_RBYTES,
  Role,
  type ListScope,
} from '@nyabase/common';
import { assertListScope, isSystemActor, type Actor } from '../iam/actor.js';
import type { VolumeRow } from './volume-dtos.js';

// --- authorisation ------------------------------------------------------------

export type VolumeAccess = 'owner' | 'admin';
export type VolumeKind = 'local' | 'shared';

/**
 * The one volume authorisation rule: the owner gets the owner rules whatever
 * their role; `scope=all` (user admin role required, else 403) is the explicit
 * override that gets the administrator rules (no per-user grant limits), also
 * on the admin's own volumes. Everything else, including a row of the other
 * kind, is a 404.
 */
export function assertCanAccess(
  actor: Actor,
  row: VolumeRow | undefined,
  kind: VolumeKind,
  scope: ListScope,
): { row: VolumeRow; access: VolumeAccess } {
  const rightKind = row !== undefined && (kind === 'local'
    ? row.shared_backend_id === null && row.server_id !== null && row.pool_id !== null
    : row.shared_backend_id !== null && row.server_id === null);
  if (!rightKind) throw new NotFoundException('Volume not found');
  return { row, access: accessOf(actor, row.owner_id, scope, 'Volume not found') };
}

function accessOf(
  actor: Actor,
  ownerId: string,
  scope: ListScope,
  notFound: string,
): VolumeAccess {
  assertListScope(actor, scope, Role.UserAdmin);
  if (isSystemActor(actor) || scope === 'all') return 'admin';
  if (ownerId === actor.userId) return 'owner';
  throw new NotFoundException(notFound);
}

export function assertSharedExists(row: VolumeRow | undefined): asserts row is VolumeRow {
  if (!row || row.shared_backend_id === null || row.server_id !== null) {
    throw new NotFoundException('Volume not found');
  }
}

// --- mutation guards ----------------------------------------------------------

/** Transaction options for every user-visible volume mutation. */
export const VOLUME_TX = { isolationLevel: 'serializable', maxAttempts: 5 } as const;

export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === '23505') return true;
    current = record.cause;
  }
  return false;
}

export interface ShrinkReservation {
  /** The reservation to store with the new size; null when the new size covers it. */
  reservedBytes: number | null;
  /** How much the committed bytes (`max(size, reservation)`) grow; never negative. */
  committedDeltaBytes: number;
}

/**
 * A resize writes the requested size at once, but a shrink only frees space
 * when the reconciler applies it, and a shrink the usage turns out to block is
 * reverted to the size Incus still holds. Until a reconcile verifies the size,
 * Incus may hold any size the row had since then, so the row keeps the largest
 * of them reserved and quota / capacity count `max(size, reservation)`
 * (`committedVolumeBytesSql`, `committedRootBytesSql`). Admission checks only
 * the growth of that committed figure: re-growing within a pending shrink
 * costs nothing, and the revert never exceeds what was admitted. Shared by
 * custom volumes and container root disks.
 */
export function shrinkReservation(input: {
  currentBytes: number;
  reservedBytes: number | null;
  requestedBytes: number;
}): ShrinkReservation {
  const committedBefore = Math.max(input.currentBytes, input.reservedBytes ?? 0);
  const reservedBytes = committedBefore > input.requestedBytes ? committedBefore : null;
  return {
    reservedBytes,
    committedDeltaBytes: Math.max(0, input.requestedBytes - committedBefore),
  };
}

/** The `nyv-<uuid>` name of every custom volume nyabase creates in Incus. */
export const MANAGED_VOLUME_NAME = /^nyv-[0-9a-f]{32}$/;

// --- usage and resize decisions (shared with the reconciler) --------------------

export type VolumeDriver = 'dir' | 'btrfs' | 'zfs' | 'lvm' | 'lvmcluster' | 'ceph' | 'cephfs';

export interface VolumeResizeInput {
  readonly resizeFamily: 'quota_online' | 'block_backed';
  readonly currentSizeBytes: bigint;
  readonly desiredSizeBytes: bigint;
  readonly usedBytes: bigint | null;
  readonly attached: boolean;
  readonly allConsumersStopped: boolean;
  /**
   * The filesystem takes a quota below the data (dir with project quotas,
   * CephFS): the quota balancer's forced shrink applies as is, and the
   * volume can be read and emptied but not written until it fits.
   */
  readonly belowUsage?: boolean;
}

export type VolumeResizeDecision =
  | { readonly action: 'none' | 'grow' | 'shrink'; readonly reason?: undefined }
  | { readonly action: 'blocked'; readonly reason: 'usage_floor' | 'usage_unknown' | 'detach' | 'stop' };

export function decideVolumeResize(input: VolumeResizeInput): VolumeResizeDecision {
  if (input.desiredSizeBytes === input.currentSizeBytes) return { action: 'none' };
  if (input.desiredSizeBytes > input.currentSizeBytes) return { action: 'grow' };
  if (input.resizeFamily === 'quota_online' && input.belowUsage === true) return { action: 'shrink' };
  if (input.resizeFamily === 'quota_online' && input.usedBytes === null) {
    return { action: 'blocked', reason: 'usage_unknown' };
  }
  if (
    input.usedBytes !== null
    && input.desiredSizeBytes < input.usedBytes
  ) {
    return { action: 'blocked', reason: 'usage_floor' };
  }
  if (input.resizeFamily === 'block_backed' && input.attached) {
    return { action: 'blocked', reason: 'detach' };
  }
  if (input.resizeFamily === 'block_backed' && !input.allConsumersStopped) {
    return { action: 'blocked', reason: 'stop' };
  }
  return { action: 'shrink' };
}

/** The `source` of the quota balancer's resize intents (`StorageBalancer`). */
export const QUOTA_BALANCER_SOURCE = 'quota_balancer';

/**
 * Whether Incus takes a quota below the data a volume holds on this pool
 * (dir with project quotas, CephFS: checked on Incus 7.6). ZFS refuses; the
 * others are not known to accept it, so their quotas ratchet.
 */
export function quotaBelowUsage(driver: string, quotaEffective: boolean | null): boolean {
  return driver === 'cephfs' || (driver === 'dir' && quotaEffective === true);
}

/**
 * Whether a volume state's `usage` is the host agent's CephFS figure: Incus
 * itself answers a CephFS volume's quota there, the agent replaces it with
 * `ceph.dir.rbytes` and marks it (`CEPHFS_USAGE_SOURCE_KEY`).
 */
export function isCephRbytesUsage(usage: unknown): boolean {
  return typeof usage === 'object'
    && usage !== null
    && (usage as Record<string, unknown>)[CEPHFS_USAGE_SOURCE_KEY] === CEPHFS_USAGE_SOURCE_RBYTES;
}

/**
 * Observed usage, or null when unknown. CephFS usage counts only when the agent
 * read it (`usedFromCephRbytes`): unmarked, Incus' answer is the quota, which
 * cannot tell empty from full. Dir/btrfs/zfs keep occupancy, including used===size.
 */
export function normalizeObservedVolumeUsage(input: {
  readonly resizeFamily: 'quota_online' | 'block_backed';
  readonly driver: VolumeDriver;
  readonly usedBytes: bigint | null;
  readonly totalBytes: bigint | null;
  /** `isCephRbytesUsage` of the state's `usage`. */
  readonly usedFromCephRbytes: boolean;
}): bigint | null {
  if (input.driver === 'cephfs') return input.usedFromCephRbytes ? input.usedBytes : null;
  if (input.usedBytes === null) {
    // Empty dir/btrfs/zfs quota volumes report `{ total: 0 }` without `used`.
    if (input.resizeFamily === 'quota_online' && input.totalBytes === 0n) return 0n;
    return null;
  }
  return input.usedBytes;
}

/**
 * What can still be committed under overcommit: all owners together up to
 * total × ratio, and (given `ownerCommitted`) one owner up to the physical total.
 */
export function overcommitAvailableBytes(
  total: number,
  ratio: number,
  committed: number,
  ownerCommitted: number | null,
): number {
  const shared = total * ratio - committed;
  const own = ownerCommitted === null ? shared : total - ownerCommitted;
  return Math.max(0, Math.min(shared, own));
}
