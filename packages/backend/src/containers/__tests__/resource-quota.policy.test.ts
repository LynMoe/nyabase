import { describe, it, expect } from 'vitest';
import { ContainerPhase, GpuGrantMode } from '@nyabase/common';
import {
  resolveGpuIndices,
  shouldCountContainerForQuota,
} from '../resource-quota.policy.js';
import type { ResolvedServerGrant } from '../../access/access-resolver.service.js';

function makeGrant(overrides: Partial<ResolvedServerGrant> = {}): ResolvedServerGrant {
  return {
    cpuMillis: 4000,
    memBytes: 4 * 1024 ** 3,
    diskBytes: 50 * 1024 ** 3,
    gpuMode: GpuGrantMode.None,
    gpuIndices: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shouldCountContainerForQuota
// ---------------------------------------------------------------------------

describe('shouldCountContainerForQuota', () => {
  it('counts active containers', () => {
    expect(shouldCountContainerForQuota(ContainerPhase.Active)).toBe(true);
  });

  it('excludes delete-requested containers', () => {
    expect(shouldCountContainerForQuota(ContainerPhase.Deleting)).toBe(false);
  });

  it('excludes failed create placeholders so retries are not blocked by quota', () => {
    expect(shouldCountContainerForQuota(ContainerPhase.Failed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveGpuIndices
// ---------------------------------------------------------------------------

describe('resolveGpuIndices', () => {
  describe('GpuGrantMode.None', () => {
    it('returns no GPUs', () => {
      expect(resolveGpuIndices(makeGrant({ gpuMode: GpuGrantMode.None }), [0, 1])).toEqual([]);
    });
  });

  describe('GpuGrantMode.All', () => {
    it('returns all known server GPU indices', () => {
      const result = resolveGpuIndices(
        makeGrant({ gpuMode: GpuGrantMode.All }),
        [3, 1, 1, 0],
      );
      expect(result).toEqual([0, 1, 3]);
    });

    it('throws when no GPUs are known', () => {
      expect(() => resolveGpuIndices(makeGrant({ gpuMode: GpuGrantMode.All }), []))
        .toThrow('GPU inventory unavailable for this server');
    });
  });

  describe('GpuGrantMode.Indices', () => {
    it('returns all granted indices', () => {
      const result = resolveGpuIndices(
        makeGrant({ gpuMode: GpuGrantMode.Indices, gpuIndices: [2, 3, 4] }),
        [0, 1, 2, 3, 4],
      );
      expect(result).toEqual([2, 3, 4]);
    });

    it('deduplicates and sorts granted indices', () => {
      const result = resolveGpuIndices(
        makeGrant({ gpuMode: GpuGrantMode.Indices, gpuIndices: [3, 1, 3] }),
        [0, 1, 2, 3],
      );
      expect(result).toEqual([1, 3]);
    });

    it('rejects empty, unavailable, and nonexistent granted indices', () => {
      expect(() => resolveGpuIndices(
        makeGrant({ gpuMode: GpuGrantMode.Indices, gpuIndices: [] }),
        [0],
      )).toThrow('At least one GPU index');
      expect(() => resolveGpuIndices(
        makeGrant({ gpuMode: GpuGrantMode.Indices, gpuIndices: [0] }),
        [],
      )).toThrow('GPU inventory unavailable');
      expect(() => resolveGpuIndices(
        makeGrant({ gpuMode: GpuGrantMode.Indices, gpuIndices: [2] }),
        [0, 1],
      )).toThrow('GPU index 2 is not present');
    });
  });
});
