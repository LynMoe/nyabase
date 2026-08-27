import { describe, expect, it, vi } from 'vitest';
import { IncusError } from '../incus/index.js';
import {
  capacityScope,
  decideVolumeResize,
  normalizeObservedVolumeUsage,
  VolumeReconciler,
} from './volume-reconciler.service.js';

describe('volume reconciliation policy', () => {
  it('normalizes false-full CephFS / quota_online usage reports', () => {
    expect(normalizeObservedVolumeUsage({
      resizeFamily: 'quota_online',
      driver: 'cephfs',
      usedBytes: 100n,
      totalBytes: 0n,
      currentSizeBytes: 100n,
    })).toBe(0n);
    expect(normalizeObservedVolumeUsage({
      resizeFamily: 'quota_online',
      driver: 'dir',
      usedBytes: 100n,
      totalBytes: null,
      currentSizeBytes: 100n,
    })).toBe(0n);
    expect(normalizeObservedVolumeUsage({
      resizeFamily: 'block_backed',
      driver: 'cephfs',
      usedBytes: 100n,
      totalBytes: null,
      currentSizeBytes: 100n,
    })).toBe(0n);
    expect(normalizeObservedVolumeUsage({
      resizeFamily: 'quota_online',
      driver: 'cephfs',
      usedBytes: 40n,
      totalBytes: 0n,
      currentSizeBytes: 100n,
    })).toBe(40n);
    expect(normalizeObservedVolumeUsage({
      resizeFamily: 'quota_online',
      driver: 'cephfs',
      usedBytes: 100n,
      totalBytes: 100n,
      currentSizeBytes: 100n,
    })).toBe(100n);
    expect(normalizeObservedVolumeUsage({
      resizeFamily: 'block_backed',
      driver: 'zfs',
      usedBytes: 100n,
      totalBytes: 0n,
      currentSizeBytes: 100n,
    })).toBe(100n);
  });

  it('allows quota-online shrink after normalizing a false-full usage report', () => {
    const usedBytes = normalizeObservedVolumeUsage({
      resizeFamily: 'quota_online',
      driver: 'cephfs',
      usedBytes: 20n,
      totalBytes: 0n,
      currentSizeBytes: 20n,
    });
    expect(decideVolumeResize({
      resizeFamily: 'quota_online',
      currentSizeBytes: 20n,
      desiredSizeBytes: 8n,
      usedBytes,
      attached: true,
      allConsumersStopped: false,
    })).toEqual({ action: 'shrink' });
  });

  it('allows quota-online growth and enforces the usage floor before shrink', () => {
    expect(decideVolumeResize({
      resizeFamily: 'quota_online',
      currentSizeBytes: 10n,
      desiredSizeBytes: 20n,
      usedBytes: 9n,
      attached: true,
      allConsumersStopped: false,
    })).toEqual({ action: 'grow' });
    expect(decideVolumeResize({
      resizeFamily: 'quota_online',
      currentSizeBytes: 20n,
      desiredSizeBytes: 8n,
      usedBytes: 9n,
      attached: false,
      allConsumersStopped: true,
    })).toEqual({ action: 'blocked', reason: 'usage_floor' });
  });

  it('requires detach and stop preconditions for block-backed shrink', () => {
    const base = {
      resizeFamily: 'block_backed' as const,
      currentSizeBytes: 20n,
      desiredSizeBytes: 10n,
      usedBytes: 5n,
    };
    expect(decideVolumeResize({
      ...base,
      attached: true,
      allConsumersStopped: true,
    })).toEqual({ action: 'blocked', reason: 'detach' });
    expect(decideVolumeResize({
      ...base,
      attached: false,
      allConsumersStopped: false,
    })).toEqual({ action: 'blocked', reason: 'stop' });
    expect(decideVolumeResize({
      ...base,
      attached: false,
      allConsumersStopped: true,
    })).toEqual({ action: 'shrink' });
  });

  it('charges shared volume capacity to the shared backend', () => {
    expect(capacityScope({
      server_id: null,
      shared_backend_id: 'shared-backend',
    })).toEqual({ kind: 'shared_backend', id: 'shared-backend' });
    expect(capacityScope({
      server_id: 'server',
      shared_backend_id: null,
    })).toEqual({ kind: 'server', id: 'server' });
  });
});

