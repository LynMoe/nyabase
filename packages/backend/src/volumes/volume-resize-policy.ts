import { FailureCode, StoragePoolResizeFamily } from '@nyabase/common';

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

