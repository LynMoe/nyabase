/** Pure volume sizing and usage rules shared by the API services and the reconciler. */

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
