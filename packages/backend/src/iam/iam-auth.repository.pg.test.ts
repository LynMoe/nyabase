import { randomUUID } from 'node:crypto';
import { Role, UserStatus } from '@nyabase/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { seedUser } from './access.pg-test-helper.js';
import type { RefreshRotationInput } from './auth-persistence.js';
import { refreshAncestorMinimumAgeMs, REFRESH_RETAINED_ANCESTORS } from './auth.service.js';
import { IamAuthRepository } from './iam-auth.repository.js';

const hex = (digit: string): string => digit.repeat(64);
const DAY = 86_400_000;

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function rotation(
  hash: string,
  requestIdHash: string,
  successor: string,
  overrides: Partial<RefreshRotationInput> = {},
): RefreshRotationInput {
  return {
    hash,
    requestIdHash,
    idleMs: 7 * DAY,
    absoluteMs: 30 * DAY,
    reuseGraceMs: 15_000,
    retainedAncestors: REFRESH_RETAINED_ANCESTORS,
    ancestorMinimumAgeMs: refreshAncestorMinimumAgeMs(15 * 60_000),
    maximumSessions: 5,
    successorHash: () => successor,
    ...overrides,
  };
}

async function sessionWithToken(
  database: Kysely<NyabaseDatabase>,
  hash: string,
): Promise<{ repository: IamAuthRepository; userId: string; sessionId: string }> {
  const repository = new IamAuthRepository(database, new PgTransactionManager(database));
  const userId = await seedUser(database, `user-${randomUUID().slice(0, 8)}`, UserStatus.Active, Role.User);
  const sessionId = randomUUID();
  await repository.issueRefreshSession(userId, { id: sessionId, hash, expiresInMs: 7 * DAY }, 5);
  return { repository, userId, sessionId };
}

async function sessionRows(database: Kysely<NyabaseDatabase>, sessionId: string) {
  const tokens = await database.selectFrom('iam.refresh_tokens')
    .selectAll().where('id', '=', sessionId).execute();
  const ancestors = await database.selectFrom('iam.refresh_token_ancestors')
    .select('hash').where('session_id', '=', sessionId).orderBy('hash').execute();
  return { token: tokens[0], ancestors: ancestors.map((row) => row.hash.trim()) };
}

describePg('IamAuthRepository role loading', () => {
  it('carries the current role on every authentication path', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new IamAuthRepository(database, new PgTransactionManager(database));
      const userId = await seedUser(database, 'role-user', UserStatus.Active, Role.UserAdmin);

      // JWT path: the guard resolves the user by id on every request.
      await expect(repository.findUserById(userId)).resolves.toMatchObject({ role: Role.UserAdmin });
      await expect(repository.findUserByUsername('role-user')).resolves.toMatchObject({ role: Role.UserAdmin });

      // Refresh rotation returns the user row too.
      await repository.issueRefreshSession(userId, { id: randomUUID(), hash: hex('1'), expiresInMs: 60_000 }, 5);
      const rotated = await repository.rotateRefreshSession(rotation(hex('1'), hex('3'), hex('2')));
      expect(rotated).toMatchObject({ kind: 'rotated', user: { role: Role.UserAdmin } });

      // A role change is visible on the very next read: no auth_version bump needed.
      await database.updateTable('iam.users').set({ role: Role.Admin }).where('id', '=', userId).execute();
      await expect(repository.findUserById(userId)).resolves.toMatchObject({ role: Role.Admin, authVersion: 0 });
    });
  });
});

describePg('IamAuthRepository refresh session lifetime', () => {
  it('keeps the login time across rotations and caps expiry at the absolute lifetime', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, sessionId } = await sessionWithToken(database, hex('1'));
      // Logged in 29 days and 23 hours ago: one hour of absolute lifetime left.
      await sql`UPDATE iam.refresh_tokens
        SET created_at = clock_timestamp() - interval '29 days 23 hours'
        WHERE id = ${sessionId}`.execute(database);
      const before = await sessionRows(database, sessionId);

      const rotated = await repository.rotateRefreshSession(rotation(hex('1'), hex('a'), hex('2')));
      expect(rotated.kind).toBe('rotated');
      const expiresInMs = rotated.kind === 'rotated' ? rotated.expiresInMs : 0;
      expect(expiresInMs).toBeGreaterThan(3_500_000);
      expect(expiresInMs).toBeLessThanOrEqual(3_600_000);
      const after = await sessionRows(database, sessionId);
      expect(after.token?.created_at).toEqual(before.token?.created_at);
      expect(after.token!.expires_at.getTime()).toBe(
        before.token!.created_at.getTime() + 30 * DAY,
      );
    });
  });

  it('refuses and deletes a session past its absolute lifetime even if recently refreshed', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, sessionId } = await sessionWithToken(database, hex('1'));
      await sql`UPDATE iam.refresh_tokens
        SET created_at = clock_timestamp() - interval '31 days'
        WHERE id = ${sessionId}`.execute(database);

      await expect(repository.rotateRefreshSession(rotation(hex('1'), hex('a'), hex('2'))))
        .resolves.toEqual({ kind: 'invalid' });
      expect((await sessionRows(database, sessionId)).token).toBeUndefined();
    });
  });
});

