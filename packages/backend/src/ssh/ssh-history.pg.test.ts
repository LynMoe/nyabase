import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  Role,
  zSshSessionListQuery,
  zSshSessionStatsQuery,
  type SshProxyChannelRecord,
  type SshProxyConnectionRecord,
} from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { testActor } from '../iam/actor.test-helper.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { parseHistoryRecords } from './ssh-history-records.js';
import { SshHistoryRepository } from './ssh-history.repository.js';
import { SshSessionsService } from './ssh-sessions.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

const INSTANCE = 'ssh-proxy-1:aaaa';
const alice = randomUUID();
const bob = randomUUID();
const serverA = randomUUID();
const serverB = randomUUID();
const containerA = randomUUID();
const containerB = randomUUID();
let nextSeq = 1;

function connection(
  connectionSeq: number,
  overrides: Partial<SshProxyConnectionRecord> = {},
): SshProxyConnectionRecord {
  return {
    type: 'connection',
    seq: nextSeq++,
    connectionSeq,
    peer: '192.0.2.10:50000',
    clientVersion: 'SSH-2.0-OpenSSH_9.6',
    login: 'alice',
    userId: alice,
    username: 'alice',
    keyFingerprint: 'SHA256:abc',
    keyAlgorithm: 'ssh-ed25519',
    pinned: null,
    connectedAt: Date.now() - 60_000,
    authenticatedAt: Date.now() - 59_000,
    closedAt: null,
    closeReason: null,
    bytesFromClient: 0,
    bytesToClient: 0,
    channelsOpened: 0,
    channelsRejected: 0,
    rejectedRequests: {},
    ...overrides,
  };
}

function channel(
  connectionSeq: number,
  channelSeq: number,
  target: 'a' | 'b' | null,
  overrides: Partial<SshProxyChannelRecord> = {},
): SshProxyChannelRecord {
  const route = target === null
    ? null
    : {
      serverId: target === 'a' ? serverA : serverB,
      serverSlug: target === 'a' ? 'cpu-a' : 'cpu-b',
      containerId: target === 'a' ? containerA : containerB,
      containerName: target === 'a' ? 'work' : 'train',
      instanceName: `nyc-${target}`,
      routedIp: target === 'a' ? '10.0.0.2' : '10.0.0.3',
    };
  return {
    type: 'channel',
    seq: nextSeq++,
    connectionSeq,
    channelSeq,
    targetHost: route?.containerName ?? 'nowhere',
    targetPort: 22,
    originator: '127.0.0.1:0',
    route,
    result: 'opened',
    openedAt: Date.now() - 58_000,
    closedAt: null,
    closeReason: null,
    bytesFromClient: 0,
    bytesToClient: 0,
    ...overrides,
  };
}