describe('volume reconciler scan and shifted policy', () => {
  const serverId = '33333333-3333-4333-8333-333333333333';
  const volumeId = '11111111-1111-4111-8111-111111111111';

  it('enqueues create/ensure_attachment for desired_present rows and skips needs_attention', async () => {
    const attentionId = '22222222-2222-4222-8222-222222222222';
    const ensurePending = vi.fn().mockResolvedValue({ id: 'intent' });
    const reconciler = new VolumeReconciler(selectDb({
      volumes: [
        localVolume({ id: volumeId, serverId, incusName: `nyv-${'a'.repeat(32)}` }),
        localVolume({
          id: attentionId,
          serverId,
          incusName: `nyv-${'b'.repeat(32)}`,
          needs_attention: true,
        }),
      ],
      pools: [{ id: 'pool-1', incus_name: 'default', shared_backend_id: null, server_id: serverId }],
      placements: [
        { volume_id: volumeId, server_id: serverId, desired_present: true, pool_id: 'pool-1' },
        { volume_id: attentionId, server_id: serverId, desired_present: true, pool_id: 'pool-1' },
      ],
    }) as never, { ensurePending } as never);
    const client = {
      listStorageVolumes: vi.fn().mockResolvedValue({ metadata: [] }),
      deleteStorageVolume: vi.fn(),
    };

    await reconciler.scan(serverId, client as never, new AbortController().signal);

    expect(ensurePending).toHaveBeenCalledTimes(1);
    expect(ensurePending).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: volumeId,
      serverId,
      reuseSettled: false,
      request: expect.objectContaining({
        source: 'full_scan',
        idempotencyKey: 'create',
      }),
    }));
  });

  it('does not Incus-DELETE a live logical nyv-* extra and does not drop deleting home placements', async () => {
    const knownName = `nyv-${'c'.repeat(32)}`;
    const orphanName = `nyv-${'d'.repeat(32)}`;
    const deletingId = '44444444-4444-4444-8444-444444444444';
    const deletingName = `nyv-${'e'.repeat(32)}`;
    const ensurePending = vi.fn().mockResolvedValue({ id: 'intent' });
    const db = selectDb({
      volumes: [
        localVolume({ id: volumeId, serverId, incusName: knownName }),
        localVolume({
          id: deletingId,
          serverId,
          incusName: deletingName,
          lifecycle_phase: 'deleting',
        }),
      ],
      pools: [{ id: 'pool-1', incus_name: 'default', shared_backend_id: null, server_id: serverId }],
      placements: [
        { volume_id: volumeId, server_id: serverId, desired_present: true, pool_id: 'pool-1' },
        { volume_id: deletingId, server_id: serverId, desired_present: false, pool_id: 'pool-1' },
      ],
    });
    const reconciler = new VolumeReconciler(db as never, { ensurePending } as never);
    const client = {
      listStorageVolumes: vi.fn().mockResolvedValue({
        metadata: [
          { name: knownName, type: 'custom' },
          { name: orphanName, type: 'custom' },
          { name: deletingName, type: 'custom' },
          { name: 'operator-volume', type: 'custom' },
        ],
      }),
      deleteStorageVolume: vi.fn().mockResolvedValue({
        status: 200,
        envelope: { type: 'sync' },
      }),
      getStorageVolume: vi.fn(async (_pool: string, _type: string, name: string) => {
        if (name === orphanName) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure');
        return { metadata: { name } };
      }),
    };

    await reconciler.scan(serverId, client as never, new AbortController().signal);

    expect(client.deleteStorageVolume).toHaveBeenCalledWith(
      'default',
      'custom',
      orphanName,
      expect.anything(),
    );
    expect(client.deleteStorageVolume).not.toHaveBeenCalledWith(
      'default',
      'custom',
      knownName,
      expect.anything(),
    );
    expect(client.deleteStorageVolume).not.toHaveBeenCalledWith(
      'default',
      'custom',
      deletingName,
      expect.anything(),
    );
    expect(ensurePending).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: deletingId,
      request: expect.objectContaining({ idempotencyKey: 'delete' }),
    }));
    expect(db.deleteFrom).not.toHaveBeenCalled();
  });

  it('enqueues size/shifted drift only for desired_present=true placements', async () => {
    const cacheId = '55555555-5555-4555-8555-555555555555';
    const ensurePending = vi.fn().mockResolvedValue({ id: 'intent' });
    const listedName = `nyv-${'a'.repeat(32)}`;
    const cacheName = `nyv-${'b'.repeat(32)}`;
    const reconciler = new VolumeReconciler(selectDb({
      volumes: [
        localVolume({ id: volumeId, serverId, incusName: listedName, size_bytes: 20 }),
        localVolume({ id: cacheId, serverId, incusName: cacheName, size_bytes: 20 }),
      ],
      pools: [{ id: 'pool-1', incus_name: 'default', shared_backend_id: null, server_id: serverId }],
      placements: [
        { volume_id: volumeId, server_id: serverId, desired_present: true, pool_id: 'pool-1' },
        { volume_id: cacheId, server_id: serverId, desired_present: false, pool_id: 'pool-1' },
      ],
    }) as never, { ensurePending } as never);

    await reconciler.scan(serverId, {
      listStorageVolumes: vi.fn().mockResolvedValue({
        metadata: [
          { name: listedName, config: { size: '10', 'security.shifted': 'true' } },
          { name: cacheName, config: { size: '10', 'security.shifted': 'false' } },
        ],
      }),
      deleteStorageVolume: vi.fn(),
    } as never, new AbortController().signal);

    expect(ensurePending).toHaveBeenCalledTimes(1);
    expect(ensurePending).toHaveBeenCalledWith(expect.objectContaining({ resourceId: volumeId }));
  });

  it('fails closed when an in-use volume is missing security.shifted', async () => {
    const reconciler = new VolumeReconciler(volumeExistsDb() as never);
    vi.spyOn(
      reconciler as unknown as { readVolume: () => Promise<unknown> },
      'readVolume',
    ).mockResolvedValue({
      id: volumeId,
      pool_name: 'default',
      placement_pool_name: 'default',
      incus_name: `nyv-${'e'.repeat(32)}`,
      size_bytes: '10',
      generation: 2,
      lifecycle_phase: 'active',
      desired_present: true,
      resize_family: 'quota_online',
      driver: 'dir',
      target_server_id: serverId,
      pool_server_id: serverId,
    });
    vi.spyOn(
      reconciler as unknown as { readAttachments: () => Promise<unknown> },
      'readAttachments',
    ).mockResolvedValue([{
      id: 'att-1',
      container_id: 'ctr-1',
      detach_drained_at: null,
      power_intent: 'running',
    }]);
    const updateStorageVolume = vi.fn();
    const outcome = await reconciler.reconcile({
      intent: {
        id: 'intent-1',
        kind: 'volume.ensure',
        resourceType: 'volume',
        resourceId: volumeId,
        serverId,
        request: {},
      } as never,
      client: {
        getStorageVolume: vi.fn().mockResolvedValue({
          metadata: {
            config: { size: '10', 'security.shifted': 'false' },
            content_type: 'filesystem',
          },
        }),
        getStorageVolumeState: vi.fn().mockResolvedValue({
          metadata: { usage: {} },
        }),
        updateStorageVolume,
      } as never,
      claim: {} as never,
      lease: {} as never,
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      outcome: 'failed',
      failure: { code: 'VOLUME_SECURITY_SHIFTED_MISMATCH' },
    });
    expect(updateStorageVolume).not.toHaveBeenCalled();
  });

  it('drops a placement after GET 404 on delete and does not assume the logical row is gone', async () => {
    const drop = vi.fn().mockResolvedValue(undefined);
    const reconciler = new VolumeReconciler(volumeExistsDb({ lifecycle_phase: 'deleting' }) as never);
    vi.spyOn(
      reconciler as unknown as { readVolume: () => Promise<unknown> },
      'readVolume',
    ).mockResolvedValue({
      id: volumeId,
      pool_name: 'default',
      placement_pool_name: 'default',
      incus_name: `nyv-${'f'.repeat(32)}`,
      size_bytes: '10',
      generation: 3,
      lifecycle_phase: 'deleting',
      desired_present: false,
      resize_family: 'block_backed',
      driver: 'lvm',
      target_server_id: serverId,
      pool_server_id: serverId,
      unused_confirmed_at: null,
    });
    vi.spyOn(
      reconciler as unknown as { readAttachments: () => Promise<unknown[]> },
      'readAttachments',
    ).mockResolvedValue([]);
    vi.spyOn(
      reconciler as unknown as { dropPlacementAndMaybeVolume: () => Promise<void> },
      'dropPlacementAndMaybeVolume',
    ).mockImplementation(drop);
    vi.spyOn(
      reconciler as unknown as { listPlacementPeers: () => Promise<unknown[]> },
      'listPlacementPeers',
    ).mockResolvedValue([{
      server_id: serverId,
      pool_id: 'pool-1',
      unused_confirmed_at: new Date(),
    }]);

    const outcome = await reconciler.reconcile({
      intent: {
        id: 'delete-intent',
        kind: 'volume.ensure',
        resourceType: 'volume',
        resourceId: volumeId,
        serverId,
        request: { operation: 'delete' },
      } as never,
      client: {
        getStorageVolume: vi.fn().mockRejectedValue(
          new IncusError('INCUS_NOT_FOUND', 'managed_failure'),
        ),
      } as never,
      claim: {} as never,
      lease: {} as never,
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      outcome: 'succeeded',
      observedGeneration: 3,
    });
    expect(drop).toHaveBeenCalledWith(volumeId, serverId);
  });

  it('fails adopt on the 8th GET 404 and retries earlier attempts', async () => {
    const reconciler = new VolumeReconciler(volumeExistsDb() as never);
    vi.spyOn(
      reconciler as unknown as { readVolume: () => Promise<unknown> },
      'readVolume',
    ).mockResolvedValue({
      id: volumeId,
      placement_pool_name: 'cephfs-b',
      incus_name: `nyv-${'a'.repeat(32)}`,
      size_bytes: '10',
      generation: 1,
      lifecycle_phase: 'active',
      desired_present: true,
      shared_backend_id: 'backend',
      target_server_id: serverId,
      pool_server_id: 'home-server',
    });
    vi.spyOn(
      reconciler as unknown as { readAttachments: () => Promise<unknown[]> },
      'readAttachments',
    ).mockResolvedValue([]);
    const notFound = new IncusError('INCUS_NOT_FOUND', 'managed_failure');
    const exists = new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
      status: 400,
      error: 'Already exists',
    });

    const retry = await reconciler.reconcile(adoptContext(7, notFound, exists));
    expect(retry).toMatchObject({
      outcome: 'retry',
      failure: { code: 'VOLUME_CATALOG_ADOPT_PENDING' },
    });
    const failed = await reconciler.reconcile(adoptContext(8, notFound, exists));
    expect(failed).toMatchObject({
      outcome: 'failed',
      failure: { code: 'VOLUME_CATALOG_ADOPT_FAILED' },
    });
  });

  it('uses the home placement pool name when a non-home delete GETs home 404', async () => {
    const homeServer = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const homeGet = vi.fn().mockRejectedValue(new IncusError('INCUS_NOT_FOUND', 'managed_failure'));
    const localDelete = vi.fn().mockResolvedValue({ status: 200, envelope: { type: 'sync' } });
    const reconciler = new VolumeReconciler(volumeExistsDb({ lifecycle_phase: 'deleting' }) as never, undefined, undefined, {
      get: vi.fn(async (id: string) => {
        expect(id).toBe(homeServer);
        return { getStorageVolume: homeGet };
      }),
    } as never);
    vi.spyOn(
      reconciler as unknown as { readVolume: () => Promise<unknown> },
      'readVolume',
    ).mockResolvedValue({
      id: volumeId,
      pool_id: 'home-pool',
      pool_server_id: homeServer,
      placement_pool_name: 'cephfs-b',
      incus_name: `nyv-${'a'.repeat(32)}`,
      size_bytes: '10',
      generation: 2,
      lifecycle_phase: 'deleting',
      desired_present: false,
      shared_backend_id: 'backend',
      target_server_id: serverId,
      unused_confirmed_at: new Date(),
    });
    vi.spyOn(
      reconciler as unknown as { readAttachments: () => Promise<unknown[]> },
      'readAttachments',
    ).mockResolvedValue([]);
    vi.spyOn(
      reconciler as unknown as { dropPlacementAndMaybeVolume: () => Promise<void> },
      'dropPlacementAndMaybeVolume',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      reconciler as unknown as { poolName: (id: string) => Promise<string> },
      'poolName',
    ).mockResolvedValue('cephfs-home');

    const outcome = await reconciler.reconcile({
      intent: {
        id: 'delete-b',
        kind: 'volume.ensure',
        resourceType: 'volume',
        resourceId: volumeId,
        serverId,
        request: { operation: 'delete' },
        attemptCount: 0,
      } as never,
      client: {
        getStorageVolume: vi.fn().mockRejectedValue(new IncusError('INCUS_NOT_FOUND', 'managed_failure')),
        deleteStorageVolume: localDelete,
      } as never,
      claim: {} as never,
      lease: {} as never,
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({ outcome: 'succeeded' });
    expect(homeGet).toHaveBeenCalledWith('cephfs-home', 'custom', `nyv-${'a'.repeat(32)}`);
    expect(localDelete).not.toHaveBeenCalled();
  });

  it('does not RemoveAll home while the detach drain window is open', async () => {
    const deleteStorageVolume = vi.fn();
    const drainedAt = new Date(Date.now() + 60_000);
    const reconciler = new VolumeReconciler(volumeExistsDb({
      lifecycle_phase: 'deleting',
      drain: { drained_at: drainedAt },
    }) as never);
    vi.spyOn(
      reconciler as unknown as { readVolume: () => Promise<unknown> },
      'readVolume',
    ).mockResolvedValue({
      id: volumeId,
      placement_pool_name: 'default',
      incus_name: `nyv-${'a'.repeat(32)}`,
      size_bytes: '10',
      generation: 2,
      lifecycle_phase: 'deleting',
      desired_present: false,
      target_server_id: serverId,
      pool_server_id: serverId,
    });
    vi.spyOn(
      reconciler as unknown as { readAttachments: () => Promise<unknown[]> },
      'readAttachments',
    ).mockResolvedValue([]);
    const outcome = await reconciler.reconcile({
      intent: {
        id: 'delete-drain',
        kind: 'volume.ensure',
        resourceType: 'volume',
        resourceId: volumeId,
        serverId,
        request: { operation: 'delete' },
      } as never,
      client: {
        getStorageVolume: vi.fn().mockResolvedValue({ metadata: { used_by: [] } }),
        deleteStorageVolume,
      } as never,
      claim: {} as never,
      lease: {} as never,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      outcome: 'retry',
      failure: { code: 'VOLUME_DETACH_DRAINING' },
    });
    expect(deleteStorageVolume).not.toHaveBeenCalled();
  });

  it('does not RemoveAll home while a non-home catalog still reports used_by', async () => {
    const peerServer = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const deleteStorageVolume = vi.fn();
    const reconciler = new VolumeReconciler(volumeExistsDb({ lifecycle_phase: 'deleting' }) as never, undefined, undefined, {
      get: vi.fn(async (id: string) => {
        expect(id).toBe(peerServer);
        return {
          getStorageVolume: vi.fn().mockResolvedValue({
            metadata: { used_by: ['/1.0/instances/x'] },
          }),
        };
      }),
    } as never);
    vi.spyOn(
      reconciler as unknown as { readVolume: () => Promise<unknown> },
      'readVolume',
    ).mockResolvedValue({
      id: volumeId,
      placement_pool_name: 'cephfs-home',
      incus_name: `nyv-${'a'.repeat(32)}`,
      size_bytes: '10',
      generation: 2,
      lifecycle_phase: 'deleting',
      desired_present: false,
      shared_backend_id: 'backend',
      target_server_id: serverId,
      pool_server_id: serverId,
    });
    vi.spyOn(
      reconciler as unknown as { readAttachments: () => Promise<unknown[]> },
      'readAttachments',
    ).mockResolvedValue([]);
    vi.spyOn(
      reconciler as unknown as { listPlacementPeers: () => Promise<unknown[]> },
      'listPlacementPeers',
    ).mockResolvedValue([
      { server_id: serverId, pool_id: 'home-pool', unused_confirmed_at: new Date() },
      { server_id: peerServer, pool_id: 'peer-pool', unused_confirmed_at: new Date() },
    ]);
    vi.spyOn(
      reconciler as unknown as { poolName: (id: string) => Promise<string> },
      'poolName',
    ).mockResolvedValue('cephfs-peer');
    const outcome = await reconciler.reconcile({
      intent: {
        id: 'delete-home',
        kind: 'volume.ensure',
        resourceType: 'volume',
        resourceId: volumeId,
        serverId,
        request: { operation: 'delete' },
      } as never,
      client: {
        getStorageVolume: vi.fn().mockResolvedValue({ metadata: { used_by: [] } }),
        deleteStorageVolume,
      } as never,
      claim: {} as never,
      lease: {} as never,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      outcome: 'retry',
      failure: { code: 'VOLUME_REQUIRES_DETACH' },
    });
    expect(deleteStorageVolume).not.toHaveBeenCalled();
  });
});

