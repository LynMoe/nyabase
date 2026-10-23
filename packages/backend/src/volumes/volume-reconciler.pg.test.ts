import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { IncusError } from '../incus/index.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { VolumeReconciler } from './volume-reconciler.service.js';
import { VolumeReconcileStore } from './volume-reconcile.store.js';
import { ContainerReconcileStore } from '../containers/container-reconcile.store.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(id: string, suffix: string, status: 'online' | 'unreachable' | 'unknown' = 'online') {
  return {
    id,
    name: `vol-rec-${suffix}`,
    slug: `vol-rec-${suffix}`,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: null,
    dns_servers: [],
    status,
    last_seen_at: null,
    last_error: null,
    revision: 1,
    node_metrics_status: 'unknown' as const,
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: 'not_run' as const,
    preflight_checked_at: null,
    preflight_report: null,
  };
}

function poolValues(
  id: string,
  serverId: string,
  incusName: string,
  backendId: string | null,
) {
  return {
    id,
    server_id: serverId,
    incus_name: incusName,
    driver: backendId ? 'cephfs' as const : 'dir' as const,
    resize_family: 'quota_online' as const,
    root_disk_capable: !backendId,
    shareable: Boolean(backendId),
    block_filesystem: null,
    shared_backend_id: backendId,
    total_bytes: 1000,
    used_bytes: 0,
    quota_effective: true,
    display_name: null,
    registered: true,
    last_observed_at: new Date(),
    revision: 1,
  };
}

function destroyIntent(volumeId: string) {
  return {
    id: randomUUID(),
    kind: 'volume.destroy' as const,
    resourceType: 'volume' as const,
    resourceId: volumeId,
    serverId: null,
    request: { operation: 'destroy', idempotencyKey: 'destroy' },
    attemptCount: 0,
    targetRevision: 2,
  };
}

function catalogClient(serverId: string, present: Set<string>, incusName: string) {
  const getStorageVolume = vi.fn(async () => {
    if (!present.has(serverId)) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure');
    return { metadata: { name: incusName } };
  });
  const deleteStorageVolume = vi.fn(async () => {
    present.delete(serverId);
    return { status: 200, envelope: { type: 'sync' } };
  });
  const createStorageVolume = vi.fn(async () => {
    present.add(serverId);
    return { status: 200, envelope: { type: 'sync' } };
  });
  return { getStorageVolume, deleteStorageVolume, createStorageVolume, getOperationWait: vi.fn() };
}

