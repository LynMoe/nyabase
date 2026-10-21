import type { StoragePoolDto, VolumeDto } from '@nyabase/common';
import {
  classifySizeChange,
  isQuotaIneffectiveCapability,
  quotaIneffectiveCreateHint,
  quotaIneffectiveResizeHint,
  shrinkNeverTooltip,
  validateShrinkFloor,
} from '../../../lib/storage-shrink.js';
import { GIB } from '../volume-form-fields.js';

/**
 * What the typed size means for this volume: the new byte size, whether the
 * change is a plain resize, a shrink that needs the volume detached or one that
 * is not allowed, and the quota / floor problems that block saving.
 */
export function deriveLocalVolumeState({
  editing,
  sizeGiB,
  selectedPool,
}: {
  editing: VolumeDto | undefined;
  sizeGiB: string;
  selectedPool: StoragePoolDto | undefined;
}) {
  const parsedGiB = Number(sizeGiB);
  const nextSize = Number.isFinite(parsedGiB) && parsedGiB > 0
    ? Math.round(parsedGiB * GIB)
    : NaN;
  const path = editing && Number.isFinite(nextSize)
    ? classifySizeChange(editing.capability, editing.sizeBytes, nextSize)
    : 'unchanged';
  const floorError = editing && (path === 'online' || path === 'requires_stop')
    ? validateShrinkFloor(editing.capability, nextSize, editing.usedBytes, editing.sizeBytes)
    : null;
  const shrinkBlocked = path === 'never';
  const createQuotaBlocked = !editing && selectedPool != null && selectedPool.quotaEffective !== true;
  const editQuotaBlocked = editing != null
    && path !== 'unchanged'
    && isQuotaIneffectiveCapability(editing.capability);
  const quotaError = createQuotaBlocked
    ? quotaIneffectiveCreateHint()
    : editQuotaBlocked
      ? quotaIneffectiveResizeHint()
      : null;
  const description = !editing
    ? (createQuotaBlocked ? quotaIneffectiveCreateHint() : null)
    : editQuotaBlocked
      ? quotaIneffectiveResizeHint()
      : path === 'never'
        ? shrinkNeverTooltip()
        : null;
  return {
    nextSize,
    path,
    floorError,
    shrinkBlocked,
    createQuotaBlocked,
    editQuotaBlocked,
    quotaError,
    description,
  };
}
