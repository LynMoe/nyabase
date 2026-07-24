import { BadRequestException } from '@nestjs/common';
import { ContainerPhase, GpuGrantMode } from '@nyabase/common';
import type { ResolvedServerGrant } from '../access/access-resolver.service.js';

export const QUOTA_EXCLUDED_LIFECYCLE_PHASES: readonly ContainerPhase[] = [
  ContainerPhase.Failed,
  ContainerPhase.Deleting,
] as const;

/**
 * Quota accounting follows user-facing availability: delete-requested and
 * failed create placeholders are no longer usable and must not block retries.
 */
export function shouldCountContainerForQuota(
  lifecyclePhase: ContainerPhase,
): boolean {
  return !QUOTA_EXCLUDED_LIFECYCLE_PHASES.includes(lifecyclePhase);
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
      if (grant.gpuIndices.length === 0) {
        throw new BadRequestException('At least one GPU index must be granted in indices mode');
      }
      if (knownGpuIndices.length === 0) {
        throw new BadRequestException('GPU inventory unavailable for this server');
      }
      {
        const known = new Set(knownGpuIndices);
        const selected = [...new Set(grant.gpuIndices)].sort((a, b) => a - b);
        const unavailable = selected.find((index) => !known.has(index));
        if (unavailable !== undefined) {
          throw new BadRequestException(`GPU index ${unavailable} is not present on this server`);
        }
        return selected;
      }
  }
}
