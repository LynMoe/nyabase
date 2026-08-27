import { describe, expect, it } from 'vitest';
import { ResourceLifecyclePhase, type VolumeDto } from '@nyabase/common';
import { filterAttachableVolumes } from './attachable-volumes.js';

const capability: VolumeDto['capability'] = {
  growOnline: true,
  shrinkOnline: true,
  shrinkRequiresStop: false,
  shrinkNever: false,
  enforceUsageFloor: true,
};

function volume(overrides: Partial<VolumeDto> & Pick<VolumeDto, 'id' | 'ownerId' | 'serverId'>): VolumeDto {
  return {
    poolId: 'pool',
    poolName: 'pool',
    sharedBackendId: null,
    name: overrides.id,
    incusName: overrides.id,
    sizeBytes: 10,
    usedBytes: 1,
    scope: overrides.serverId
      ? { kind: 'local', serverId: overrides.serverId, poolId: 'pool' }
      : { kind: 'shared', sharedBackendId: 'backend', poolId: 'pool' },
    capability,
    lifecyclePhase: ResourceLifecyclePhase.Active,
    generation: 1,
    observedGeneration: 1,
    needsAttention: false,
    failureCode: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    attachments: [],
    ...overrides,
  };
}

describe('filterAttachableVolumes', () => {
  const container = { ownerId: 'owner-a', serverId: 'server-1' };

  it('drops cross-owner, deleting, attached, and local cross-server volumes', () => {
    const attached = new Set(['attached']);
    const filtered = filterAttachableVolumes([
      volume({ id: 'ok', ownerId: 'owner-a', serverId: 'server-1' }),
      volume({ id: 'other-owner', ownerId: 'owner-b', serverId: 'server-1' }),
      volume({ id: 'attached', ownerId: 'owner-a', serverId: 'server-1' }),
      volume({
        id: 'deleting',
        ownerId: 'owner-a',
        serverId: 'server-1',
        lifecyclePhase: ResourceLifecyclePhase.Deleting,
      }),
      volume({ id: 'other-server', ownerId: 'owner-a', serverId: 'server-2' }),
      volume({ id: 'shared', ownerId: 'owner-a', serverId: null }),
    ], container, attached);
    expect(filtered.map((item) => item.id)).toEqual(['ok', 'shared']);
  });
});
