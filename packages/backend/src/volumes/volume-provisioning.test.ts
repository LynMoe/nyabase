import { describe, expect, it } from 'vitest';
import {
  backendGrantKey,
  planProvisioning,
  type PlanDisk,
  type PlanSnapshot,
  type PlanVolume,
} from './volume-provisioning.js';

const GiB = 1024 ** 3;

function disk(values: Partial<PlanDisk> & Pick<PlanDisk, 'kind' | 'id'>): PlanDisk {
  return {
    serverId: values.kind === 'pool' ? 's1' : null,
    mountPath: '/data1',
    maintenance: false,
    belowUsage: true,
    totalBytes: null,
    overcommitRatio: 1,
    committedBytes: 0,
    ...values,
  };
}

function vol(values: Partial<PlanVolume> & Pick<PlanVolume, 'id' | 'ownerId' | 'kind' | 'diskId'>): PlanVolume {
  return {
    serverId: values.kind === 'pool' ? 's1' : null,
    phase: 'active',
    revision: 1,
    sizeBytes: 100 * GiB,
    reservedBytes: null,
    usedBytes: 0,
    ownerOtherBytes: 0,
    ...values,
  };
}

function snapshot(values: Partial<PlanSnapshot>): PlanSnapshot {
  return {
    disks: [],
    grants: [],
    volumes: [],
    containers: [],
    attachments: [],
    backendPools: new Map(),
    ...values,
  };
}

