import { BadRequestException } from '@nestjs/common';
import { ContainerPhase, GpuGrantMode } from '@nyabase/common';
import type { ResolvedServerGrant } from '../access/access-resolver.service.js';

export const QUOTA_EXCLUDED_LIFECYCLE_PHASES: readonly ContainerPhase[] = [
  ContainerPhase.Failed,
  ContainerPhase.Deleting,
  ContainerPhase.Deleted,
] as const;

/**
 * Quota accounting follows user-facing availability: delete-requested
 * tombstones and failed create placeholders are no longer usable and must not
 * block replacement creates.
 */
export function shouldCountContainerForQuota(
  lifecyclePhase: ContainerPhase,
  deletedAt?: Date | string | null,
): boolean {
  return deletedAt == null
    && !QUOTA_EXCLUDED_LIFECYCLE_PHASES.includes(lifecyclePhase);
}

/**
 * Resolve the concrete GPU indices to assign from the user's resolved grant.
 * GPUs are shared/reusable, so this returns the maximum granted index set for
 * each new container rather than excluding indices assigned elsewhere.
 */
export function resolveGpuIndices(
  grant: ResolvedServerGrant,
  knownGpuIndices: number[],
): number[] {
  switch (grant.gpuMode) {
    case GpuGrantMode.None:
      return [];

    case GpuGrantMode.All:
      if (knownGpuIndices.length === 0) {
        throw new BadRequestException('GPU inventory unavailable for this server');
      }
      return [...new Set(knownGpuIndices)].sort((a, b) => a - b);

    case GpuGrantMode.Indices:
      return [...new Set(grant.gpuIndices)].sort((a, b) => a - b);
  }
}