describePg('volume reconciler equal-node destroy', () => {
  it('RemoveAll once on a GET 200 executor then drops remaining catalogs', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedSharedVolume(database, {
        aState: 'present',
        bState: 'present',
      });
      const present = new Set([fixture.serverA, fixture.serverB]);
      const clientA = catalogClient(fixture.serverA, present, fixture.incusName);
      const clientB = catalogClient(fixture.serverB, present, fixture.incusName);
      const reconciler = new VolumeReconciler(new VolumeReconcileStore(database, new IntentRepository(database, noopWake())),
        { log: vi.fn().mockResolvedValue(undefined) } as never,
        {
          get: vi.fn(async (id: string) => (id === fixture.serverA ? clientA : clientB)),
        } as never,
        { register: vi.fn() } as never,
      );

      const outcome = await reconciler.reconcile({
        intent: destroyIntent(fixture.volumeId) as never,
        claim: {} as never,
        lease: { assertOwned: vi.fn() } as never,
        signal: new AbortController().signal,
      });

      expect(outcome).toMatchObject({ outcome: 'succeeded' });
      expect([
        clientA.deleteStorageVolume.mock.calls.length,
        clientB.deleteStorageVolume.mock.calls.length,
      ]).toEqual([1, 1]);
      expect(
        await database.selectFrom('control.volumes').select('id').where('id', '=', fixture.volumeId).execute(),
      ).toHaveLength(0);
      expect(
        await database.selectFrom('control.volume_placements').select('server_id')
          .where('volume_id', '=', fixture.volumeId).execute(),
      ).toHaveLength(0);
    });
  });

  it('GET-all prefers a present 200 catalog over an ensuring 404', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedSharedVolume(database, {
        aState: 'present',
        bState: 'ensuring',
      });
      const present = new Set([fixture.serverA]);
      const clientA = catalogClient(fixture.serverA, present, fixture.incusName);
      const clientB = catalogClient(fixture.serverB, present, fixture.incusName);
      const reconciler = new VolumeReconciler(new VolumeReconcileStore(database, new IntentRepository(database, noopWake())),
        { log: vi.fn().mockResolvedValue(undefined) } as never,
        {
          get: vi.fn(async (id: string) => (id === fixture.serverA ? clientA : clientB)),
        } as never,
        { register: vi.fn() } as never,
      );

      const outcome = await reconciler.reconcile({
        intent: destroyIntent(fixture.volumeId) as never,
        claim: {} as never,
        lease: { assertOwned: vi.fn() } as never,
        signal: new AbortController().signal,
      });

      expect(outcome).toMatchObject({ outcome: 'succeeded' });
      expect(clientA.deleteStorageVolume).toHaveBeenCalledTimes(1);
      expect(clientB.deleteStorageVolume).not.toHaveBeenCalled();
      expect(
        await database.selectFrom('control.volumes').select('id').where('id', '=', fixture.volumeId).execute(),
      ).toHaveLength(0);
    });
  });

  it('retries with zero DELETE when one catalog GET times out', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedSharedVolume(database, {
        aState: 'present',
        bState: 'ensuring',
      });
      const present = new Set([fixture.serverA]);
      const clientA = catalogClient(fixture.serverA, present, fixture.incusName);
      clientA.getStorageVolume.mockRejectedValue(new IncusError('INCUS_TIMEOUT', 'retry'));
      const clientB = catalogClient(fixture.serverB, present, fixture.incusName);
      const reconciler = new VolumeReconciler(new VolumeReconcileStore(database, new IntentRepository(database, noopWake())),
        { log: vi.fn().mockResolvedValue(undefined) } as never,
        {
          get: vi.fn(async (id: string) => (id === fixture.serverA ? clientA : clientB)),
        } as never,
        { register: vi.fn() } as never,
      );

      const outcome = await reconciler.reconcile({
        intent: destroyIntent(fixture.volumeId) as never,
        claim: {} as never,
        lease: { assertOwned: vi.fn() } as never,
        signal: new AbortController().signal,
      });

      expect(outcome).toMatchObject({
        outcome: 'retry',
        failure: { code: 'VOLUME_DESTROY_RETRY' },
      });
      expect(clientA.deleteStorageVolume).not.toHaveBeenCalled();
      expect(clientB.deleteStorageVolume).not.toHaveBeenCalled();
      const volume = await database.selectFrom('control.volumes')
        .select(['id', 'remove_all_committed'])
        .where('id', '=', fixture.volumeId)
        .executeTakeFirstOrThrow();
      expect(volume.remove_all_committed).toBe(false);
      expect(
        await database.selectFrom('control.volume_placements').select('server_id')
          .where('volume_id', '=', fixture.volumeId).execute(),
      ).toHaveLength(2);
    });
  });

  it('settles leftover intents and deletes the volume when tracking is empty', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedSharedVolume(database, {
        aState: 'present',
        bState: 'present',
      });
      await database.deleteFrom('control.volume_placements')
        .where('volume_id', '=', fixture.volumeId)
        .execute();
      const leftoverId = randomUUID();
      await database.insertInto('control.intents').values({
        id: leftoverId,
        kind: 'volume.ensure',
        resource_type: 'volume',
        resource_id: fixture.volumeId,
        server_id: fixture.serverA,
        requested_by: fixture.ownerId,
        request_json: JSON.stringify({ operation: 'create', idempotencyKey: 'create' }),
        target_revision: 1,
        baseline_json: null,
        status: 'pending',
        failure_code: null,
        failure_json: null,
        attempt_count: 0,
        next_attempt_at: null,
        settled_at: null,
      }).execute();
      const get = vi.fn();
      const reconciler = new VolumeReconciler(new VolumeReconcileStore(database, new IntentRepository(database, noopWake())),
        { log: vi.fn().mockResolvedValue(undefined) } as never,
        { get } as never,
        { register: vi.fn() } as never,
      );

      const outcome = await reconciler.reconcile({
        intent: destroyIntent(fixture.volumeId) as never,
        claim: {} as never,
        lease: { assertOwned: vi.fn() } as never,
        signal: new AbortController().signal,
      });

      expect(outcome).toMatchObject({ outcome: 'succeeded' });
      expect(get).not.toHaveBeenCalled();
      expect(
        await database.selectFrom('control.volumes').select('id').where('id', '=', fixture.volumeId).execute(),
      ).toHaveLength(0);
      const leftover = await database.selectFrom('control.intents')
        .select(['id', 'status'])
        .where('id', '=', leftoverId)
        .executeTakeFirstOrThrow();
      expect(leftover.status).toBe('succeeded');
    });
  });

  it('does not call deleteStorageVolume for volume.ensure on a deleting volume', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedSharedVolume(database, {
        aState: 'present',
        bState: 'present',
      });
      const deleteStorageVolume = vi.fn();
      const getStorageVolume = vi.fn();
      const reconciler = new VolumeReconciler(new VolumeReconcileStore(database, new IntentRepository(database, noopWake())),
        { log: vi.fn().mockResolvedValue(undefined) } as never,
        { get: vi.fn() } as never,
        { register: vi.fn() } as never,
      );

      const outcome = await reconciler.reconcile({
        intent: {
          id: randomUUID(),
          kind: 'volume.ensure',
          resourceType: 'volume',
          resourceId: fixture.volumeId,
          serverId: fixture.serverA,
          request: { operation: 'create' },
          attemptCount: 0,
          targetRevision: 2,
        } as never,
        client: { getStorageVolume, deleteStorageVolume } as never,
        claim: {} as never,
        lease: { assertOwned: vi.fn() } as never,
        signal: new AbortController().signal,
      });

      expect(outcome).toMatchObject({
        outcome: 'retry',
        failure: { code: 'VOLUME_DESTROY_PENDING' },
      });
      expect(deleteStorageVolume).not.toHaveBeenCalled();
      expect(getStorageVolume).not.toHaveBeenCalled();
    });
  });

  it('scan does not orphan-delete a pool_id-null volume and does not insert missing placements', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedSharedVolume(database, {
        aState: 'present',
        bState: 'present',
        lifecyclePhase: 'active',
        poolIdNull: true,
      });
      await database.deleteFrom('control.volume_placements')
        .where('volume_id', '=', fixture.volumeId)
        .where('server_id', '=', fixture.serverB)
        .execute();
      const ensurePending = vi.fn().mockResolvedValue({ id: 'intent' });
      const deleteStorageVolume = vi.fn();
      const reconciler = new VolumeReconciler(new VolumeReconcileStore(database, { ensurePending } as never),
        { log: vi.fn().mockResolvedValue(undefined) } as never,
        { get: vi.fn().mockResolvedValue(undefined), listServerIds: vi.fn() } as never,
        { register: vi.fn() } as never,
      );

      await reconciler.scan(fixture.serverA, {
        listStorageVolumes: vi.fn().mockResolvedValue({
          metadata: [{ name: fixture.incusName, type: 'custom' }],
        }),
        deleteStorageVolume,
      } as never, new AbortController().signal);
      await reconciler.scan(fixture.serverB, {
        listStorageVolumes: vi.fn().mockResolvedValue({
          metadata: [{ name: fixture.incusName, type: 'custom' }],
        }),
        deleteStorageVolume,
      } as never, new AbortController().signal);

      expect(deleteStorageVolume).not.toHaveBeenCalled();
      const placements = await database.selectFrom('control.volume_placements')
        .select('server_id')
        .where('volume_id', '=', fixture.volumeId)
        .execute();
      expect(placements.map((row) => row.server_id)).toEqual([fixture.serverA]);
      expect(ensurePending).not.toHaveBeenCalledWith(expect.objectContaining({
        kind: 'volume.destroy',
      }));
    });
  });
});

