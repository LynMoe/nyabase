import { describe, expect, it, vi } from 'vitest';
import { DataDirReconcilerService } from './data-dir-reconciler.service.js';

const disk = {
  diskId: 'disk-a',
  mountPoint: '/data-a',
  sourceIdentity: 'local:xfs:uuid-a',
  totalBytes: 1,
  usedBytes: 0,
  pquotaEnabled: true,
};

const row = (desiredState: 'creating' | 'active' | 'removing' | 'failed' = 'active') => ({
  id: 'data-dir-a',
  userId: 'user-a',
  sourceKind: 'local' as const,
  sourceId: 'disk-a',
  name: 'work',
  serverId: 'server-a',
  desiredState,
});

const reported = [{
  sourceKind: 'local' as const,
  sourceId: 'disk-a',
  resourceId: 'data-dir-a',
  hostPath: '/data-a/.nyabase/dirs/data-dir-a/data',
}];

function serviceWith(durableRows: ReturnType<typeof row>[]) {
  return new DataDirReconcilerService(
    {
      listAssignmentsForServer: vi.fn().mockResolvedValue([]),
      listDataDirectoriesForServerInventory: vi.fn().mockResolvedValue(durableRows),
      listRemoteFsMountsByIds: vi.fn().mockResolvedValue([]),
    } as never,
    { getDataDirIssues: vi.fn().mockReturnValue([]) } as never,
  );
}

function remoteServiceWith(assignmentState: 'ensuring' | 'active' | 'removing' | 'failed') {
  const remoteDir = {
    ...row(),
    sourceKind: 'remote' as const,
    sourceId: 'remote-a',
    serverId: null,
  };
  return new DataDirReconcilerService(
    {
      listAssignmentsForServer: vi.fn().mockResolvedValue([{
        id: 'assignment-a',
        serverId: 'server-a',
        remoteFsMountId: 'remote-a',
        desiredState: assignmentState,
      }]),
      listDataDirectoriesForServerInventory: vi.fn().mockResolvedValue([remoteDir]),
      listRemoteFsMountsByIds: vi.fn().mockResolvedValue([{
        id: 'remote-a',
        hostMountPoint: '/mnt/remote-a',
      }]),
    } as never,
    { getDataDirIssues: vi.fn().mockReturnValue([]) } as never,
  );
}

describe('DataDirReconcilerService authoritative inventory', () => {
  it('accepts one exact active durable directory', async () => {
    await expect(serviceWith([row()]).reconcileReport('server-a', reported, [disk]))
      .resolves.toEqual({
        issues: { orphans: [], missing: [] },
        blockingReason: null,
      });
  });

  it('blocks promotion when an active directory is missing or an unknown directory is reported', async () => {
    const missing = await serviceWith([row()]).reconcileReport('server-a', [], [disk]);
    expect(missing.blockingReason).toContain('1 active-missing');
    expect(missing.issues.missing).toHaveLength(1);

    const orphan = await serviceWith([]).reconcileReport('server-a', reported, [disk]);
    expect(orphan.blockingReason).toContain('1 orphan');
    expect(orphan.issues.orphans).toHaveLength(1);
  });

  it('allows transition states and exposes a failed durable row without blocking its repair path', async () => {
    await expect(serviceWith([row('creating')]).reconcileReport('server-a', [], [disk]))
      .resolves.toMatchObject({ blockingReason: null });
    await expect(serviceWith([row('removing')]).reconcileReport('server-a', reported, [disk]))
      .resolves.toMatchObject({ blockingReason: null });
    await expect(serviceWith([row('failed')]).reconcileReport('server-a', reported, [disk]))
      .resolves.toMatchObject({
        blockingReason: null,
        issues: { missing: [expect.objectContaining({ kind: 'missing' })] },
      });
  });

  it('fails closed when durable local state refers to an unreported physical source', async () => {
    await expect(serviceWith([row()]).reconcileReport('server-a', reported, []))
      .rejects.toThrow('unreported source');
  });

  it('recognizes exact directories while a remote assignment is ensuring without requiring them yet', async () => {
    const exact = [{
      sourceKind: 'remote' as const,
      sourceId: 'remote-a',
      resourceId: 'data-dir-a',
      hostPath: '/mnt/remote-a/.nyabase/dirs/data-dir-a/data',
    }];
    await expect(remoteServiceWith('ensuring').reconcileReport('server-a', exact, []))
      .resolves.toEqual({
        issues: { orphans: [], missing: [] },
        blockingReason: null,
      });
    await expect(remoteServiceWith('ensuring').reconcileReport('server-a', [], []))
      .resolves.toMatchObject({ blockingReason: null });
  });

  it('reports an active remote assignment missing without treating one client as global proof', async () => {
    const active = await remoteServiceWith('active').reconcileReport('server-a', [], []);
    expect(active.blockingReason).toBeNull();
    expect(active.issues.missing).toHaveLength(1);

    await expect(remoteServiceWith('removing').reconcileReport('server-a', [], []))
      .resolves.toMatchObject({ blockingReason: null });
    await expect(remoteServiceWith('failed').reconcileReport('server-a', [], []))
      .resolves.toMatchObject({ blockingReason: null });
  });

  it('still blocks an unknown remote directory as orphan evidence', async () => {
    const orphan = await remoteServiceWith('active').reconcileReport('server-a', [{
      sourceKind: 'remote',
      sourceId: 'remote-a',
      resourceId: 'unknown-remote-dir',
      hostPath: '/mnt/remote-a/.nyabase/dirs/unknown-remote-dir/data',
    }], []);

    expect(orphan.blockingReason).toContain('1 orphan');
    expect(orphan.issues.orphans).toHaveLength(1);
    expect(orphan.issues.missing).toHaveLength(1);
  });
});
