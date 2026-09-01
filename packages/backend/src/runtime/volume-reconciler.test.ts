import { describe, expect, it, vi } from 'vitest';
import { IncusError } from '../incus/index.js';
import type { ReconcileRunContext } from './reconcile-worker.service.js';
import {
  capacityScope,
  decideVolumeResize,
  normalizeObservedVolumeUsage,
  VolumeReconciler,
} from './volume-reconciler.service.js';

const serverId = '33333333-3333-4333-8333-333333333333';
const volumeId = '11111111-1111-4111-8111-111111111111';
const serverA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const serverB = '11111111-1111-4111-8111-111111111111';
const incusName = `nyv-${'a'.repeat(32)}`;

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
  it('enqueues create for ensuring catalogs and ensure_attachment for present catalogs', async () => {
    const presentId = '22222222-2222-4222-8222-222222222222';
    const ensurePending = vi.fn().mockResolvedValue({ id: 'intent' });
    const db = selectDb({
      volumes: [
        localVolume({ id: volumeId, serverId, incusName: `nyv-${'a'.repeat(32)}` }),
        localVolume({ id: presentId, serverId, incusName: `nyv-${'b'.repeat(32)}` }),
      ],
      pools: [localPool(serverId)],
      placements: [
        { volume_id: volumeId, server_id: serverId, catalog_state: 'ensuring', pool_id: 'pool-1' },
        { volume_id: presentId, server_id: serverId, catalog_state: 'present', pool_id: 'pool-1' },
      ],
    });
    const reconciler = new VolumeReconciler(db as never, { ensurePending } as never);
    const client = {
      listStorageVolumes: vi.fn().mockResolvedValue({ metadata: [] }),
      deleteStorageVolume: vi.fn(),
    };

    await reconciler.scan(serverId, client as never, new AbortController().signal);

    expect(ensurePending).toHaveBeenCalledTimes(2);
    expect(ensurePending).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: volumeId,
      serverId,
      kind: 'volume.ensure',
      request: expect.objectContaining({ idempotencyKey: 'create' }),
    }));
    expect(ensurePending).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: presentId,
      kind: 'volume.ensure',
      request: expect.objectContaining({ idempotencyKey: 'ensure_attachment' }),
    }));
    expect(db.insertInto).not.toHaveBeenCalled();
  });

  it('does not Incus-DELETE a live logical nyv-* and enqueues volume.destroy for deleting volumes', async () => {
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
      pools: [localPool(serverId)],
      placements: [
        { volume_id: volumeId, server_id: serverId, catalog_state: 'present', pool_id: 'pool-1' },
        { volume_id: deletingId, server_id: serverId, catalog_state: 'present', pool_id: 'pool-1' },
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
      kind: 'volume.destroy',
      resourceId: deletingId,
      request: expect.objectContaining({ idempotencyKey: 'destroy' }),
    }));
    expect(ensurePending).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'volume.ensure',
      resourceId: deletingId,
    }));
    expect(db.deleteFrom).not.toHaveBeenCalled();
    expect(db.insertInto).not.toHaveBeenCalled();
  });

  it('does not upsert a placement when the backend is visible but no catalog row exists', async () => {
    const backendId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const ensurePending = vi.fn().mockResolvedValue({ id: 'intent' });
    const listedName = `nyv-${'a'.repeat(32)}`;
    const db = selectDb({
      volumes: [{
        id: volumeId,
        generation: 2,
        server_id: null,
        shared_backend_id: backendId,
        lifecycle_phase: 'active',
        needs_attention: false,
        incus_name: listedName,
        size_bytes: 10,
        pool_id: 'pool-home',
      }],
      pools: [{
        id: 'pool-s',
        incus_name: 'cephfs',
        shared_backend_id: backendId,
        server_id: serverId,
        registered: true,
        driver: 'cephfs',
        shareable: true,
      }],
      placements: [],
    });
    const deleteStorageVolume = vi.fn();
    const reconciler = new VolumeReconciler(db as never, { ensurePending } as never);

    await reconciler.scan(serverId, {
      listStorageVolumes: vi.fn().mockResolvedValue({
        metadata: [{ name: listedName, type: 'custom' }],
      }),
      deleteStorageVolume,
    } as never, new AbortController().signal);

    expect(db.insertInto).not.toHaveBeenCalled();
    expect(ensurePending).not.toHaveBeenCalled();
    expect(deleteStorageVolume).not.toHaveBeenCalled();
  });

  it('does not orphan-delete nyv-* when the logical volume has pool_id null', async () => {
    const backendId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const listedName = `nyv-${'c'.repeat(32)}`;
    const ensurePending = vi.fn().mockResolvedValue({ id: 'intent' });
    const db = selectDb({
      volumes: [{
        id: volumeId,
        generation: 2,
        server_id: null,
        shared_backend_id: backendId,
        lifecycle_phase: 'active',
        needs_attention: false,
        incus_name: listedName,
        size_bytes: 10,
        pool_id: null,
      }],
      pools: [{
        id: 'pool-t',
        incus_name: 'cephfs',
        shared_backend_id: backendId,
        server_id: serverId,
        registered: true,
        driver: 'cephfs',
        shareable: true,
      }],
      placements: [
        { volume_id: volumeId, server_id: serverId, catalog_state: 'present', pool_id: 'pool-t' },
      ],
    });
    const deleteStorageVolume = vi.fn();
    const reconciler = new VolumeReconciler(db as never, { ensurePending } as never);

    await reconciler.scan(serverId, {
      listStorageVolumes: vi.fn().mockResolvedValue({
        metadata: [{ name: listedName, config: { size: '10', 'security.shifted': 'true' } }],
      }),
      deleteStorageVolume,
    } as never, new AbortController().signal);

    expect(deleteStorageVolume).not.toHaveBeenCalled();
    expect(db.insertInto).not.toHaveBeenCalled();
  });

  it('does not spread catalogs for failed volumes without a placement', async () => {
    const backendId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const ensurePending = vi.fn().mockResolvedValue({ id: 'intent' });
    const db = selectDb({
      volumes: [{
        id: volumeId,
        generation: 2,
        server_id: null,
        shared_backend_id: backendId,
        lifecycle_phase: 'failed',
        needs_attention: true,
        incus_name: incusName,
        size_bytes: 10,
        pool_id: 'pool-home',
      }],
      pools: [{
        id: 'pool-s',
        incus_name: 'cephfs',
        shared_backend_id: backendId,
        server_id: serverId,
        registered: true,
        driver: 'cephfs',
        shareable: true,
      }],
      placements: [],
    });
    const reconciler = new VolumeReconciler(db as never, { ensurePending } as never);

    await reconciler.scan(serverId, {
      listStorageVolumes: vi.fn().mockResolvedValue({ metadata: [] }),
      deleteStorageVolume: vi.fn(),
    } as never, new AbortController().signal);

    expect(ensurePending).not.toHaveBeenCalled();
    expect(db.insertInto).not.toHaveBeenCalled();
  });

  it('enqueues size/shifted drift for existing placements', async () => {
    const alignedId = '55555555-5555-4555-8555-555555555555';
    const ensurePending = vi.fn().mockResolvedValue({ id: 'intent' });
    const listedName = `nyv-${'a'.repeat(32)}`;
    const alignedName = `nyv-${'b'.repeat(32)}`;
    const reconciler = new VolumeReconciler(selectDb({
      volumes: [
        localVolume({ id: volumeId, serverId, incusName: listedName, size_bytes: 20 }),
        localVolume({ id: alignedId, serverId, incusName: alignedName, size_bytes: 10 }),
      ],
      pools: [localPool(serverId)],
      placements: [
        { volume_id: volumeId, server_id: serverId, catalog_state: 'present', pool_id: 'pool-1' },
        { volume_id: alignedId, server_id: serverId, catalog_state: 'present', pool_id: 'pool-1' },
      ],
    }) as never, { ensurePending } as never);

    await reconciler.scan(serverId, {
      listStorageVolumes: vi.fn().mockResolvedValue({
        metadata: [
          { name: listedName, config: { size: '10', 'security.shifted': 'true' } },
          { name: alignedName, config: { size: '10', 'security.shifted': 'true' } },
        ],
      }),
      deleteStorageVolume: vi.fn(),
    } as never, new AbortController().signal);

    expect(ensurePending).toHaveBeenCalledTimes(1);
    expect(ensurePending).toHaveBeenCalledWith(expect.objectContaining({ resourceId: volumeId }));
  });

  it('writes used_bytes from GET /state without enqueueing volume.ensure', async () => {
    const backendId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const listedName = `nyv-${'a'.repeat(32)}`;
    const ensurePending = vi.fn();
    const db = selectDb({
      volumes: [{
        id: volumeId,
        generation: 2,
        server_id: null,
        shared_backend_id: backendId,
        lifecycle_phase: 'active',
        needs_attention: false,
        incus_name: listedName,
        size_bytes: 10,
        pool_id: null,
      }],
      pools: [{
        id: 'pool-t',
        incus_name: 'cephfs',
        shared_backend_id: backendId,
        server_id: serverId,
        registered: true,
        driver: 'cephfs',
        shareable: true,
      }],
      placements: [
        { volume_id: volumeId, server_id: serverId, catalog_state: 'present', pool_id: 'pool-t' },
      ],
    });
    const reconciler = new VolumeReconciler(db as never, { ensurePending } as never);
    await reconciler.scan(serverId, {
      listStorageVolumes: vi.fn().mockResolvedValue({
        metadata: [{ name: listedName, config: { size: '10', 'security.shifted': 'true' } }],
      }),
      getStorageVolumeState: vi.fn().mockResolvedValue({
        metadata: { usage: { used: '4', total: '10' } },
      }),
      deleteStorageVolume: vi.fn(),
    } as never, new AbortController().signal);
    expect(ensurePending).not.toHaveBeenCalled();
    expect(db.updateTable).toHaveBeenCalled();
  });

  it('does not POST a shared 404 placement', async () => {
    const backendId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const listedName = `nyv-${'a'.repeat(32)}`;
    const ensurePending = vi.fn();
    const createStorageVolume = vi.fn();
    const reconciler = new VolumeReconciler(selectDb({
      volumes: [{
        id: volumeId,
        generation: 2,
        server_id: null,
        shared_backend_id: backendId,
        lifecycle_phase: 'active',
        needs_attention: false,
        incus_name: listedName,
        size_bytes: 10,
        pool_id: null,
      }],
      pools: [{
        id: 'pool-t',
        incus_name: 'cephfs',
        shared_backend_id: backendId,
        server_id: serverId,
        registered: true,
        driver: 'cephfs',
        shareable: true,
      }],
      placements: [
        { volume_id: volumeId, server_id: serverId, catalog_state: 'ensuring', pool_id: 'pool-t' },
      ],
    }) as never, { ensurePending } as never);
    await reconciler.scan(serverId, {
      listStorageVolumes: vi.fn().mockResolvedValue({ metadata: [] }),
      createStorageVolume,
      deleteStorageVolume: vi.fn(),
    } as never, new AbortController().signal);
    expect(createStorageVolume).not.toHaveBeenCalled();
    expect(ensurePending).not.toHaveBeenCalled();
  });

  it('fails closed when an in-use volume is missing security.shifted', async () => {
    const reconciler = new VolumeReconciler(volumeExistsDb() as never);
    vi.spyOn(
      reconciler as unknown as { readVolume: () => Promise<unknown> },
      'readVolume',
    ).mockResolvedValue(ensureRow());
    vi.spyOn(
      reconciler as unknown as { readAttachments: () => Promise<unknown> },
      'readAttachments',
    ).mockResolvedValue([{
      id: 'att-1',
      container_id: 'ctr-1',
      power_intent: 'running',
    }]);
    const updateStorageVolume = vi.fn();
    const outcome = await reconciler.reconcile(runContext({
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
      },
    }));

    expect(outcome).toMatchObject({
      outcome: 'failed',
      failure: { code: 'VOLUME_SECURITY_SHIFTED_MISMATCH' },
    });
    expect(updateStorageVolume).not.toHaveBeenCalled();
  });

  it('fails adopt on the 8th GET 404 and retries earlier attempts', async () => {
    const reconciler = new VolumeReconciler(volumeExistsDb() as never);
    vi.spyOn(
      reconciler as unknown as { readVolume: () => Promise<unknown> },
      'readVolume',
    ).mockResolvedValue({
      ...ensureRow(),
      shared_backend_id: 'backend',
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

  it('retries volume.ensure on a deleting volume with zero deleteStorageVolume', async () => {
    const deleteStorageVolume = vi.fn();
    const getStorageVolume = vi.fn();
    const reconciler = new VolumeReconciler(volumeExistsDb({ lifecycle_phase: 'deleting' }) as never);
    const outcome = await reconciler.reconcile(runContext({
      kind: 'volume.ensure',
      client: { getStorageVolume, deleteStorageVolume },
    }));
    expect(outcome).toMatchObject({
      outcome: 'retry',
      failure: { code: 'VOLUME_DESTROY_PENDING' },
    });
    expect(deleteStorageVolume).not.toHaveBeenCalled();
    expect(getStorageVolume).not.toHaveBeenCalled();
  });
});

describe('volume.destroy eligible-node D', () => {
  it('pins the GET 200 tracking member instead of a 404 eligible node', async () => {
    const present = new Set([serverA]);
    const clientA = catalogClient(serverA, present);
    const clientB = catalogClient(serverB, present);
    const state = destroyState({
      dirEnsured: false,
      catalogs: [
        catalog(serverB, 'cephfs-b', 'ensuring'),
        catalog(serverA, 'cephfs-a', 'ensuring'),
      ],
      eligible: [
        { server_id: serverB, pool_name: 'cephfs-b' },
        { server_id: serverA, pool_name: 'cephfs-a' },
      ],
    });
    const reconciler = new VolumeReconciler(
      volumeExistsDb({ lifecycle_phase: 'deleting' }) as never,
      undefined,
      undefined,
      { get: vi.fn(async (id: string) => (id === serverA ? clientA : clientB)) } as never,
    );
    const spies = installDestroySpies(reconciler, state);

    const outcome = await reconciler.reconcile(destroyContext(spies.lease));

    expect(outcome).toMatchObject({ outcome: 'succeeded' });
    expect(clientA.deleteStorageVolume).toHaveBeenCalledTimes(1);
    expect(clientB.deleteStorageVolume).not.toHaveBeenCalled();
    expect(spies.pin).toHaveBeenCalledWith(volumeId, serverA);
    expect(spies.mark).toHaveBeenCalledWith(volumeId, serverA);
    expect(spies.dropAll).toHaveBeenCalledWith(volumeId);
    expect(spies.finish).toHaveBeenCalled();
    expect(spies.lease.assertOwned).toHaveBeenCalled();
  });

  it('retries the whole destroy with zero DELETE when one GET times out', async () => {
    const present = new Set([serverA]);
    const clientA = catalogClient(serverA, present);
    clientA.getStorageVolume.mockRejectedValue(new IncusError('INCUS_TIMEOUT', 'retry'));
    const clientB = catalogClient(serverB, present);
    const state = destroyState({
      catalogs: [
        catalog(serverB, 'cephfs-b', 'ensuring'),
        catalog(serverA, 'cephfs-a', 'present'),
      ],
    });
    const reconciler = new VolumeReconciler(
      volumeExistsDb({ lifecycle_phase: 'deleting' }) as never,
      undefined,
      undefined,
      { get: vi.fn(async (id: string) => (id === serverA ? clientA : clientB)) } as never,
    );
    const spies = installDestroySpies(reconciler, state);

    const outcome = await reconciler.reconcile(destroyContext());

    expect(outcome).toMatchObject({
      outcome: 'retry',
      failure: { code: 'VOLUME_DESTROY_RETRY' },
    });
    expect(clientA.deleteStorageVolume).not.toHaveBeenCalled();
    expect(clientB.deleteStorageVolume).not.toHaveBeenCalled();
    expect(spies.mark).not.toHaveBeenCalled();
    expect(spies.dropAll).not.toHaveBeenCalled();
    expect(spies.finish).not.toHaveBeenCalled();
  });

  it('sets remove_all_committed with no data DELETE when every online tracking member is 404', async () => {
    const present = new Set<string>();
    const clientA = catalogClient(serverA, present);
    const clientB = catalogClient(serverB, present);
    const state = destroyState({
      dirEnsured: false,
      catalogs: [
        catalog(serverB, 'cephfs-b', 'ensuring'),
        catalog(serverA, 'cephfs-a', 'ensuring'),
      ],
      eligible: [
        { server_id: serverB, pool_name: 'cephfs-b' },
        { server_id: serverA, pool_name: 'cephfs-a' },
      ],
    });
    const reconciler = new VolumeReconciler(
      volumeExistsDb({ lifecycle_phase: 'deleting' }) as never,
      undefined,
      undefined,
      { get: vi.fn(async (id: string) => (id === serverA ? clientA : clientB)) } as never,
    );
    const spies = installDestroySpies(reconciler, state);

    const outcome = await reconciler.reconcile(destroyContext());

    expect(outcome).toMatchObject({ outcome: 'succeeded' });
    expect(clientA.deleteStorageVolume).not.toHaveBeenCalled();
    expect(clientB.deleteStorageVolume).not.toHaveBeenCalled();
    expect(spies.mark).toHaveBeenCalledWith(volumeId, null);
    expect(spies.dropAll).toHaveBeenCalledWith(volumeId);
    expect(spies.finish).toHaveBeenCalled();
  });

  it('RemoveAll exactly once when two catalogs are GET 200 and drops all placements', async () => {
    const present = new Set([serverA, serverB]);
    const clientA = catalogClient(serverA, present);
    const clientB = catalogClient(serverB, present);
    const state = destroyState({
      dirEnsured: false,
      catalogs: [
        catalog(serverA, 'cephfs-a', 'present'),
        catalog(serverB, 'cephfs-b', 'present'),
      ],
      eligible: [
        { server_id: serverB, pool_name: 'cephfs-b' },
        { server_id: serverA, pool_name: 'cephfs-a' },
      ],
    });
    const reconciler = new VolumeReconciler(
      volumeExistsDb({ lifecycle_phase: 'deleting' }) as never,
      undefined,
      undefined,
      { get: vi.fn(async (id: string) => (id === serverA ? clientA : clientB)) } as never,
    );
    const spies = installDestroySpies(reconciler, state);

    const outcome = await reconciler.reconcile(destroyContext(spies.lease));

    expect(outcome).toMatchObject({ outcome: 'succeeded' });
    expect(clientB.deleteStorageVolume).toHaveBeenCalledTimes(1);
    expect(clientA.deleteStorageVolume).not.toHaveBeenCalled();
    expect(spies.mark).toHaveBeenCalledTimes(1);
    expect(spies.pin).toHaveBeenCalledWith(volumeId, serverB);
    expect(spies.dropAll).toHaveBeenCalledWith(volumeId);
    expect(spies.finish).toHaveBeenCalled();
  });

  it('skips RemoveAll after remove_all_committed and drops all placements', async () => {
    const present = new Set([serverA]);
    const clientA = catalogClient(serverA, present);
    const clientB = catalogClient(serverB, present);
    const state = destroyState({
      dirEnsured: true,
      removeAllCommitted: true,
      removeAllServerId: serverA,
      catalogs: [
        catalog(serverB, 'cephfs-b', 'ensuring'),
        catalog(serverA, 'cephfs-a', 'present'),
      ],
      eligible: [
        { server_id: serverA, pool_name: 'cephfs-a' },
        { server_id: serverB, pool_name: 'cephfs-b' },
      ],
    });
    const reconciler = new VolumeReconciler(
      volumeExistsDb({ lifecycle_phase: 'deleting' }) as never,
      undefined,
      undefined,
      { get: vi.fn(async (id: string) => (id === serverA ? clientA : clientB)) } as never,
    );
    const spies = installDestroySpies(reconciler, state);

    const outcome = await reconciler.reconcile(destroyContext());

    expect(outcome).toMatchObject({ outcome: 'succeeded' });
    expect(spies.mark).not.toHaveBeenCalled();
    expect(clientA.deleteStorageVolume).not.toHaveBeenCalled();
    expect(clientB.deleteStorageVolume).not.toHaveBeenCalled();
    expect(spies.dropAll).toHaveBeenCalledWith(volumeId);
  });

  it('succeeds without Incus when the volume row is already gone', async () => {
    const get = vi.fn();
    const reconciler = new VolumeReconciler(
      volumeExistsDb() as never,
      undefined,
      undefined,
      { get } as never,
    );
    vi.spyOn(
      reconciler as unknown as { readVolumeRow: () => Promise<undefined> },
      'readVolumeRow',
    ).mockResolvedValue(undefined);
    const outcome = await reconciler.reconcile(destroyContext());
    expect(outcome).toMatchObject({ outcome: 'succeeded' });
    expect(get).not.toHaveBeenCalled();
  });

  it('retries destroy when attachments remain and does not deleteStorageVolume', async () => {
    const deleteStorageVolume = vi.fn();
    const state = destroyState({
      attachments: true,
      catalogs: [catalog(serverA, 'cephfs-a', 'present')],
    });
    const reconciler = new VolumeReconciler(
      volumeExistsDb({ lifecycle_phase: 'deleting' }) as never,
      undefined,
      undefined,
      {
        get: vi.fn(async () => ({
          getStorageVolume: vi.fn(),
          deleteStorageVolume,
        })),
      } as never,
    );
    installDestroySpies(reconciler, state);
    const outcome = await reconciler.reconcile(destroyContext());
    expect(outcome).toMatchObject({
      outcome: 'retry',
      failure: { code: 'VOLUME_REQUIRES_UNBIND' },
    });
    expect(deleteStorageVolume).not.toHaveBeenCalled();
  });

  it('finishes empty tracking without requiring an Incus client', async () => {
    const get = vi.fn();
    const state = destroyState({ catalogs: [] });
    const reconciler = new VolumeReconciler(
      volumeExistsDb({ lifecycle_phase: 'deleting' }) as never,
      undefined,
      undefined,
      { get } as never,
    );
    const spies = installDestroySpies(reconciler, state);
    const outcome = await reconciler.reconcile(destroyContext());
    expect(outcome).toMatchObject({ outcome: 'succeeded' });
    expect(get).not.toHaveBeenCalled();
    expect(spies.finish).toHaveBeenCalled();
    expect(spies.mark).not.toHaveBeenCalled();
  });

  it('adopts on an eligible node that never had a catalog', async () => {
    const present = new Set<string>();
    const clientA = catalogClient(serverA, present);
    const clientB = catalogClient(serverB, present);
    const state = destroyState({
      dirEnsured: true,
      catalogs: [catalog(serverA, 'cephfs-a', 'present', 'unreachable')],
      eligible: [{ server_id: serverB, pool_name: 'cephfs-b' }],
    });
    const reconciler = new VolumeReconciler(
      volumeExistsDb({ lifecycle_phase: 'deleting' }) as never,
      undefined,
      undefined,
      { get: vi.fn(async (id: string) => (id === serverA ? clientA : clientB)) } as never,
    );
    const spies = installDestroySpies(reconciler, state);
    const outcome = await reconciler.reconcile(destroyContext(spies.lease));
    expect(outcome).toMatchObject({ outcome: 'succeeded' });
    expect(spies.pin).toHaveBeenCalledWith(volumeId, serverB);
    expect(clientB.createStorageVolume).toHaveBeenCalledTimes(1);
    expect(clientB.deleteStorageVolume).toHaveBeenCalledTimes(1);
    expect(clientA.deleteStorageVolume).not.toHaveBeenCalled();
    expect(spies.dropAll).toHaveBeenCalledWith(volumeId);
  });

  it('does not switch a live pin after GET error', async () => {
    const present = new Set([serverA]);
    const clientA = catalogClient(serverA, present);
    clientA.getStorageVolume.mockRejectedValue(new IncusError('INCUS_TIMEOUT', 'retry'));
    const clientB = catalogClient(serverB, present);
    const state = destroyState({
      dirEnsured: true,
      removeAllServerId: serverA,
      catalogs: [
        catalog(serverA, 'cephfs-a', 'present'),
        catalog(serverB, 'cephfs-b', 'present'),
      ],
      eligible: [
        { server_id: serverA, pool_name: 'cephfs-a' },
        { server_id: serverB, pool_name: 'cephfs-b' },
      ],
    });
    const reconciler = new VolumeReconciler(
      volumeExistsDb({ lifecycle_phase: 'deleting' }) as never,
      undefined,
      undefined,
      { get: vi.fn(async (id: string) => (id === serverA ? clientA : clientB)) } as never,
    );
    const spies = installDestroySpies(reconciler, state);
    const outcome = await reconciler.reconcile(destroyContext());
    expect(outcome).toMatchObject({
      outcome: 'retry',
      failure: { code: 'VOLUME_DESTROY_RETRY' },
    });
    expect(clientB.deleteStorageVolume).not.toHaveBeenCalled();
    expect(spies.mark).not.toHaveBeenCalled();
  });

  it('reselects after the pin is cascaded away while E is still nonempty', async () => {
    const present = new Set<string>();
    const clientB = catalogClient(serverB, present);
    const state = destroyState({
      dirEnsured: true,
      removeAllServerId: null,
      catalogs: [],
      eligible: [{ server_id: serverB, pool_name: 'cephfs-b' }],
    });
    const reconciler = new VolumeReconciler(
      volumeExistsDb({ lifecycle_phase: 'deleting' }) as never,
      undefined,
      undefined,
      { get: vi.fn(async () => clientB) } as never,
    );
    const spies = installDestroySpies(reconciler, state);
    const outcome = await reconciler.reconcile(destroyContext(spies.lease));
    expect(outcome).toMatchObject({ outcome: 'succeeded' });
    expect(spies.pin).toHaveBeenCalledWith(volumeId, serverB);
    expect(clientB.createStorageVolume).toHaveBeenCalledTimes(1);
    expect(clientB.deleteStorageVolume).toHaveBeenCalledTimes(1);
  });

  it('finishes with destroy_executor_gone when E is empty', async () => {
    const deleteStorageVolume = vi.fn();
    const state = destroyState({
      dirEnsured: true,
      catalogs: [catalog(serverA, 'cephfs-a', 'present', 'unreachable')],
      eligible: [],
    });
    const reconciler = new VolumeReconciler(
      volumeExistsDb({ lifecycle_phase: 'deleting' }) as never,
      undefined,
      undefined,
      { get: vi.fn(async () => ({ deleteStorageVolume })) } as never,
    );
    const spies = installDestroySpies(reconciler, state);
    const outcome = await reconciler.reconcile(destroyContext());
    expect(outcome).toMatchObject({ outcome: 'succeeded' });
    expect(deleteStorageVolume).not.toHaveBeenCalled();
    expect(spies.dropAll).toHaveBeenCalledWith(volumeId);
    expect(spies.finish).toHaveBeenCalledWith(volumeId, 'destroy_executor_gone');
  });
});

function catalog(
  id: string,
  poolName: string,
  catalogState: 'ensuring' | 'present',
  serverStatus: 'online' | 'unreachable' | 'unknown' = 'online',
) {
  return {
    server_id: id,
    pool_id: `pool-${id.slice(0, 4)}`,
    pool_name: poolName,
    catalog_state: catalogState,
    server_status: serverStatus,
  };
}

function catalogClient(id: string, present: Set<string>) {
  const getStorageVolume = vi.fn(async () => {
    if (!present.has(id)) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure');
    return { metadata: { name: incusName } };
  });
  const deleteStorageVolume = vi.fn(async () => {
    present.delete(id);
    return { status: 200, envelope: { type: 'sync' } };
  });
  const createStorageVolume = vi.fn(async () => {
    present.add(id);
    return { status: 200, envelope: { type: 'sync' } };
  });
  return { getStorageVolume, deleteStorageVolume, createStorageVolume, getOperationWait: vi.fn() };
}

function destroyState(input: {
  catalogs: Array<ReturnType<typeof catalog>>;
  attachments?: boolean;
  removeAllCommitted?: boolean;
  removeAllServerId?: string | null;
  dirEnsured?: boolean;
  eligible?: Array<{ server_id: string; pool_name: string }>;
}) {
  return {
    volume: {
      id: volumeId,
      pool_id: null,
      server_id: null,
      shared_backend_id: 'backend',
      incus_name: incusName,
      size_bytes: '10',
      used_bytes: null,
      generation: 2,
      lifecycle_phase: 'deleting' as const,
      needs_attention: false,
      dir_ensured: input.dirEnsured ?? false,
      remove_all_committed: input.removeAllCommitted ?? false,
      remove_all_server_id: input.removeAllServerId ?? null,
    },
    catalogs: [...input.catalogs],
    eligible: input.eligible ?? input.catalogs.map((row) => ({
      server_id: row.server_id,
      pool_name: row.pool_name,
    })),
    attachments: input.attachments === true,
  };
}

function installDestroySpies(
  reconciler: VolumeReconciler,
  state: ReturnType<typeof destroyState>,
) {
  vi.spyOn(
    reconciler as unknown as { readVolumeRow: () => Promise<unknown> },
    'readVolumeRow',
  ).mockImplementation(async () => ({ ...state.volume }));
  vi.spyOn(
    reconciler as unknown as { hasAnyAttachments: () => Promise<boolean> },
    'hasAnyAttachments',
  ).mockImplementation(async () => state.attachments);
  vi.spyOn(
    reconciler as unknown as { listCatalogs: () => Promise<unknown> },
    'listCatalogs',
  ).mockImplementation(async () => [...state.catalogs]);
  vi.spyOn(
    reconciler as unknown as { listDestroyExecutors: () => Promise<unknown> },
    'listDestroyExecutors',
  ).mockImplementation(async () => [...state.eligible]);
  const pin = vi.spyOn(
    reconciler as unknown as { pinRemoveAllServer: (id: string, serverId: string) => Promise<void> },
    'pinRemoveAllServer',
  ).mockImplementation(async (_id, serverId) => {
    state.volume.remove_all_server_id = serverId;
  });
  const mark = vi.spyOn(
    reconciler as unknown as { markRemoveAllCommitted: (id: string, executor: string | null) => Promise<void> },
    'markRemoveAllCommitted',
  ).mockImplementation(async (_id, executor) => {
    state.volume.remove_all_committed = true;
    state.volume.remove_all_server_id = executor;
  });
  const dropAll = vi.spyOn(
    reconciler as unknown as { dropAllPlacements: (id: string) => Promise<void> },
    'dropAllPlacements',
  ).mockImplementation(async () => {
    state.catalogs = [];
  });
  const finish = vi.spyOn(
    reconciler as unknown as { finishEmptyTracking: (id: string) => Promise<void> },
    'finishEmptyTracking',
  ).mockResolvedValue(undefined);
  const lease = { assertOwned: vi.fn() };
  return { mark, pin, dropAll, finish, lease };
}

function destroyContext(lease?: { assertOwned: ReturnType<typeof vi.fn> }): ReconcileRunContext {
  return runContext({
    kind: 'volume.destroy',
    serverId: null,
    client: undefined,
    lease: lease ?? { assertOwned: vi.fn() },
  });
}

function ensureRow() {
  return {
    id: volumeId,
    pool_id: 'pool-1',
    pool_name: 'default',
    placement_pool_name: 'default',
    incus_name: `nyv-${'e'.repeat(32)}`,
    size_bytes: '10',
    used_bytes: null,
    generation: 2,
    lifecycle_phase: 'active',
    catalog_state: 'present',
    resize_family: 'quota_online',
    driver: 'dir',
    target_server_id: serverId,
    shared_backend_id: null,
    server_id: serverId,
  };
}

function runContext(overrides: {
  kind?: string;
  serverId?: string | null;
  client?: unknown;
  attemptCount?: number;
  lease?: { assertOwned: ReturnType<typeof vi.fn> };
}): ReconcileRunContext {
  return {
    intent: {
      id: 'intent-1',
      kind: overrides.kind ?? 'volume.ensure',
      resourceType: 'volume',
      resourceId: volumeId,
      serverId: overrides.serverId === undefined ? serverId : overrides.serverId,
      request: {},
      attemptCount: overrides.attemptCount ?? 0,
      targetGeneration: 2,
    } as never,
    client: overrides.client as never,
    claim: {} as never,
    lease: (overrides.lease ?? { assertOwned: vi.fn() }) as never,
    signal: new AbortController().signal,
  };
}

function adoptContext(attemptCount: number, getError: IncusError, postError: IncusError) {
  return runContext({
    attemptCount,
    client: {
      getStorageVolume: vi.fn().mockRejectedValue(getError),
      createStorageVolume: vi.fn().mockRejectedValue(postError),
    },
  });
}

function localPool(id: string) {
  return {
    id: 'pool-1',
    incus_name: 'default',
    shared_backend_id: null,
    server_id: id,
    registered: true,
    driver: 'dir',
    shareable: false,
  };
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
  };
}

function volumeExistsDb(row: { lifecycle_phase?: string } = {}) {
  return {
    selectFrom: vi.fn((table: string) => {
      const query = chain();
      query.executeTakeFirst = vi.fn().mockResolvedValue(
        String(table).startsWith('control.volumes')
          ? {
            id: volumeId,
            lifecycle_phase: row.lifecycle_phase ?? 'active',
            dir_ensured: false,
            remove_all_committed: false,
            remove_all_server_id: null,
            size_bytes: '10',
            used_bytes: null,
            generation: 2,
            needs_attention: false,
            incus_name: incusName,
            pool_id: 'pool-1',
            server_id: serverId,
            shared_backend_id: null,
          }
          : undefined,
      );
      query.execute = vi.fn().mockResolvedValue([]);
      return query;
    }),
    updateTable: vi.fn(() => {
      const query = chain();
      query.execute = vi.fn().mockResolvedValue(undefined);
      return query;
    }),
    deleteFrom: vi.fn(() => {
      const query = chain();
      query.execute = vi.fn().mockResolvedValue(undefined);
      return query;
    }),
    transaction: vi.fn(() => ({
      execute: vi.fn(async (work: (trx: unknown) => Promise<unknown>) => work({
        selectFrom: vi.fn(() => {
          const query = chain();
          query.executeTakeFirst = vi.fn().mockResolvedValue({
            id: volumeId,
            lifecycle_phase: row.lifecycle_phase ?? 'active',
          });
          query.execute = vi.fn().mockResolvedValue([]);
          return query;
        }),
        updateTable: vi.fn(() => {
          const query = chain();
          query.execute = vi.fn().mockResolvedValue(undefined);
          return query;
        }),
        deleteFrom: vi.fn(() => {
          const query = chain();
          query.execute = vi.fn().mockResolvedValue(undefined);
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
      const query = chain();
      query.execute = vi.fn(async () => {
        if (String(table).startsWith('control.volumes')) return input.volumes;
        if (String(table).startsWith('control.volume_placements')) return input.placements ?? [];
        if (String(table).startsWith('control.volume_attachments')) return [];
        return input.pools;
      });
      query.executeTakeFirst = vi.fn().mockResolvedValue(undefined);
      return query;
    }),
    insertInto: vi.fn(() => {
      const query = chain();
      query.execute = vi.fn().mockResolvedValue(undefined);
      return query;
    }),
    updateTable: vi.fn(() => {
      const query = chain();
      query.execute = vi.fn().mockResolvedValue(undefined);
      return query;
    }),
    deleteFrom: vi.fn(() => {
      const query = chain();
      query.execute = vi.fn().mockResolvedValue(undefined);
      return query;
    }),
  };
}

function chain(): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const method of [
    'select',
    'where',
    'innerJoin',
    'selectAll',
    'set',
    'orderBy',
    'limit',
    'forUpdate',
    'values',
    'onConflict',
  ]) {
    query[method] = vi.fn(() => query);
  }
  query.execute = vi.fn().mockResolvedValue([]);
  query.executeTakeFirst = vi.fn().mockResolvedValue(undefined);
  return query;
}