describePg('volume reconciler shrink reservation release', () => {
  function sizeIntent(kind: 'volume.resize' | 'volume.ensure', volumeId: string, serverId: string) {
    return {
      id: randomUUID(),
      kind,
      resourceType: 'volume' as const,
      resourceId: volumeId,
      serverId,
      request: { operation: kind === 'volume.resize' ? 'resize' : 'ensure_attachment', idempotencyKey: 'x' },
      attemptCount: 0,
      targetRevision: 3,
    };
  }

  function reconcilerFor(database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database']) {
    const store = new VolumeReconcileStore(database, new IntentRepository(database, noopWake()));
    const reconciler = new VolumeReconciler(
      store,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      { get: vi.fn() } as never,
      { register: vi.fn() } as never,
    );
    return { store, reconciler };
  }

  /** A shared volume shrunk from 100 to 20 at revision 3; both placements verified revision 2. */
  async function shrunkSharedVolume(
    database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'],
    bState: 'ensuring' | 'present' = 'present',
  ) {
    const fixture = await seedSharedVolume(database, { aState: 'present', bState, lifecyclePhase: 'active' });
    await database.updateTable('control.volumes')
      .set({ size_bytes: 20, shrink_reserved_bytes: 100, revision: 3, observed_revision: 2 })
      .where('id', '=', fixture.volumeId).execute();
    return fixture;
  }

  async function reservationOf(
    database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'],
    volumeId: string,
  ) {
    const row = await database.selectFrom('control.volumes').select('shrink_reserved_bytes')
      .where('id', '=', volumeId).executeTakeFirstOrThrow();
    return row.shrink_reserved_bytes;
  }

  it('releases the reservation once the lagging placement\'s resize finds its catalog missing', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await shrunkSharedVolume(database);
      const { store, reconciler } = reconcilerFor(database);
      await store.recordVerified((await store.readVolume(fixture.volumeId, fixture.serverA))!, 10n);
      // Server B's catalog may still hold 100 bytes.
      expect(await reservationOf(database, fixture.volumeId)).toBe('100');

      const client = catalogClient(fixture.serverB, new Set(), fixture.incusName);
      const outcome = await reconciler.reconcile({
        intent: sizeIntent('volume.resize', fixture.volumeId, fixture.serverB) as never,
        claim: {} as never,
        lease: { assertOwned: vi.fn() } as never,
        client: client as never,
        signal: new AbortController().signal,
      });

      expect(outcome).toMatchObject({ outcome: 'succeeded' });
      // A catalog that does not exist holds nothing.
      expect(await reservationOf(database, fixture.volumeId)).toBeNull();
      expect(await database.selectFrom('control.volume_placements')
        .select(['catalog_state', 'observed_revision'])
        .where('volume_id', '=', fixture.volumeId)
        .where('server_id', '=', fixture.serverB)
        .executeTakeFirstOrThrow()).toEqual({ catalog_state: 'ensuring', observed_revision: 3 });

      // A container pass that creates the catalog later did so at whatever
      // size it read: the placement counts as unverified again.
      await new ContainerReconcileStore(database, new IntentRepository(database, noopWake()))
        .markCatalogPresent(fixture.volumeId, fixture.serverB);
      expect(await database.selectFrom('control.volume_placements')
        .select(['catalog_state', 'observed_revision'])
        .where('volume_id', '=', fixture.volumeId)
        .where('server_id', '=', fixture.serverB)
        .executeTakeFirstOrThrow()).toEqual({ catalog_state: 'present', observed_revision: null });
      await store.markSucceeded(fixture.volumeId, 3);
      expect(await database.selectFrom('control.volumes').select('observed_revision')
        .where('id', '=', fixture.volumeId).executeTakeFirstOrThrow()).toEqual({ observed_revision: 2 });
    });
  });

  it('releases the reservation when a placement stuck ensuring cannot adopt its catalog', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await shrunkSharedVolume(database, 'ensuring');
      const { store, reconciler } = reconcilerFor(database);
      await store.recordVerified((await store.readVolume(fixture.volumeId, fixture.serverA))!, 10n);
      expect(await reservationOf(database, fixture.volumeId)).toBe('100');

      // Incus accepts the adopt but the catalog never appears.
      const client = catalogClient(fixture.serverB, new Set(), fixture.incusName);
      client.createStorageVolume.mockResolvedValue({ status: 200, envelope: { type: 'sync' } });
      const outcome = await reconciler.reconcile({
        intent: sizeIntent('volume.ensure', fixture.volumeId, fixture.serverB) as never,
        claim: {} as never,
        lease: { assertOwned: vi.fn() } as never,
        client: client as never,
        signal: new AbortController().signal,
      });

      expect(outcome).toMatchObject({ outcome: 'retry' });
      expect(await reservationOf(database, fixture.volumeId)).toBeNull();
    });
  });

  it('keeps the reservation while a placement whose catalog exists has not verified the shrink', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await shrunkSharedVolume(database);
      const { store } = reconcilerFor(database);
      await store.recordVerified((await store.readVolume(fixture.volumeId, fixture.serverA))!, 10n);
      await store.markSucceeded(fixture.volumeId, 3);
      expect(await reservationOf(database, fixture.volumeId)).toBe('100');
      await store.recordVerified((await store.readVolume(fixture.volumeId, fixture.serverB))!, 10n);
      expect(await reservationOf(database, fixture.volumeId)).toBeNull();
    });
  });

  it('scan queues a resize for a dangling placement that keeps a shrink reserved', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await shrunkSharedVolume(database);
      const ensurePending = vi.fn().mockResolvedValue({ id: 'intent' });
      const reconciler = new VolumeReconciler(new VolumeReconcileStore(database, { ensurePending } as never),
        { log: vi.fn().mockResolvedValue(undefined) } as never,
        { get: vi.fn().mockResolvedValue(undefined), listServerIds: vi.fn() } as never,
        { register: vi.fn() } as never,
      );
      const emptyListing = { listStorageVolumes: vi.fn().mockResolvedValue({ metadata: [] }) };

      await reconciler.scan(fixture.serverB, emptyListing as never, new AbortController().signal);
      expect(ensurePending).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'volume.resize',
        resourceId: fixture.volumeId,
        serverId: fixture.serverB,
        targetRevision: 3,
      }));

      // Without a reservation a dangling placement is only reported.
      ensurePending.mockClear();
      await database.updateTable('control.volumes').set({ shrink_reserved_bytes: null })
        .where('id', '=', fixture.volumeId).execute();
      await reconciler.scan(fixture.serverB, emptyListing as never, new AbortController().signal);
      expect(ensurePending).not.toHaveBeenCalled();
    });
  });
});

