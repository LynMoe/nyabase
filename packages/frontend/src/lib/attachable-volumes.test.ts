import { describe, expect, it } from 'vitest';
import { ResourceLifecyclePhase, type SharedVolumeDto, type VolumeDto } from '@nyabase/common';
import { filterAttachableSharedVolumes, filterAttachableVolumes } from './attachable-volumes.js';

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
    name: overrides.id,
    incusName: overrides.id,
    sizeBytes: 10,
    usedBytes: 1,
    scope: { kind: 'local', serverId: overrides.serverId, poolId: 'pool' },
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
    ], container, attached);
    expect(filtered.map((item) => item.id)).toEqual(['ok']);
  });
});

describe('filterAttachableSharedVolumes', () => {
  it('keeps owner-matching shared volumes that are not attached or deleting', () => {
    const attached = new Set(['attached']);
    const shared = (overrides: Partial<SharedVolumeDto> & Pick<SharedVolumeDto, 'id' | 'ownerId'>): SharedVolumeDto => ({
      sharedBackendId: 'backend',
      sharedBackendName: 'ceph',
      name: overrides.id,
      incusName: overrides.id,
      sizeBytes: 10,
      usedBytes: null,
      capability,
      lifecyclePhase: ResourceLifecyclePhase.Active,
      generation: 1,
      observedGeneration: null,
      needsAttention: false,
      failureCode: null,
      dirEnsured: false,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
      attachments: [],
      ...overrides,
    });
    const filtered = filterAttachableSharedVolumes([
      shared({ id: 'ok', ownerId: 'owner-a' }),
      shared({ id: 'other-owner', ownerId: 'owner-b' }),
      shared({ id: 'attached', ownerId: 'owner-a' }),
      shared({
        id: 'deleting',
        ownerId: 'owner-a',
        lifecyclePhase: ResourceLifecyclePhase.Deleting,
      }),
    ], { ownerId: 'owner-a' }, attached);
    expect(filtered.map((item) => item.id)).toEqual(['ok']);
  });
});
