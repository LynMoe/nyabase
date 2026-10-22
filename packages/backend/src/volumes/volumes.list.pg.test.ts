import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Role } from '@nyabase/common';
import { testActor } from '../iam/actor.test-helper.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { VolumesRepository } from './volumes.repository.js';
import { makeVolumeServices } from './volume-services.test-helper.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(id: string, suffix: string) {
  return {
    id,
    name: `list-vol-${suffix}`,
    slug: `list-vol-${suffix}`,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: null,
    dns_servers: [],
    status: 'unknown' as const,
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

function userValues(id: string, numericId = 1) {
  return {
    id,
    numeric_id: numericId,
    username: `list-vol-${id.slice(0, 8)}`,
    password_hash: 'test-password-hash',
    display_name: 'Volume List Test User',
    status: 'active' as const,
    auth_version: 0,
  };
}

function makeService(database: Kysely<NyabaseDatabase>) {
  return makeVolumeServices(
    new VolumesRepository(database),
    new StoragePoolsRepository(database),
    new PgTransactionManager(database),
    new IntentRepository(database, noopWake()),
    database,
    { append: vi.fn().mockResolvedValue(undefined) } as never,
    { get: vi.fn().mockRejectedValue(new Error('Incus is unavailable in this test')), listServerIds: vi.fn() } as never,
  );
}

async function insertLocalPool(database: Kysely<NyabaseDatabase>, serverId: string) {
  const poolId = randomUUID();
  await database.insertInto('infra.storage_pools').values({
    id: poolId,
    server_id: serverId,
    incus_name: `local-${poolId.slice(0, 8)}`,
    driver: 'dir',
    resize_family: 'quota_online',
    root_disk_capable: true,
    shareable: false,
    block_filesystem: null,
    shared_backend_id: null,
    total_bytes: 1000,
    used_bytes: 0,
    quota_effective: true,
    display_name: null,
    registered: true,
    last_observed_at: new Date(),
    revision: 1,
  }).execute();
  return poolId;
}

async function insertVolume(
  database: Kysely<NyabaseDatabase>,
  ownerId: string,
  poolId: string | null,
  serverId: string | null,
  sharedBackendId: string | null,
  name: string,
) {
  const id = randomUUID();
  await database.insertInto('control.volumes').values({
    id,
    owner_id: ownerId,
    pool_id: sharedBackendId ? null : poolId,
    server_id: serverId,
    shared_backend_id: sharedBackendId,
    name,
    incus_name: `nyv-${id.replaceAll('-', '')}`,
    size_bytes: 100,
    used_bytes: 0,
    revision: 1,
    observed_revision: 1,
    lifecycle_phase: 'active',
    needs_attention: false,
    failure_code: null,
  }).execute();
  return id;
}

const volumeAdmin = testActor(randomUUID(), Role.Admin);

describePg('admin local volume list filter', () => {
  it('filters by server, excludes shared and other servers, and unfiltered still returns all local', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = randomUUID();
      const serverA = randomUUID();
      const serverB = randomUUID();
      const backendId = randomUUID();
      await database.insertInto('iam.users').values(userValues(ownerId)).execute();
      await database.insertInto('infra.servers').values([
        serverValues(serverA, `${serverA.slice(0, 8)}-a`),
        serverValues(serverB, `${serverB.slice(0, 8)}-b`),
      ]).execute();
      const poolA = await insertLocalPool(database, serverA);
      const poolB = await insertLocalPool(database, serverB);
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'list-shared',
        display_name: null,
        identity_key: `cephfs:ceph/fs-${backendId.slice(0, 8)}/data`,
        ceph_fsid: randomUUID(),
        total_bytes: 2000,
        used_bytes: 0,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();

      const volumeA = await insertVolume(database, ownerId, poolA, serverA, null, 'local-a');
      const volumeB = await insertVolume(database, ownerId, poolB, serverB, null, 'local-b');
      const sharedVolume = await insertVolume(
        database, ownerId, null, null, backendId, 'shared-hidden',
      );

      const service = makeService(database);
      const filtered = await service.list(volumeAdmin, { scope: 'all', serverId: serverA });
      expect(filtered.map((row) => row.id)).toEqual([volumeA]);
      expect(filtered.every((row) => row.serverId === serverA)).toBe(true);
      expect(filtered.every((row) => row.scope.kind === 'local')).toBe(true);

      const unfiltered = await service.list(volumeAdmin, { scope: 'all' });
      expect(unfiltered.map((row) => row.id).sort()).toEqual([volumeA, volumeB].sort());
      expect(unfiltered.some((row) => row.id === sharedVolume)).toBe(false);
      expect(unfiltered.every((row) => row.scope.kind === 'local')).toBe(true);
    });
  });
});

describePg('local volume actor scope', () => {
  it('scopes lists and reads to owner, other user and an admin', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = randomUUID();
      const otherId = randomUUID();
      const serverA = randomUUID();
      await database.insertInto('iam.users').values(userValues(ownerId)).execute();
      await database.insertInto('iam.users').values(userValues(otherId, 2)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverA, `${serverA.slice(0, 8)}-a`)).execute();
      const poolA = await insertLocalPool(database, serverA);
      const volumeId = await insertVolume(database, ownerId, poolA, serverA, null, 'owned');
      const service = makeService(database);
      const owner = testActor(ownerId);
      const other = testActor(otherId);

      expect((await service.list(owner, {})).map((row) => row.id)).toEqual([volumeId]);
      expect(await service.list(other, {})).toEqual([]);
      expect((await service.list(volumeAdmin, { scope: 'all' })).map((row) => row.id)).toEqual([volumeId]);
      expect(await service.list(volumeAdmin, {})).toEqual([]);
      await expect(service.list(owner, { scope: 'all' })).rejects.toMatchObject({ status: 403 });
      // An operator is not enough for volumes
      await expect(service.list(testActor(randomUUID(), Role.Operator), { scope: 'all' }))
        .rejects.toMatchObject({ status: 403 });

      await expect(service.get(owner, volumeId)).resolves.toMatchObject({ id: volumeId });
      await expect(service.get(volumeAdmin, volumeId, 'all')).resolves.toMatchObject({ id: volumeId });
      // The role alone does not reach someone else's volume; scope=all needs the role.
      await expect(service.get(volumeAdmin, volumeId)).rejects.toMatchObject({ status: 404 });
      await expect(service.get(other, volumeId, 'all')).rejects.toMatchObject({ status: 403 });
      await expect(service.get(other, volumeId)).rejects.toMatchObject({ status: 404 });
      await expect(service.delete(other, volumeId)).rejects.toMatchObject({ status: 404 });
      await expect(service.patch(other, volumeId, { expectedRevision: 1, name: 'x' }))
        .rejects.toMatchObject({ status: 404 });
    });
  });
});
