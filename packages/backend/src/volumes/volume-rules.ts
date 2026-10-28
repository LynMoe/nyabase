import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  CEPHFS_USAGE_SOURCE_KEY,
  CEPHFS_USAGE_SOURCE_RBYTES,
  FailureCode,
  Role,
  StoragePoolResizeFamily,
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

/** Attaching needs the container's owner, or `scope=all` as an admin. */
export function assertCanAttach(
  actor: Actor,
  container: { owner_id: string },
  scope: ListScope,
): VolumeAccess {
  return accessOf(actor, container.owner_id, scope, 'Container not found');
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

export function nameTakenConflict(name: string): ConflictException {
  return new ConflictException({
    code: FailureCode.InvalidInput,
    message: 'A volume with this name already exists in the storage scope',
    details: { name },
  });
}

export function assertValidVolumeSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new BadRequestException({
      code: FailureCode.InvalidInput,
      message: 'Volume size must be a positive safe integer',
    });
  }
}

/** Common preconditions of a PATCH: revision match, not deleting, sane size. */
export function assertPatchable(
  current: VolumeRow,
  input: { expectedRevision: number; sizeBytes?: number },
): void {
  if (current.revision !== input.expectedRevision) {
    throw new ConflictException({ code: FailureCode.RevisionConflict });
  }
  if (current.lifecycle_phase === 'deleting') {
    throw new ConflictException({
      code: FailureCode.InvalidInput,
      message: 'A deleting volume cannot be modified',
      details: { volumeId: current.id, lifecyclePhase: current.lifecycle_phase },
    });
  }
  if (input.sizeBytes !== undefined) assertValidVolumeSize(input.sizeBytes);
}

// --- resize policy ------------------------------------------------------------

export interface VolumeResizeCheckInput {
  volumeId: string;
  poolId: string;
  currentSizeBytes: number;
  requestedSizeBytes: number;
  usedBytes: number | null;
  resizeFamily: StoragePoolResizeFamily;
  blockFilesystem: string | null;
  attachments: ReadonlyArray<{
    attachmentId: string;
    containerId: string;
    containerPath: string;
  }>;
}

export interface VolumeResizeCheckFailure {
  code:
    | FailureCode.VolumeShrinkBelowUsage
    | FailureCode.VolumeShrinkRequiresDetach
    | FailureCode.VolumeShrinkUnsupported
    | FailureCode.VolumeUsageUnknown;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Shrink floor uses observed usedBytes. Quota-online used===size is real usage,
 * not a phantom-empty signal.
 */
export function effectiveUsageForShrinkFloor(input: {
  usedBytes: number | null;
  currentSizeBytes: number;
  resizeFamily: StoragePoolResizeFamily | string;
}): number | null {
  return input.usedBytes;
}

export function volumeUsageUnknownFailure(
  volumeId: string,
  requestedBytes: number,
): VolumeResizeCheckFailure {
  return {
    code: FailureCode.VolumeUsageUnknown,
    message: 'Volume usage is unknown; shrink is not allowed until usage is observed',
    details: {
      volumeId,
      requestedBytes,
      usedBytes: null,
    },
  };
}

/**
 * Pure custom-volume resize policy.  It deliberately has no Incus client
 * input: the controller must reject an unsafe request before an intent is
 * created or a physical request is possible.
 */
export function checkVolumeResize(
  input: VolumeResizeCheckInput,
): VolumeResizeCheckFailure | null {
  const delta = input.requestedSizeBytes - input.currentSizeBytes;
  if (delta >= 0) return null;
  const effectiveUsed = effectiveUsageForShrinkFloor({
    usedBytes: input.usedBytes,
    currentSizeBytes: input.currentSizeBytes,
    resizeFamily: input.resizeFamily,
  });
  if (
    input.resizeFamily === StoragePoolResizeFamily.QuotaOnline
    && effectiveUsed === null
  ) {
    return {
      code: FailureCode.VolumeUsageUnknown,
      message: 'Volume usage is unknown; shrink is not allowed until usage is observed',
      details: {
        volumeId: input.volumeId,
        requestedBytes: input.requestedSizeBytes,
        usedBytes: null,
      },
    };
  }
  if (effectiveUsed !== null && effectiveUsed > input.requestedSizeBytes) {
    return {
      code: FailureCode.VolumeShrinkBelowUsage,
      message: 'Volume cannot shrink below observed usage',
      details: {
        volumeId: input.volumeId,
        requestedBytes: input.requestedSizeBytes,
        usedBytes: effectiveUsed,
      },
    };
  }
  if (
    input.resizeFamily === StoragePoolResizeFamily.BlockBacked
    && input.attachments.length > 0
  ) {
    return {
      code: FailureCode.VolumeShrinkRequiresDetach,
      message: 'Block-backed custom volume shrink requires detaching the volume first',
      details: {
        volumeId: input.volumeId,
        attachments: input.attachments,
      },
    };
  }
  if (input.blockFilesystem?.toLowerCase() === 'xfs') {
    return {
      code: FailureCode.VolumeShrinkUnsupported,
      message: 'XFS custom volume shrink is unsupported',
      details: {
        volumeId: input.volumeId,
        poolId: input.poolId,
        reason: 'xfs_cannot_shrink',
      },
    };
  }
  return null;
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
}

export type VolumeResizeDecision =
  | { readonly action: 'none' | 'grow' | 'shrink'; readonly reason?: undefined }
  | { readonly action: 'blocked'; readonly reason: 'usage_floor' | 'usage_unknown' | 'detach' | 'stop' };

export function decideVolumeResize(input: VolumeResizeInput): VolumeResizeDecision {
  if (input.desiredSizeBytes === input.currentSizeBytes) return { action: 'none' };
  if (input.desiredSizeBytes > input.currentSizeBytes) return { action: 'grow' };
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

/** Passes an admitted CephFS shrink retries an unreadable usage before it is undone. */
export const CEPHFS_USAGE_UNKNOWN_RETRIES = 5;

/**
 * A CephFS shrink was admitted on a real reading; unknown usage at apply time
 * means this executor's agent could not read ceph.dir.rbytes (a slow MDS, an
 * agent not upgraded yet), so retry a few times before undoing the shrink.
 */
export function retriesUnknownCephfsUsage(reason: string, driver: string, attemptCount: number): boolean {
  return reason === 'usage_unknown' && driver === 'cephfs' && attemptCount < CEPHFS_USAGE_UNKNOWN_RETRIES;
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