describePg('volume reconciler destroy while executors are offline', () => {
  function reconcilerFor(database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database']) {
    const deleteStorageVolume = vi.fn();
    const reconciler = new VolumeReconciler(new VolumeReconcileStore(database, new IntentRepository(database, noopWake())),
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      { get: vi.fn(async () => ({ deleteStorageVolume })) } as never,
      { register: vi.fn() } as never,
    );
    return { reconciler, deleteStorageVolume };
  }

  function run(reconciler: VolumeReconciler, volumeId: string) {
    return reconciler.reconcile({
      intent: destroyIntent(volumeId) as never,
      claim: {} as never,
      lease: { assertOwned: vi.fn() } as never,
      signal: new AbortController().signal,
    });
  }

  it('keeps a shared volume and retries while every executor is unreachable; drops it once none exists', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedSharedVolume(database, { aState: 'present', bState: 'present' });
      await database.updateTable('control.volumes').set({ dir_ensured: true })
        .where('id', '=', fixture.volumeId).execute();
      await database.updateTable('infra.servers').set({ status: 'unreachable' })
        .where('id', 'in', [fixture.serverA, fixture.serverB]).execute();
      const { reconciler, deleteStorageVolume } = reconcilerFor(database);

      await expect(run(reconciler, fixture.volumeId)).resolves.toMatchObject({
        outcome: 'retry',
        failure: { code: 'SERVER_UNREACHABLE' },
      });
      expect(deleteStorageVolume).not.toHaveBeenCalled();
      expect(await database.selectFrom('control.volumes').select('id')
        .where('id', '=', fixture.volumeId).execute()).toHaveLength(1);
      expect(await database.selectFrom('control.volume_placements').select('server_id')
        .where('volume_id', '=', fixture.volumeId).execute()).toHaveLength(2);

      // The executors are really gone once their pools no longer reach the backend.
      await database.updateTable('infra.storage_pools').set({ registered: false })
        .where('id', 'in', [fixture.poolA, fixture.poolB]).execute();
      await expect(run(reconciler, fixture.volumeId)).resolves.toMatchObject({ outcome: 'succeeded' });
      expect(await database.selectFrom('control.volumes').select('id')
        .where('id', '=', fixture.volumeId).execute()).toHaveLength(0);
    });
  });

  it('keeps a local volume and retries while its server is unreachable', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedSharedVolume(database, { aState: 'present', bState: 'present' });
      const localPool = randomUUID();
      await database.insertInto('infra.storage_pools')
        .values(poolValues(localPool, fixture.serverA, 'local-a', null)).execute();
      await database.deleteFrom('control.volume_placements').where('volume_id', '=', fixture.volumeId).execute();
      await database.updateTable('control.volumes')
        .set({ shared_backend_id: null, pool_id: localPool, server_id: fixture.serverA })
        .where('id', '=', fixture.volumeId).execute();
      await database.insertInto('control.volume_placements').values({
        volume_id: fixture.volumeId,
        server_id: fixture.serverA,
        pool_id: localPool,
        catalog_state: 'present',
        observed_revision: 2,
      }).execute();
      await database.updateTable('infra.servers').set({ status: 'unreachable' })
        .where('id', '=', fixture.serverA).execute();
      const { reconciler, deleteStorageVolume } = reconcilerFor(database);

      await expect(run(reconciler, fixture.volumeId)).resolves.toMatchObject({
        outcome: 'retry',
        failure: { code: 'SERVER_UNREACHABLE' },
      });
      expect(deleteStorageVolume).not.toHaveBeenCalled();
      expect(await database.selectFrom('control.volumes').select('id')
        .where('id', '=', fixture.volumeId).execute()).toHaveLength(1);
      expect(await database.selectFrom('control.volume_placements').select('server_id')
        .where('volume_id', '=', fixture.volumeId).execute()).toHaveLength(1);
    });
  });
});