describePg('IamAuthRepository refresh token reuse', () => {
  it('revokes the whole session when a rotated-out token is presented again', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, userId, sessionId } = await sessionWithToken(database, hex('1'));
      await repository.rotateRefreshSession(rotation(hex('1'), hex('a'), hex('2')));
      await repository.rotateRefreshSession(rotation(hex('2'), hex('b'), hex('3')));
      expect((await sessionRows(database, sessionId)).ancestors).toEqual([hex('1'), hex('2')]);

      // T1 is two rotations old: no grace, no recovery; this is reuse.
      const onReuse = vi.fn(async () => undefined);
      await expect(repository.rotateRefreshSession(
        rotation(hex('1'), hex('c'), hex('4'), { onReuse }),
      )).resolves.toEqual({ kind: 'reused', userId, sessionId });
      expect(onReuse).toHaveBeenCalledWith(expect.anything(), { userId, sessionId });
      expect(await sessionRows(database, sessionId)).toEqual({ token: undefined, ancestors: [] });

      // The current token died with the session.
      await expect(repository.rotateRefreshSession(rotation(hex('3'), hex('d'), hex('5'))))
        .resolves.toEqual({ kind: 'invalid' });
    });
  });

  it('treats the previous token with another request id as reuse once the grace window has passed', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, sessionId } = await sessionWithToken(database, hex('1'));
      await repository.rotateRefreshSession(rotation(hex('1'), hex('a'), hex('2')));
      await sql`UPDATE iam.refresh_tokens
        SET rotated_at = clock_timestamp() - interval '1 minute'
        WHERE id = ${sessionId}`.execute(database);

      await expect(repository.rotateRefreshSession(rotation(hex('1'), hex('b'), hex('3'))))
        .resolves.toMatchObject({ kind: 'reused', sessionId });
      expect((await sessionRows(database, sessionId)).token).toBeUndefined();
    });
  });

  it('recovers the exact retry of a lost response at any time without revoking', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, sessionId } = await sessionWithToken(database, hex('1'));
      await repository.rotateRefreshSession(rotation(hex('1'), hex('a'), hex('2')));
      await sql`UPDATE iam.refresh_tokens
        SET rotated_at = clock_timestamp() - interval '1 hour'
        WHERE id = ${sessionId}`.execute(database);

      await expect(repository.rotateRefreshSession(rotation(hex('1'), hex('a'), hex('2'))))
        .resolves.toMatchObject({ kind: 'recovered', sessionId });
      expect((await sessionRows(database, sessionId)).token?.hash).toBe(hex('2'));
    });
  });

  it('lets one of two concurrent refreshes win and refuses the other without revoking', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, sessionId } = await sessionWithToken(database, hex('1'));

      const results = await Promise.all([
        repository.rotateRefreshSession(rotation(hex('1'), hex('a'), hex('2'))),
        repository.rotateRefreshSession(rotation(hex('1'), hex('b'), hex('3'))),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(['rotated', 'superseded']);
      const winner = results.find((result) => result.kind === 'rotated');
      expect(winner).toBeDefined();
      const { token } = await sessionRows(database, sessionId);
      expect([hex('2'), hex('3')]).toContain(token?.hash);

      // The winner's successor keeps working.
      await expect(repository.rotateRefreshSession(rotation(token!.hash, hex('c'), hex('4'))))
        .resolves.toMatchObject({ kind: 'rotated', sessionId });
    });
  });

  it('ignores hashes that no session ever issued', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, sessionId } = await sessionWithToken(database, hex('1'));
      await expect(repository.rotateRefreshSession(rotation(hex('9'), hex('a'), hex('2'))))
        .resolves.toEqual({ kind: 'invalid' });
      expect((await sessionRows(database, sessionId)).token?.hash).toBe(hex('1'));
    });
  });
});