describe('planProvisioning', () => {
  it('creates one volume per covered, enabled disk, sized from the grant', () => {
    const plan = planProvisioning(snapshot({
      disks: [
        disk({ kind: 'pool', id: 'p1', mountPath: '/data1' }),
        disk({ kind: 'pool', id: 'p2', mountPath: null }),
        disk({ kind: 'pool', id: 'p3', mountPath: '/data3', maintenance: true }),
        disk({ kind: 'backend', id: 'b1', mountPath: '/meowfs' }),
      ],
      grants: [
        { key: 'g1', userId: 'u1', limitBytes: 300 * GiB, kind: 'pool', diskIds: ['p1', 'p2', 'p3'] },
        { key: backendGrantKey('u1', 'b1'), userId: 'u1', limitBytes: 10 * GiB, kind: 'backend', diskIds: ['b1'] },
      ],
    }));
    expect(plan.creates).toEqual([
      { ownerId: 'u1', kind: 'pool', diskId: 'p1', serverId: 's1', mountPath: '/data1', sizeBytes: 300 * GiB },
      { ownerId: 'u1', kind: 'backend', diskId: 'b1', serverId: null, mountPath: '/meowfs', sizeBytes: 10 * GiB },
    ]);
  });

  it('mounts active volumes into every container of the owner that can reach them', () => {
    const plan = planProvisioning(snapshot({
      disks: [
        disk({ kind: 'pool', id: 'p1', serverId: 's1', mountPath: '/data1' }),
        disk({ kind: 'backend', id: 'b1', mountPath: '/meowfs' }),
      ],
      grants: [
        { key: 'g1', userId: 'u1', limitBytes: 100 * GiB, kind: 'pool', diskIds: ['p1'] },
        { key: backendGrantKey('u1', 'b1'), userId: 'u1', limitBytes: 100 * GiB, kind: 'backend', diskIds: ['b1'] },
      ],
      volumes: [
        vol({ id: 'v1', ownerId: 'u1', kind: 'pool', diskId: 'p1', serverId: 's1' }),
        vol({ id: 'v2', ownerId: 'u1', kind: 'backend', diskId: 'b1' }),
      ],
      containers: [
        { id: 'c1', ownerId: 'u1', serverId: 's1', name: 'a' },
        { id: 'c2', ownerId: 'u1', serverId: 's2', name: 'b' },
        { id: 'c3', ownerId: 'u2', serverId: 's1', name: 'c' },
      ],
      backendPools: new Map([['b1\0s1', 'cp1']]),
    }));
    expect(plan.mounts).toEqual([
      { containerId: 'c1', ownerId: 'u1', serverId: 's1', volumeId: 'v1', containerPath: '/data1', poolId: 'p1' },
      { containerId: 'c1', ownerId: 'u1', serverId: 's1', volumeId: 'v2', containerPath: '/meowfs', poolId: 'cp1' },
    ]);
  });

  it('skips mounted pairs, taken paths, uncovered and unready volumes', () => {
    const plan = planProvisioning(snapshot({
      disks: [
        disk({ kind: 'pool', id: 'p1', mountPath: '/data1' }),
        disk({ kind: 'pool', id: 'p2', mountPath: '/data2' }),
        disk({ kind: 'pool', id: 'p3', mountPath: '/data3' }),
        disk({ kind: 'pool', id: 'p4', mountPath: '/data4' }),
      ],
      grants: [{ key: 'g1', userId: 'u1', limitBytes: 400 * GiB, kind: 'pool', diskIds: ['p1', 'p2', 'p3'] }],
      volumes: [
        vol({ id: 'v1', ownerId: 'u1', kind: 'pool', diskId: 'p1' }),
        vol({ id: 'v2', ownerId: 'u1', kind: 'pool', diskId: 'p2' }),
        vol({ id: 'v3', ownerId: 'u1', kind: 'pool', diskId: 'p3', phase: 'provisioning' }),
        // No grant covers p4 (lapsed): the access-lapse processor's.
        vol({ id: 'v4', ownerId: 'u1', kind: 'pool', diskId: 'p4' }),
      ],
      containers: [{ id: 'c1', ownerId: 'u1', serverId: 's1', name: 'a' }],
      attachments: [
        { containerId: 'c1', volumeId: 'v1', containerPath: '/elsewhere' },
        { containerId: 'c1', volumeId: 'old', containerPath: '/data2' },
      ],
    }));
    expect(plan.mounts).toEqual([]);
    expect(plan.pathConflicts).toEqual([{ containerId: 'c1', volumeId: 'v2', containerPath: '/data2' }]);
  });

  it('leaves failed volumes alone and creates nothing in their place', () => {
    const plan = planProvisioning(snapshot({
      disks: [disk({ kind: 'pool', id: 'p1' })],
      grants: [{ key: 'g1', userId: 'u1', limitBytes: 50 * GiB, kind: 'pool', diskIds: ['p1'] }],
      volumes: [vol({ id: 'v1', ownerId: 'u1', kind: 'pool', diskId: 'p1', phase: 'failed' })],
      containers: [{ id: 'c1', ownerId: 'u1', serverId: 's1', name: 'a' }],
    }));
    expect(plan).toEqual({ creates: [], mounts: [], resizes: [], pathConflicts: [] });
  });

  it('keeps sizing a volume whose disk was disabled, but mounts it nowhere new', () => {
    const plan = planProvisioning(snapshot({
      disks: [disk({ kind: 'pool', id: 'p1', mountPath: null })],
      grants: [{ key: 'g1', userId: 'u1', limitBytes: 50 * GiB, kind: 'pool', diskIds: ['p1'] }],
      volumes: [vol({ id: 'v1', ownerId: 'u1', kind: 'pool', diskId: 'p1', sizeBytes: 100 * GiB })],
      containers: [{ id: 'c1', ownerId: 'u1', serverId: 's1', name: 'a' }],
    }));
    expect(plan.resizes).toEqual([{ volumeId: 'v1', revision: 1, sizeBytes: 50 * GiB }]);
    expect(plan.mounts).toEqual([]);
  });

  it('caps a new volume by the disk\'s capacity left for the owner', () => {
    const plan = planProvisioning(snapshot({
      disks: [disk({ kind: 'pool', id: 'p1', totalBytes: 100 * GiB, committedBytes: 70 * GiB })],
      grants: [{ key: 'g1', userId: 'u1', limitBytes: 500 * GiB, kind: 'pool', diskIds: ['p1'] }],
    }));
    expect(plan.creates.map((create) => create.sizeBytes)).toEqual([30 * GiB]);
  });
});