describePg('volume reconciler local destroy after a lost commit', () => {
  /** One local Incus volume: GET reflects `state.present`, DELETE removes it. */
  function localClient(state: { present: boolean }, incusName: string) {
    const getStorageVolume = vi.fn(async () => {
      if (!state.present) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure');
      return { metadata: { name: incusName } };
    });
    const deleteStorageVolume = vi.fn(async () => {
      if (!state.present) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure');
      state.present = false;
      return { status: 200, envelope: { type: 'sync' } };
    });
    return { getStorageVolume, deleteStorageVolume, getOperationWait: vi.fn() };
  }

  function reconcilerFor(
    database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'],
    client: ReturnType<typeof localClient>,
  ) {
    const store = new VolumeReconcileStore(database, new IntentRepository(database, noopWake()));
    const reconciler = new VolumeReconciler(store,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      { get: vi.fn(async () => client) } as never,
      { register: vi.fn() } as never,
    );
    return { reconciler, store };
  }

  function run(reconciler: VolumeReconciler, volumeId: string) {
    return reconciler.reconcile({
      intent: destroyIntent(volumeId) as never,
      claim: {} as never,
      lease: { assertOwned: vi.fn() } as never,
      signal: new AbortController().signal,
    });
  }

  async function seedLocalVolume(
    database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'],
    options: { dirEnsured: boolean; pinned: boolean; needsAttention?: boolean },
  ) {
    const fixture = await seedSharedVolume(database, { aState: 'present', bState: 'present' });
    const localPool = randomUUID();
    await database.insertInto('infra.storage_pools')
      .values(poolValues(localPool, fixture.serverA, 'local-a', null)).execute();
    await database.deleteFrom('control.volume_placements').where('volume_id', '=', fixture.volumeId).execute();
    await database.updateTable('control.volumes')
      .set({
        shared_backend_id: null,
        pool_id: localPool,
        server_id: fixture.serverA,
        dir_ensured: options.dirEnsured,
        needs_attention: options.needsAttention ?? false,
        remove_all_server_id: options.pinned ? fixture.serverA : null,
      })
      .where('id', '=', fixture.volumeId).execute();
    await database.insertInto('control.volume_placements').values({
      volume_id: fixture.volumeId,
      server_id: fixture.serverA,
      pool_id: localPool,
      catalog_state: options.dirEnsured ? 'present' : 'ensuring',
      observed_revision: options.dirEnsured ? 2 : null,
    }).execute();
    return fixture;
  }

  async function volumeRows(
    database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'],
    volumeId: string,
  ) {
    return database.selectFrom('control.volumes').select('id').where('id', '=', volumeId).execute();
  }

  for (const dirEnsured of [true, false]) {
    it(`finishes a local destroy whose commit was lost after the DELETE (dir_ensured=${dirEnsured})`, async () => {
      await withPostgresTestDatabase(async ({ database }) => {
        const fixture = await seedLocalVolume(database, { dirEnsured, pinned: false });
        const incus = { present: true };
        const client = localClient(incus, fixture.incusName);
        const { reconciler, store } = reconcilerFor(database, client);
        const commit = vi.spyOn(store, 'markRemoveAllCommitted')
          .mockRejectedValueOnce(new Error('connection lost'));

        await expect(run(reconciler, fixture.volumeId)).rejects.toThrow('connection lost');
        expect(incus.present).toBe(false);
        expect(client.deleteStorageVolume).toHaveBeenCalledTimes(1);
        const pinned = await database.selectFrom('control.volumes')
          .select(['remove_all_server_id', 'remove_all_committed'])
          .where('id', '=', fixture.volumeId).executeTakeFirstOrThrow();
        expect(pinned).toEqual({ remove_all_server_id: fixture.serverA, remove_all_committed: false });

        commit.mockRestore();
        await expect(run(reconciler, fixture.volumeId)).resolves.toMatchObject({ outcome: 'succeeded' });
        expect(client.deleteStorageVolume).toHaveBeenCalledTimes(1);
        expect(await volumeRows(database, fixture.volumeId)).toHaveLength(0);
      });
    });

    it(`finishes a pinned local destroy that finds the volume gone (dir_ensured=${dirEnsured})`, async () => {
      await withPostgresTestDatabase(async ({ database }) => {
        const fixture = await seedLocalVolume(database, { dirEnsured, pinned: true });
        const client = localClient({ present: false }, fixture.incusName);
        const { reconciler } = reconcilerFor(database, client);

        await expect(run(reconciler, fixture.volumeId)).resolves.toMatchObject({ outcome: 'succeeded' });
        expect(client.deleteStorageVolume).not.toHaveBeenCalled();
        expect(await volumeRows(database, fixture.volumeId)).toHaveLength(0);
      });
    });
  }

  it('deletes a parked local volume whose Incus volume vanished', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedLocalVolume(database, {
        dirEnsured: true,
        pinned: false,
        needsAttention: true,
      });
      const client = localClient({ present: false }, fixture.incusName);
      const { reconciler } = reconcilerFor(database, client);

      await expect(run(reconciler, fixture.volumeId)).resolves.toMatchObject({ outcome: 'succeeded' });
      expect(client.deleteStorageVolume).not.toHaveBeenCalled();
      expect(await volumeRows(database, fixture.volumeId)).toHaveLength(0);
    });
  });

  it('treats a DELETE 404 after a GET 200 as removed', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedLocalVolume(database, { dirEnsured: true, pinned: false });
      const incus = { present: true };
      const client = localClient(incus, fixture.incusName);
      client.deleteStorageVolume.mockImplementationOnce(async () => {
        incus.present = false;
        throw new IncusError('INCUS_NOT_FOUND', 'managed_failure');
      });
      const { reconciler } = reconcilerFor(database, client);

      await expect(run(reconciler, fixture.volumeId)).resolves.toMatchObject({ outcome: 'succeeded' });
      expect(await volumeRows(database, fixture.volumeId)).toHaveLength(0);
    });
  });
});

