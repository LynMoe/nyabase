import { describe, expect, it, vi } from 'vitest';
import { AuditAction, Role, ServerStatus, UserStatus } from '@nyabase/common';
import type { Kysely } from 'kysely';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import {
  seedBackend,
  seedBackendPool,
  seedServer,
  seedUser,
  seedVolume,
} from '../iam/access.pg-test-helper.js';
import { ServersService } from './servers.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serversService(database: Kysely<NyabaseDatabase>, append = vi.fn()) {
  return new ServersService(
    database,
    new PgTransactionManager(database),
    {} as never,
    { append } as never,
    { invalidate: vi.fn() } as never,
    { disconnect: vi.fn(), isConnected: vi.fn(() => false), current: vi.fn(() => undefined) } as never,
    {} as never,
    { wake: vi.fn() } as never,
    { agentStatuses: vi.fn(async () => new Map()) } as never,
  );
}

async function placeOn(
  database: Kysely<NyabaseDatabase>,
  volumeId: string,
  serverId: string,
  poolId: string,
): Promise<void> {
  await database.insertInto('control.volume_placements').values({
    volume_id: volumeId,
    server_id: serverId,
    pool_id: poolId,
    catalog_state: 'present',
    observed_revision: 1,
  }).execute();
}

describePg('server removal and shared backend executors', () => {
  it('keeps a shared volume placed only on the deleted server while an unreachable peer reaches the backend', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actor = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const ownerId = await seedUser(database);
      const backendId = await seedBackend(database);
      const serverS = await seedServer(database);
      const serverT = await seedServer(database);
      await database.updateTable('infra.servers').set({ status: ServerStatus.Unreachable }).where('id', '=', serverT).execute();
      const cephS = await seedBackendPool(database, serverS, backendId);
      await seedBackendPool(database, serverT, backendId);
      const volumeId = await seedVolume(database, { ownerId, poolId: null, serverId: null, sharedBackendId: backendId });
      await database.updateTable('control.volumes').set({ dir_ensured: true }).where('id', '=', volumeId).execute();
      await placeOn(database, volumeId, serverS, cephS);
      const append = vi.fn();

      await expect(serversService(database, append).delete(actor, serverS, 1)).resolves.toBeUndefined();

      expect(
        await database.selectFrom('control.volumes').select(['id', 'size_bytes'])
          .where('id', '=', volumeId).executeTakeFirst(),
      ).toMatchObject({ id: volumeId });
      expect(
        await database.selectFrom('control.volume_placements').select('server_id')
          .where('volume_id', '=', volumeId).execute(),
      ).toEqual([]);
      expect(append.mock.calls.filter((call) => call[2] === AuditAction.DeleteVolume)).toEqual([]);
    });
  });

  it('releases a shrink reservation that only the removed server\'s placement still held', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actor = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const ownerId = await seedUser(database);
      const backendId = await seedBackend(database);
      const serverS = await seedServer(database);
      const serverT = await seedServer(database);
      const cephS = await seedBackendPool(database, serverS, backendId);
      const cephT = await seedBackendPool(database, serverT, backendId);
      const volumeId = await seedVolume(database, { ownerId, poolId: null, serverId: null, sharedBackendId: backendId });
      await placeOn(database, volumeId, serverS, cephS);
      await placeOn(database, volumeId, serverT, cephT);
      // Shrunk at revision 2: T verified it, S never did.
      await database.updateTable('control.volumes')
        .set({ dir_ensured: true, size_bytes: 20, shrink_reserved_bytes: 100, revision: 2 })
        .where('id', '=', volumeId).execute();
      await database.updateTable('control.volume_placements').set({ observed_revision: 2 })
        .where('volume_id', '=', volumeId).where('server_id', '=', serverT).execute();

      await serversService(database).delete(actor, serverS, 1);

      expect(await database.selectFrom('control.volumes').select(['size_bytes', 'shrink_reserved_bytes'])
        .where('id', '=', volumeId).executeTakeFirstOrThrow())
        .toEqual({ size_bytes: '20', shrink_reserved_bytes: null });
    });
  });

  it('refuses to remove the last executor of a backend with volumes unless forced, then keeps live volumes', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actor = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const ownerId = await seedUser(database);
      const backendId = await seedBackend(database);
      const serverS = await seedServer(database);
      const cephS = await seedBackendPool(database, serverS, backendId);
      const liveId = await seedVolume(database, { ownerId, poolId: null, serverId: null, sharedBackendId: backendId });
      const deletingId = await seedVolume(database, {
        ownerId,
        poolId: null,
        serverId: null,
        sharedBackendId: backendId,
      });
      await database.updateTable('control.volumes')
        .set({ dir_ensured: true })
        .where('id', 'in', [liveId, deletingId])
        .execute();
      await database.updateTable('control.volumes')
        .set({ lifecycle_phase: 'deleting' })
        .where('id', '=', deletingId)
        .execute();
      await placeOn(database, liveId, serverS, cephS);
      await placeOn(database, deletingId, serverS, cephS);
      const append = vi.fn();
      const service = serversService(database, append);

      await expect(service.delete(actor, serverS, 1)).rejects.toMatchObject({
        response: {
          code: 'SERVER_NOT_EMPTY',
          details: { containers: 0, localVolumes: 0, strandedSharedVolumes: 2 },
        },
      });
      expect(
        await database.selectFrom('infra.servers').select('id').where('id', '=', serverS).executeTakeFirst(),
      ).toMatchObject({ id: serverS });

      await expect(service.delete(actor, serverS, 1, true)).resolves.toBeUndefined();

      expect(
        await database.selectFrom('infra.servers').select('id').where('id', '=', serverS).executeTakeFirst(),
      ).toBeUndefined();
      // The live volume stays tracked until another executor is registered.
      expect(
        await database.selectFrom('control.volumes').select('id').where('id', '=', liveId).executeTakeFirst(),
      ).toMatchObject({ id: liveId });
      // The pending destroy can never run any more: it finishes as the reconciler would.
      expect(
        await database.selectFrom('control.volumes').select('id').where('id', '=', deletingId).executeTakeFirst(),
      ).toBeUndefined();
      const volumeAudits = append.mock.calls.filter((call) => call[2] === AuditAction.DeleteVolume);
      expect(volumeAudits).toHaveLength(1);
      expect(volumeAudits[0]).toEqual([
        expect.anything(),
        null,
        AuditAction.DeleteVolume,
        deletingId,
        'volume',
        { reason: 'destroy_executor_gone' },
      ]);
      expect(append).toHaveBeenCalledWith(
        expect.anything(),
        actor,
        AuditAction.DeleteServer,
        serverS,
        'server',
        expect.objectContaining({ force: true, strandedSharedVolumes: 2 }),
      );
    });
  });

  it('removes the last executor of a backend without volumes', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actor = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const backendId = await seedBackend(database);
      const serverS = await seedServer(database);
      await seedBackendPool(database, serverS, backendId);

      await expect(serversService(database).delete(actor, serverS, 1)).resolves.toBeUndefined();

      expect(
        await database.selectFrom('infra.servers').select('id').where('id', '=', serverS).executeTakeFirst(),
      ).toBeUndefined();
    });
  });
});
