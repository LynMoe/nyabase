import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { IncusError } from '../incus/index.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { IntentRepository } from './intent.repository.js';
import { VolumeReconciler } from './volume-reconciler.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(id: string, suffix: string, status: 'online' | 'unreachable' | 'unknown' = 'online') {
  return {
    id,
    name: `vol-rec-${suffix}`,
    slug: `vol-rec-${suffix}`,
    api_endpoint: 'https://127.0.0.1:8443',
    server_cert_fingerprint: null,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: null,
    dns_servers: [],
    gpu_runtime_available: false,
    status,
    last_seen_at: null,
    last_error: null,
    revision: 1,
    node_metrics_endpoint: null,
    node_metrics_server_cert_fingerprint: null,
    node_metrics_token_ciphertext: null,
    node_metrics_token_fingerprint: null,
    node_metrics_status: 'unconfigured' as const,
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
    targetGeneration: 2,
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
      const reconciler = new VolumeReconciler(
        database,
        new IntentRepository(database),
        undefined,
        {
          get: vi.fn(async (id: string) => (id === fixture.serverA ? clientA : clientB)),
        } as never,
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
      ].sort()).toEqual([0, 1]);
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
      const reconciler = new VolumeReconciler(
        database,
        new IntentRepository(database),
        undefined,
        {
          get: vi.fn(async (id: string) => (id === fixture.serverA ? clientA : clientB)),
        } as never,
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
      const reconciler = new VolumeReconciler(
        database,
        new IntentRepository(database),
        undefined,
        {
          get: vi.fn(async (id: string) => (id === fixture.serverA ? clientA : clientB)),
        } as never,
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
        target_generation: 1,
        baseline_json: null,
        status: 'pending',
        failure_code: null,
        failure_json: null,
        attempt_count: 0,
        next_attempt_at: null,
        blocked_by_intent_id: null,
        settled_at: null,
      }).execute();
      const get = vi.fn();
      const reconciler = new VolumeReconciler(
        database,
        new IntentRepository(database),
        undefined,
        { get } as never,
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
      const reconciler = new VolumeReconciler(
        database,
        new IntentRepository(database),
        undefined,
        { get: vi.fn() } as never,
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
          targetGeneration: 2,
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
      const reconciler = new VolumeReconciler(
        database,
        { ensurePending } as never,
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
    authz_version: 0,
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
    generation: 2,
    observed_generation: 1,
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
      observed_generation: options.aState === 'present' ? 2 : null,
    },
    {
      volume_id: volumeId,
      server_id: serverB,
      pool_id: poolB,
      catalog_state: options.bState,
      observed_generation: options.bState === 'present' ? 2 : null,
    },
  ]).execute();
  return { ownerId, serverA, serverB, poolA, poolB, volumeId, incusName };
}
