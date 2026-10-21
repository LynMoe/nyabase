import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Capability, FailureCode, StoragePoolResizeFamily } from '@nyabase/common';
import { isSystemActor, type Actor } from '../iam/actor.js';
import type { VolumeRow } from './volume-dtos.js';

// --- authorisation ------------------------------------------------------------

export type VolumeAccess = 'owner' | 'admin';
export type VolumeKind = 'local' | 'shared';

/**
 * The one volume authorisation rule: a holder of the kind's administrator
 * capability (`ManageVolumes` / `ManageSharedVolumes`) gets the administrator
 * rules (no per-user grant limits, as the old /admin routes); otherwise the
 * owner gets the owner rules. Everything else, including a row of the other
 * kind, is a 404.
 */
export function assertCanAccess(
  actor: Actor,
  row: VolumeRow | undefined,
  kind: VolumeKind,
): { row: VolumeRow; access: VolumeAccess } {
  const rightKind = row !== undefined && (kind === 'local'
    ? row.shared_backend_id === null && row.server_id !== null && row.pool_id !== null
    : row.shared_backend_id !== null && row.server_id === null);
  if (!rightKind) throw new NotFoundException('Volume not found');
  return { row, access: accessOf(actor, row.owner_id, kind, 'Volume not found') };
}

/** Attaching needs the container's owner, or the kind's volume capability. */
export function assertCanAttach(
  actor: Actor,
  container: { owner_id: string },
  kind: VolumeKind,
): VolumeAccess {
  return accessOf(actor, container.owner_id, kind, 'Container not found');
}

function accessOf(
  actor: Actor,
  ownerId: string,
  kind: VolumeKind,
  notFound: string,
): VolumeAccess {
  if (
    isSystemActor(actor)
    || actor.capabilities.has(kind === 'local' ? Capability.ManageVolumes : Capability.ManageSharedVolumes)
  ) {
    return 'admin';
  }
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

/** CephFS Incus echoes `used === size` with total missing for both empty and full. */
export function isPhantomCephfsUsage(
  usedBytes: bigint | null,
  totalBytes: bigint | null,
  currentSizeBytes: bigint,
): boolean {
  if (usedBytes === null) return false;
  const totalMissing = totalBytes === null || totalBytes === 0n;
  return totalMissing && usedBytes >= currentSizeBytes;
}

/**
 * CephFS `used === size` with total missing cannot tell empty from full, so
 * that shape is unknown. Dir/btrfs/zfs keep occupancy, including used===size.
 */
export function normalizeObservedVolumeUsage(input: {
  readonly resizeFamily: 'quota_online' | 'block_backed';
  readonly driver: VolumeDriver;
  readonly usedBytes: bigint | null;
  readonly totalBytes: bigint | null;
  readonly currentSizeBytes: bigint;
}): bigint | null {
  if (input.usedBytes === null) {
    // Empty dir/btrfs/zfs quota volumes report `{ total: 0 }` without `used`.
    if (
      input.resizeFamily === 'quota_online'
      && input.driver !== 'cephfs'
      && input.totalBytes === 0n
    ) {
      return 0n;
    }
    return null;
  }
  if (input.driver !== 'cephfs') return input.usedBytes;
  if (isPhantomCephfsUsage(input.usedBytes, input.totalBytes, input.currentSizeBytes)) {
    return null;
  }
  return input.usedBytes;
}