function adoptContext(attemptCount: number, getError: IncusError, postError: IncusError) {
  return {
    intent: {
      id: 'adopt',
      kind: 'volume.ensure',
      resourceType: 'volume',
      resourceId: '11111111-1111-4111-8111-111111111111',
      serverId: '33333333-3333-4333-8333-333333333333',
      request: { operation: 'ensure_attachment' },
      attemptCount,
    },
    client: {
      getStorageVolume: vi.fn().mockRejectedValue(getError),
      createStorageVolume: vi.fn().mockRejectedValue(postError),
    },
    claim: {},
    lease: {},
    signal: new AbortController().signal,
  } as never;
}

function localVolume(input: {
  id: string;
  serverId: string;
  incusName: string;
  needs_attention?: boolean;
  lifecycle_phase?: string;
  size_bytes?: number;
}) {
  return {
    id: input.id,
    generation: 2,
    server_id: input.serverId,
    shared_backend_id: null,
    lifecycle_phase: input.lifecycle_phase ?? 'active',
    needs_attention: input.needs_attention ?? false,
    incus_name: input.incusName,
    size_bytes: input.size_bytes ?? 10,
    pool_id: 'pool-1',
    home_server_id: input.serverId,
  };
}

function volumeExistsDb(row: { lifecycle_phase?: string; drain?: { drained_at: Date } } = {}) {
  return {
    selectFrom: vi.fn((table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'where', 'innerJoin', 'selectAll']) {
        query[method] = vi.fn(() => query);
      }
      query.executeTakeFirst = vi.fn().mockResolvedValue(
        String(table).startsWith('control.volumes')
          ? {
            id: '11111111-1111-4111-8111-111111111111',
            lifecycle_phase: row.lifecycle_phase ?? 'active',
          }
          : String(table).startsWith('control.volume_detach_drains')
            ? row.drain ?? undefined
            : undefined,
      );
      query.execute = vi.fn().mockResolvedValue([]);
      query.set = vi.fn(() => query);
      return query;
    }),
    updateTable: vi.fn(() => {
      const query: Record<string, unknown> = {};
      query.set = vi.fn(() => query);
      query.where = vi.fn(() => query);
      query.execute = vi.fn().mockResolvedValue(undefined);
      return query;
    }),
    transaction: vi.fn(() => ({
      execute: vi.fn(async (work: (trx: unknown) => Promise<unknown>) => work({
        selectFrom: vi.fn(() => {
          const query: Record<string, unknown> = {};
          query.select = vi.fn(() => query);
          query.where = vi.fn(() => query);
          query.forUpdate = vi.fn(() => query);
          query.executeTakeFirst = vi.fn().mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111111',
            lifecycle_phase: row.lifecycle_phase ?? 'active',
          });
          return query;
        }),
        deleteFrom: vi.fn(() => {
          const query: Record<string, unknown> = {};
          query.where = vi.fn(() => query);
          query.execute = vi.fn().mockResolvedValue(undefined);
          query.executeTakeFirst = vi.fn().mockResolvedValue(undefined);
          return query;
        }),
      })),
    })),
  };
}