describePg('SSH connection history (PostgreSQL)', () => {
  it('stores records idempotently and in any order, one connection reaching two servers', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new SshHistoryRepository(database);
      const sessions = new SshSessionsService(database);
      const closed = connection(1, {
        closedAt: Date.now(),
        closeReason: 'client_closed',
        bytesFromClient: 300,
        bytesToClient: 900,
        channelsOpened: 2,
        channelsRejected: 1,
        rejectedRequests: { rejected_permit: 1, session: 2 },
      });
      // The close arrives first, the open (smaller counts) afterwards and twice.
      await repository.store(INSTANCE, 'ssh-proxy-1', parseHistoryRecords([closed]));
      const opened = parseHistoryRecords([
        connection(1, { bytesFromClient: 10, rejectedRequests: { session: 1, x_late: 4 } }),
        channel(1, 1, 'a', { bytesFromClient: 100 }),
        channel(1, 2, 'b'),
        channel(1, 2, 'b', { closedAt: Date.now(), closeReason: 'closed', bytesToClient: 500 }),
        channel(1, 3, null, { result: 'rejected_permit', targetPort: 80, closedAt: Date.now() }),
      ]);
      await repository.store(INSTANCE, 'ssh-proxy-1', opened);
      await repository.store(INSTANCE, 'ssh-proxy-1', opened);

      const page = await sessions.list(testActor(alice), zSshSessionListQuery.parse({}));
      expect(page.items).toHaveLength(1);
      const [session] = page.items;
      expect(session).toMatchObject({
        closeReason: 'client_closed',
        peerIp: '192.0.2.10',
        bytesFromClient: 300,
        bytesToClient: 900,
        rejectedRequests: { rejected_permit: 1, session: 2, x_late: 4 },
      });
      expect(session!.targets.map((target) => target.serverSlug)).toEqual(['cpu-a', 'cpu-b']);

      const detail = await sessions.detail(testActor(alice), session!.id, undefined);
      expect(detail.channels.map((entry) => [entry.seq, entry.result, entry.closeReason])).toEqual([
        [1, 'opened', null],
        [2, 'opened', 'closed'],
        [3, 'rejected_permit', null],
      ]);
      expect(detail.channels[1]!.bytesToClient).toBe(500);
      expect(detail.unrecordedRejectedChannels).toBe(0);

      // Filters: by container (either one), by server, by state.
      const byContainer = await sessions.list(
        testActor(alice),
        zSshSessionListQuery.parse({ containerId: containerB }),
      );
      expect(byContainer.items).toHaveLength(1);
      expect((await sessions.list(
        testActor(alice),
        zSshSessionListQuery.parse({ containerId: randomUUID() }),
      )).items).toHaveLength(0);
      expect((await sessions.list(
        testActor(alice),
        zSshSessionListQuery.parse({ state: 'open' }),
      )).items).toHaveLength(0);
      expect((await sessions.list(
        testActor(bob, Role.UserAdmin),
        zSshSessionListQuery.parse({ scope: 'all', serverId: serverB }),
      )).items).toHaveLength(1);
    });
  });

  it('shows a user only their own connections; scope=all needs an operator', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new SshHistoryRepository(database);
      const sessions = new SshSessionsService(database);
      await repository.store(INSTANCE, 'ssh-proxy-1', parseHistoryRecords([
        connection(1),
        connection(2, { userId: bob, username: 'bob', login: 'bob' }),
      ]));
      const mine = await sessions.list(testActor(bob), zSshSessionListQuery.parse({}));
      expect(mine.items.map((item) => item.username)).toEqual(['bob']);
      const aliceSession = (await sessions.list(testActor(alice), zSshSessionListQuery.parse({}))).items[0]!;
      await expect(sessions.detail(testActor(bob), aliceSession.id, undefined))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(sessions.list(testActor(bob), zSshSessionListQuery.parse({ scope: 'all' })))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(() => zSshSessionListQuery.parse({ userId: alice })).toThrow();
      const all = await sessions.list(testActor(bob, Role.UserAdmin), zSshSessionListQuery.parse({ scope: 'all' }));
      expect(all.items).toHaveLength(2);
      const detail = await sessions.detail(testActor(bob, Role.UserAdmin), aliceSession.id, 'all');
      expect(detail.username).toBe('alice');
    });
  });

  it('pages by connection time with a cursor', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new SshHistoryRepository(database);
      const sessions = new SshSessionsService(database);
      const base = Date.now() - 3_600_000;
      await repository.store(INSTANCE, 'ssh-proxy-1', parseHistoryRecords(
        [1, 2, 3, 4, 5].map((seq) => connection(seq, { connectedAt: base + seq * 1000 })),
      ));
      const first = await sessions.list(testActor(alice), zSshSessionListQuery.parse({ limit: '2' }));
      const second = await sessions.list(
        testActor(alice),
        zSshSessionListQuery.parse({ limit: '2', cursor: first.nextCursor }),
      );
      const third = await sessions.list(
        testActor(alice),
        zSshSessionListQuery.parse({ limit: '2', cursor: second.nextCursor }),
      );
      const times = [...first.items, ...second.items, ...third.items].map((item) => item.connectedAt);
      expect(times).toEqual([...times].sort().reverse());
      expect(new Set(times).size).toBe(5);
      expect(third.nextCursor).toBeNull();
    });
  });

  it('checkpoints live byte counts and closes connections whose close never arrived as lost', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new SshHistoryRepository(database);
      await repository.store(INSTANCE, 'ssh-proxy-1', parseHistoryRecords([
        connection(1),
        channel(1, 1, 'a'),
        connection(2),
        connection(3),
      ]));
      await repository.store('ssh-proxy-2:bbbb', 'ssh-proxy-2', parseHistoryRecords([connection(1)]));
      await repository.checkpoint(INSTANCE, [{
        connectionSeq: 1,
        bytesFromClient: 70,
        bytesToClient: 80,
        channels: [{ channelSeq: 1, bytesFromClient: 60, bytesToClient: 70 }],
      }, { connectionSeq: 3, bytesFromClient: 0, bytesToClient: 0, channels: [] }], true);
      const rows = () => database.selectFrom('interaction.ssh_proxy_connections')
        .select(['proxy_instance', 'connection_seq', 'bytes_from_client', 'close_reason'])
        .orderBy('proxy_instance').orderBy('connection_seq')
        .execute();
      expect((await rows())[0]).toMatchObject({ bytes_from_client: '70', close_reason: null });

      // Unseen for a while: a complete report that no longer lists #2 closes it.
      await sql`UPDATE interaction.ssh_proxy_connections
        SET last_seen_at = now() - interval '20 minutes'`.execute(database);
      await repository.checkpoint(INSTANCE, [
        { connectionSeq: 1, bytesFromClient: 70, bytesToClient: 80, channels: [] },
        { connectionSeq: 3, bytesFromClient: 0, bytesToClient: 0, channels: [] },
      ], true);
      // The second proxy stopped reporting: its connection is lost too.
      await repository.closeLost([INSTANCE]);
      expect((await rows()).map((row) => [row.proxy_instance, row.connection_seq, row.close_reason])).toEqual([
        [INSTANCE, '1', null],
        [INSTANCE, '2', 'lost'],
        [INSTANCE, '3', null],
        ['ssh-proxy-2:bbbb', '1', 'lost'],
      ]);

      // The real close still arrives later: it replaces 'lost'.
      await repository.store(INSTANCE, 'ssh-proxy-1', parseHistoryRecords([
        connection(2, { closedAt: Date.now(), closeReason: 'disconnect_all' }),
        connection(1, { closedAt: Date.now() - 20 * 60_000, closeReason: 'revoked' }),
      ]));
      await repository.closeLost([INSTANCE]);
      const channelRow = await database.selectFrom('interaction.ssh_proxy_channels')
        .select(['close_reason', 'bytes_from_client']).executeTakeFirstOrThrow();
      expect(channelRow).toEqual({ close_reason: 'lost', bytes_from_client: '60' });
      expect((await rows()).map((row) => row.close_reason)).toEqual(['revoked', 'disconnect_all', null, 'lost']);
    });
  });

  it('counts refusals once per window and summarises them', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new SshHistoryRepository(database);
      const sessions = new SshSessionsService(database);
      const windowStart = Date.now() - 600_000;
      const frame = parseHistoryRecords([{
        type: 'refusals',
        seq: nextSeq++,
        windowStart,
        windowEnd: windowStart + 300_000,
        refusals: [
          { peerIp: '198.51.100.1', reason: 'public_key_rejected', count: 5 },
          { peerIp: '198.51.100.2', reason: 'no_auth', count: 1 },
          { peerIp: null, reason: 'no_auth', count: 7 },
        ],
      }]);
      await repository.store(INSTANCE, 'ssh-proxy-1', frame);
      await repository.store(INSTANCE, 'ssh-proxy-1', frame);
      const summary = await sessions.refusals(24);
      expect(summary.total).toBe(13);
      expect(summary.reasons).toEqual({ public_key_rejected: 5, no_auth: 8 });
      expect(summary.topSources[0]).toMatchObject({ peerIp: null, reason: 'no_auth', count: 7 });
      expect(summary.hourly.reduce((total, hour) => total + hour.count, 0)).toBe(13);
    });
  });

  it('folds expired connections into daily usage that the statistics keep counting', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new SshHistoryRepository(database);
      const sessions = new SshSessionsService(database);
      const old = Date.now() - 5 * 86_400_000;
      await repository.store(INSTANCE, 'ssh-proxy-1', parseHistoryRecords([
        connection(1, {
          connectedAt: old,
          authenticatedAt: old,
          closedAt: old + 1000,
          closeReason: 'client_closed',
          bytesFromClient: 100,
          bytesToClient: 200,
        }),
        channel(1, 1, 'a', { openedAt: old, closedAt: old + 1000, closeReason: 'closed', bytesFromClient: 100, bytesToClient: 200 }),
        connection(2, { bytesFromClient: 1, bytesToClient: 2, channelsRejected: 1, rejectedRequests: { remote_forward: 3 } }),
        channel(2, 1, 'b', { bytesFromClient: 1, bytesToClient: 2 }),
      ]));
      const before = await sessions.stats(testActor(alice), zSshSessionStatsQuery.parse({ days: '7' }));
      expect(await repository.foldExpired(new Date(Date.now() - 2 * 86_400_000))).toBe(1);
      const after = await sessions.stats(testActor(alice), zSshSessionStatsQuery.parse({ days: '7' }));
      expect(after.daily).toEqual(before.daily);
      expect(after.totals).toMatchObject({
        connections: 2,
        channels: 2,
        bytesFromClient: 101,
        bytesToClient: 202,
        users: 1,
        containers: 2,
      });
      expect(after.topContainers.map((entry) => [entry.containerName, entry.bytes])).toEqual([
        ['work', 300],
        ['train', 3],
      ]);
      // Close reasons and refused requests come from the remaining detail only.
      expect(after.closeReasons).toEqual({});
      expect(after.rejectedRequests).toEqual({ remote_forward: 3 });
      const byContainer = await sessions.stats(
        testActor(alice),
        zSshSessionStatsQuery.parse({ days: '7', containerId: containerA }),
      );
      expect(byContainer.totals).toMatchObject({ connections: 1, channels: 1, bytesFromClient: 100 });
      const remaining = await database.selectFrom('interaction.ssh_proxy_channels').select('channel_seq').execute();
      expect(remaining).toHaveLength(1);
    });
  });
});
