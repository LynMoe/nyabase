import { GpuGrantMode } from '@nyabase/common';
import type { ResolvedServerGrant } from './access-resolver.service.js';

/**
 * Input types use structural duck-typing so this module remains importable
 * without pulling in TypeORM entity decorators (safe to use in unit tests).
 */

export interface GrantFields {
  cpuMillis: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  gpuMode: GpuGrantMode | null;
  gpuIndices: number[] | null;
}

export interface ServerDefaults {
  defaultCpuMillis: number;
  defaultMemBytes: number;
  defaultDiskBytes: number;
  defaultGpuMode: GpuGrantMode;
  defaultGpuIndices: number[];
}

/**
 * Merge a grant's nullable resource fields with the server's defaults.
 * A null field means "inherit from server default".
 * Exported as a standalone function so it can be unit-tested without TypeORM.
 */
export function resolveGrantWithServerDefaults(
  grant: GrantFields,
  defaults: ServerDefaults,
): ResolvedServerGrant {
  return {
    cpuMillis: grant.cpuMillis ?? defaults.defaultCpuMillis,
    memBytes: grant.memBytes ?? defaults.defaultMemBytes,
    diskBytes: grant.diskBytes ?? defaults.defaultDiskBytes,
    gpuMode: grant.gpuMode ?? defaults.defaultGpuMode,
    gpuIndices: grant.gpuIndices ?? defaults.defaultGpuIndices,
  };
}