function selectDb(input: {
  volumes: readonly Record<string, unknown>[];
  pools: readonly Record<string, unknown>[];
  placements?: readonly Record<string, unknown>[];
}) {
  return {
    selectFrom: vi.fn((table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'where', 'innerJoin', 'selectAll']) {
        query[method] = vi.fn(() => query);
      }
      query.execute = vi.fn(async () => {
        if (String(table).startsWith('control.volumes')) return input.volumes;
        if (String(table).startsWith('control.volume_placements')) return input.placements ?? [];
        if (String(table).startsWith('control.volume_attachments')) return [];
        return input.pools;
      });
      query.executeTakeFirst = vi.fn().mockResolvedValue(undefined);
      query.set = vi.fn(() => query);
      return query;
    }),
    insertInto: vi.fn(() => {
      const query: Record<string, unknown> = {};
      for (const method of ['values', 'onConflict']) {
        query[method] = vi.fn(() => query);
      }
      query.execute = vi.fn().mockResolvedValue(undefined);
      return query;
    }),
    updateTable: vi.fn(() => {
      const query: Record<string, unknown> = {};
      query.set = vi.fn(() => query);
      query.where = vi.fn(() => query);
      query.execute = vi.fn().mockResolvedValue(undefined);
      return query;
    }),
    deleteFrom: vi.fn(() => {
      const query: Record<string, unknown> = {};
      query.where = vi.fn(() => query);
      query.execute = vi.fn().mockResolvedValue(undefined);
      return query;
    }),
  };
}

