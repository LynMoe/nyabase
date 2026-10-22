import type { Kysely } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedServer } from '../iam/access.pg-test-helper.js';
import { IncusError } from '../incus/incus-errors.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { ServerRecoveryService } from './server-recovery.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function harness(database: Kysely<NyabaseDatabase>, connected = true) {
  const agents = { isConnected: vi.fn(() => connected) };
  const getServer = vi.fn().mockResolvedValue({ metadata: {} });
  const clients = { get: vi.fn().mockResolvedValue({ getServer }) };
  const wake = { wake: vi.fn() };
  const service = new ServerRecoveryService(database, agents as never, clients as never, wake as never);
  return {
    service,
    agents,
    getServer,
    wake,
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}

async function markUnreachable(database: Kysely<NyabaseDatabase>, serverId: string) {
  await database.updateTable('infra.servers')
    .set({ status: 'unreachable', last_error: 'Incus request timed out' })
    .where('id', '=', serverId)
    .execute();
}

async function statusOf(database: Kysely<NyabaseDatabase>, serverId: string) {
  return database.selectFrom('infra.servers').select(['status', 'last_error'])
    .where('id', '=', serverId).executeTakeFirstOrThrow();
}

describePg('ServerRecoveryService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores a server marked unreachable while its agent stayed connected and wakes a scan', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      await markUnreachable(database, serverId);
      const h = harness(database);

      await h.service.probe(serverId);

      expect(await statusOf(database, serverId)).toEqual({ status: 'online', last_error: null });
      expect(h.wake.wake).toHaveBeenCalledWith({ reason: 'scan' });
      expect(h.wake.wake).toHaveBeenCalledWith({ serverId, reason: 'reconnect' });
    });
  });

  it('keeps the server unreachable while Incus still fails and probes again with backoff', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      await markUnreachable(database, serverId);
      const h = harness(database);
      h.getServer.mockRejectedValueOnce(new IncusError('INCUS_TIMEOUT', 'retry', { serverId }));
      const watch = vi.spyOn(h.service, 'watch');

      await h.service.probe(serverId, 15_000);

      expect((await statusOf(database, serverId)).status).toBe('unreachable');
      expect(watch).toHaveBeenCalledWith(serverId, 30_000);
      expect(h.wake.wake).not.toHaveBeenCalled();
      h.service.onModuleDestroy();
    });
  });

  it('leaves recovery to the next agent connect when the agent is gone', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      await markUnreachable(database, serverId);
      const h = harness(database, false);

      h.service.watch(serverId);
      await h.service.probe(serverId);

      expect(h.getServer).not.toHaveBeenCalled();
      expect((await statusOf(database, serverId)).status).toBe('unreachable');
      h.service.onModuleDestroy();
    });
  });

  it('does not touch a server that is not unreachable', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      await database.updateTable('infra.servers').set({ status: 'unknown' })
        .where('id', '=', serverId).execute();
      const h = harness(database);

      await h.service.probe(serverId);

      expect(h.getServer).not.toHaveBeenCalled();
      expect((await statusOf(database, serverId)).status).toBe('unknown');
    });
  });
});

describe('ServerRecoveryService scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules one pending probe per server while the agent is connected', async () => {
    vi.useFakeTimers();
    const agents = { isConnected: vi.fn(() => true) };
    const service = new ServerRecoveryService({} as never, agents as never, {} as never, {} as never);
    const probe = vi.spyOn(service, 'probe').mockResolvedValue(undefined);

    service.watch('server-1');
    service.watch('server-1');
    await vi.advanceTimersByTimeAsync(15_000);

    expect(probe.mock.calls).toEqual([['server-1', 15_000]]);
    agents.isConnected.mockReturnValue(false);
    service.watch('server-1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