describePg('IamAuthRepository bounded ancestors', () => {
  const window = { retainedAncestors: 2, ancestorMinimumAgeMs: 60_000 };
  const age = (database: Kysely<NyabaseDatabase>, sessionId: string) => sql`
    UPDATE iam.refresh_token_ancestors
    SET retired_at = retired_at - interval '1 hour'
    WHERE session_id = ${sessionId}`.execute(database);

  it('keeps only the newest ancestors; a forgotten token is invalid, not reuse', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, sessionId } = await sessionWithToken(database, hex('1'));
      await repository.rotateRefreshSession(rotation(hex('1'), hex('a'), hex('2'), window));
      await repository.rotateRefreshSession(rotation(hex('2'), hex('b'), hex('3'), window));
      await age(database, sessionId);
      await expect(repository.rotateRefreshSession(rotation(hex('3'), hex('c'), hex('4'), window)))
        .resolves.toMatchObject({ kind: 'rotated' });
      expect((await sessionRows(database, sessionId)).ancestors).toEqual([hex('2'), hex('3')]);

      const onReuse = vi.fn(async () => undefined);
      await expect(repository.rotateRefreshSession(
        rotation(hex('1'), hex('d'), hex('5'), { ...window, onReuse }),
      )).resolves.toEqual({ kind: 'invalid' });
      expect(onReuse).not.toHaveBeenCalled();
      expect((await sessionRows(database, sessionId)).token?.hash).toBe(hex('4'));
      // A retained one still is reuse.
      await expect(repository.rotateRefreshSession(rotation(hex('2'), hex('d'), hex('5'), window)))
        .resolves.toMatchObject({ kind: 'reused', sessionId });
    });
  });

  it('refuses a rotation that would forget a recently retired token', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, sessionId } = await sessionWithToken(database, hex('1'));
      await repository.rotateRefreshSession(rotation(hex('1'), hex('a'), hex('2'), window));
      await repository.rotateRefreshSession(rotation(hex('2'), hex('b'), hex('3'), window));
      const throttled = await repository.rotateRefreshSession(rotation(hex('3'), hex('c'), hex('4'), window));
      expect(throttled).toEqual({ kind: 'throttled', retryAfterMs: expect.any(Number) });
      // Until the oldest retained ancestor (retired just now) is a window old.
      const { retryAfterMs } = throttled as { retryAfterMs: number };
      expect(retryAfterMs).toBeGreaterThan(50_000);
      expect(retryAfterMs).toBeLessThanOrEqual(60_000);
      // Nothing changed: same current token, same ancestors.
      expect(await sessionRows(database, sessionId)).toMatchObject({
        token: { hash: hex('3') },
        ancestors: [hex('1'), hex('2')],
      });
    });
  });

  it('logs out by the current token or any retained ancestor', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, userId, sessionId } = await sessionWithToken(database, hex('1'));
      await repository.rotateRefreshSession(rotation(hex('1'), hex('a'), hex('2')));
      await repository.rotateRefreshSession(rotation(hex('2'), hex('b'), hex('3')));
      await expect(repository.deleteRefreshSessionByCurrentOrRetiredHash(hex('9')))
        .resolves.toBeNull();
      const onDeleted = vi.fn(async () => undefined);
      await expect(repository.deleteRefreshSessionByCurrentOrRetiredHash(hex('1'), onDeleted))
        .resolves.toEqual({ userId, sessionId });
      expect(onDeleted).toHaveBeenCalledWith(expect.anything(), userId);
      expect(await sessionRows(database, sessionId)).toEqual({ token: undefined, ancestors: [] });
    });
  });

  it('finds a live session only for its owner and until it idles out or is deleted', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, userId, sessionId } = await sessionWithToken(database, hex('1'));
      const live = await repository.findLiveRefreshSession(userId, sessionId);
      expect(live?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
      expect(live?.createdAt).toBeInstanceOf(Date);
      await expect(repository.findLiveRefreshSession(randomUUID(), sessionId)).resolves.toBeNull();
      await expect(repository.findLiveRefreshSession(userId, randomUUID())).resolves.toBeNull();

      await database.updateTable('iam.refresh_tokens')
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .where('id', '=', sessionId)
        .execute();
      await expect(repository.findLiveRefreshSession(userId, sessionId)).resolves.toBeNull();

      const other = await sessionWithToken(database, hex('2'));
      await repository.deleteRefreshSessionByCurrentOrRetiredHash(hex('2'));
      await expect(repository.findLiveRefreshSession(other.userId, other.sessionId)).resolves.toBeNull();
    });
  });

  it('loads the user behind an access token only while its session is live', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository, userId, sessionId } = await sessionWithToken(database, hex('1'));
      await expect(repository.findSessionUser(userId, sessionId)).resolves.toMatchObject({ id: userId });
      await repository.rotateRefreshSession(rotation(hex('1'), hex('a'), hex('3')));
      await expect(repository.findSessionUser(userId, sessionId)).resolves.toMatchObject({ id: userId });

      const other = await sessionWithToken(database, hex('2'));
      await expect(repository.findSessionUser(other.userId, sessionId)).resolves.toBeNull();
      await expect(repository.findSessionUser(userId, other.sessionId)).resolves.toBeNull();
      await expect(repository.findSessionUser(userId, randomUUID())).resolves.toBeNull();

      await database.updateTable('iam.refresh_tokens')
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .where('id', '=', sessionId)
        .execute();
      await expect(repository.findSessionUser(userId, sessionId)).resolves.toBeNull();
    });
  });
});