async function seedSharedVolume(
  database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'],
  options: {
    aState: 'ensuring' | 'present';
    bState: 'ensuring' | 'present';
    lifecyclePhase?: 'active' | 'deleting';
    poolIdNull?: boolean;
  },
) {
  const ownerId = randomUUID();
  const serverA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const serverB = '11111111-1111-4111-8111-111111111111';
  const backendId = randomUUID();
  const poolA = randomUUID();
  const poolB = randomUUID();
  const volumeId = randomUUID();
  const incusName = `nyv-${volumeId.replaceAll('-', '')}`;
  await database.insertInto('iam.users').values({
    id: ownerId,
    numeric_id: 1,
    username: `vol-${ownerId.slice(0, 8)}`,
    password_hash: 'x',
    display_name: 'v',
    status: 'active',
    auth_version: 0,
  }).execute();
  await database.insertInto('infra.servers').values([
    serverValues(serverA, `a-${ownerId.slice(0, 6)}`),
    serverValues(serverB, `b-${ownerId.slice(0, 6)}`),
  ]).execute();
  await database.insertInto('infra.shared_backends').values({
    id: backendId,
    name: `ceph-${ownerId.slice(0, 6)}`,
    display_name: null,
    identity_key: `cephfs:ceph/${backendId}/data`,
    ceph_fsid: randomUUID(),
    total_bytes: 1000,
    used_bytes: 0,
    overcommit_ratio: 1,
    revision: 1,
  }).execute();
  await database.insertInto('infra.storage_pools').values([
    poolValues(poolA, serverA, 'cephfs-a', backendId),
    poolValues(poolB, serverB, 'cephfs-b', backendId),
  ]).execute();
  await database.insertInto('control.volumes').values({
    id: volumeId,
    owner_id: ownerId,
    pool_id: null,
    server_id: null,
    shared_backend_id: backendId,
    name: 'shared',
    incus_name: incusName,
    size_bytes: 100,
    used_bytes: 0,
    revision: 2,
    observed_revision: 1,
    lifecycle_phase: options.lifecyclePhase ?? 'deleting',
    needs_attention: false,
    failure_code: null,
    remove_all_committed: false,
    remove_all_server_id: null,
  }).execute();
  await database.insertInto('control.volume_placements').values([
    {
      volume_id: volumeId,
      server_id: serverA,
      pool_id: poolA,
      catalog_state: options.aState,
      observed_revision: options.aState === 'present' ? 2 : null,
    },
    {
      volume_id: volumeId,
      server_id: serverB,
      pool_id: poolB,
      catalog_state: options.bState,
      observed_revision: options.bState === 'present' ? 2 : null,
    },
  ]).execute();
  return { ownerId, serverA, serverB, poolA, poolB, volumeId, incusName };
}
