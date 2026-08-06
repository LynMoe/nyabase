import { GpuGrantMode } from '@nyabase/common';

/**
 * Input types use structural duck-typing so this module remains importable
 * without pulling in persistence decorators (safe to use in unit tests).
 */

export interface GrantFields {
  cpuMillis: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  gpuMode: GpuGrantMode | null;
  gpuIndices: number[] | null;
}

export interface ResolvedGrantLimits {
  cpuMillis: number;
  memBytes: number;
  diskBytes: number;
  gpuMode: GpuGrantMode;
  gpuIndices: number[];
}

/**
 * Resolve nullable grant fields directly.
 * Null CPU/memory/disk means unlimited (0); null GPU mode means all GPUs.
 * Exported as a standalone function so it can be unit-tested without a database.
 */
export function resolveGrant(
  grant: GrantFields,
): ResolvedGrantLimits {
  return {
    cpuMillis: grant.cpuMillis ?? 0,
    memBytes: grant.memBytes ?? 0,
    diskBytes: grant.diskBytes ?? 0,
    gpuMode: grant.gpuMode ?? GpuGrantMode.All,
    gpuIndices: grant.gpuIndices ?? [],
  };
}
