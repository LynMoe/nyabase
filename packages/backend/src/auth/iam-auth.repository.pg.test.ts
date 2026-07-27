import { createHash, randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import {
  AuthService,
  MAX_REFRESH_SESSIONS_PER_USER,
} from './auth.service.js';
import { IamAuthRepository } from './iam-auth.repository.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('PostgreSQL IAM authentication integration', () => {
  it('enforces single-winner refresh rotation and exact same-request recovery', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      await insertUser(database, userId, 'alice');
      const repository = new IamAuthRepository(database, new PgTransactionManager(database));
      const service = authService(repository);
      const issued = await service.login({ id: userId });

      const rotations = await Promise.allSettled([
        service.refreshTokens(issued.refreshToken, '1'.repeat(64)),
        service.refreshTokens(issued.refreshToken, '2'.repeat(64)),
      ]);
      expect(rotations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(rotations.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const selected = rotations.find(
        (result): result is PromiseFulfilledResult<{
          accessToken: string;
          refreshToken: string;
        }> => result.status === 'fulfilled',
      )!;
      const winnerRequest = rotations[0].status === 'fulfilled'
        ? '1'.repeat(64)
        : '2'.repeat(64);
      await expect(service.refreshTokens(issued.refreshToken, winnerRequest))
        .resolves.toEqual(selected.value);
      const stored = await database
        .selectFrom('iam.refresh_tokens')
        .select(['hash', 'previous_hash'])
        .execute();
      expect(stored).toHaveLength(1);
      expect(stored[0].previous_hash).not.toBeNull();
    });
  });

  it('rejects a refresh waiter whose row expires while blocked on its lock', async () => {
    await withPostgresTestDatabase(async ({ database, pool }) => {
      const userId = randomUUID();
      await insertUser(database, userId, 'expirywaiter');
      const repository = new IamAuthRepository(database, new PgTransactionManager(database));
      const service = authService(repository);
      const issued = await service.login({ id: userId });
      const hash = createHash('sha256').update(issued.refreshToken).digest('hex');
      await database.updateTable('iam.refresh_tokens')
        .set({ expires_at: new Date(Date.now() + 250) })
        .where('hash', '=', hash)
        .execute();

      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT id FROM iam.refresh_tokens WHERE hash = $1 FOR UPDATE',
          [hash],
        );
        const waiting = service.refreshTokens(issued.refreshToken, 'e'.repeat(64));
        await new Promise((resolve) => setTimeout(resolve, 400));
        await blocker.query('COMMIT');
        await expect(waiting).rejects.toBeInstanceOf(UnauthorizedException);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
      }
    });
  });

  it('serializes per-user PAT capacity and fails closed after user disable', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      await insertUser(database, userId, 'bob');
      const repository = new IamAuthRepository(database, new PgTransactionManager(database));
      const now = new Date();

      const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        repository.createApiToken(userId, {
          id: randomUUID(),
          userId,
          name: `token-${index}`,
          hash: index.toString(16).padStart(64, '0'),
          lastUsedAt: null,
          createdAt: now,
        }, 1)));
      expect(attempts.filter((result) => result === 'created')).toHaveLength(1);
      expect(await database.selectFrom('iam.api_tokens')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow()).toMatchObject({ count: '1' });

      const created = await database.selectFrom('iam.api_tokens')
        .select('hash')
        .executeTakeFirstOrThrow();
      await database.updateTable('iam.users')
        .set({ status: UserStatus.Disabled, auth_version: 1 })
        .where('id', '=', userId)
        .execute();
      await expect(repository.validateApiToken(created.hash, new Date(), 0))
        .resolves.toBeNull();
      await expect(authService(repository).login({ id: userId }))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  it('rolls back login, API-token, and logout mutations when required audit fails', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      await insertUser(database, userId, 'auditatomic');
      const repository = new IamAuthRepository(database, new PgTransactionManager(database));
      const audit = { append: vi.fn().mockRejectedValue(new Error('audit unavailable')) };
      const service = authService(repository, audit);

      await expect(service.login({ id: userId })).rejects.toThrow('audit unavailable');
      expect(await database.selectFrom('iam.refresh_tokens').select('id').execute()).toEqual([]);

      await expect(service.createApiToken(userId, 'automation'))
        .rejects.toThrow('audit unavailable');
      expect(await database.selectFrom('iam.api_tokens').select('id').execute()).toEqual([]);

      audit.append.mockResolvedValueOnce(undefined);
      const issued = await service.login({ id: userId });
      expect(await database.selectFrom('iam.refresh_tokens').select('id').execute())
        .toHaveLength(1);
      audit.append.mockRejectedValueOnce(new Error('audit unavailable'));
      await expect(service.logout(issued.refreshToken)).rejects.toThrow('audit unavailable');
      expect(await database.selectFrom('iam.refresh_tokens').select('id').execute())
        .toHaveLength(1);
    });
  });

  it('bounds opportunistic global refresh cleanup on the login hot path', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      await insertUser(database, userId, 'boundedcleanup');
      const expiredAt = new Date(Date.now() - 60_000);
      await database.insertInto('iam.refresh_tokens')
        .values(Array.from({ length: 300 }, (_, index) => ({
          id: randomUUID(),
          user_id: userId,
          hash: index.toString(16).padStart(64, '0'),
          previous_hash: null,
          previous_request_id_hash: null,
          expires_at: expiredAt,
          revoked: false,
          created_at: expiredAt,
        })))
        .execute();

      const repository = new IamAuthRepository(
        database,
        new PgTransactionManager(database),
      );
      await expect(authService(repository).login({ id: userId })).resolves.toBeDefined();

      const remainingExpired = await database.selectFrom('iam.refresh_tokens')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('expires_at', '<=', new Date())
        .executeTakeFirstOrThrow();
      expect(Number(remainingExpired.count)).toBe(172);
      expect(await database.selectFrom('iam.refresh_tokens')
        .select('id')
        .where('expires_at', '>', new Date())
        .execute()).toHaveLength(1);
    });
  });

  it('uses the PostgreSQL clock for issuance, cleanup, TTL, and trim under app skew', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const otherUserId = randomUUID();
      await insertUser(database, userId, 'clockskew');
      await insertUser(database, otherUserId, 'clockskewother');
      const clock = await database.selectNoFrom((expression) =>
        expression.fn<Date>('clock_timestamp').as('now'))
        .executeTakeFirstOrThrow();
      const existing = Array.from(
        { length: MAX_REFRESH_SESSIONS_PER_USER },
        (_, index) => ({
          id: randomUUID(),
          user_id: userId,
          hash: (index + 1_000).toString(16).padStart(64, '0'),
          previous_hash: null,
          previous_request_id_hash: null,
          expires_at: new Date(clock.now.getTime() + 3_600_000),
          revoked: false,
          created_at: new Date(clock.now.getTime() - 60_000 + index),
        }),
      );
      const otherTokenId = randomUUID();
      await database.insertInto('iam.refresh_tokens').values([
        ...existing,
        {
          id: otherTokenId,
          user_id: otherUserId,
          hash: 'f'.repeat(64),
          previous_hash: null,
          previous_request_id_hash: null,
          // Valid by the authoritative DB clock, but expired according to a
          // process whose application clock is 60 seconds fast.
          expires_at: new Date(clock.now.getTime() + 30_000),
          revoked: false,
          created_at: clock.now,
        },
      ]).execute();

      const repository = new IamAuthRepository(
        database,
        new PgTransactionManager(database),
      );
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(clock.now.getTime() + 60_000));
      let issued: Awaited<ReturnType<AuthService['login']>>;
      try {
        issued = await authService(repository).login({ id: userId });
      } finally {
        vi.useRealTimers();
      }

      expect(await database.selectFrom('iam.refresh_tokens')
        .select('id')
        .where('id', '=', otherTokenId)
        .executeTakeFirst()).toEqual({ id: otherTokenId });
      const ownRows = await database.selectFrom('iam.refresh_tokens')
        .select(['hash', 'created_at', 'expires_at'])
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .execute();
      expect(ownRows).toHaveLength(MAX_REFRESH_SESSIONS_PER_USER);
      expect(ownRows.some((row) => row.hash === existing[0]!.hash)).toBe(false);
      const issuedHash = createHash('sha256')
        .update(issued.refreshToken)
        .digest('hex');
      const inserted = ownRows.find((row) => row.hash === issuedHash);
      expect(inserted).toBeDefined();
      expect(inserted!.expires_at.getTime() - inserted!.created_at.getTime())
        .toBe(30 * 86_400_000);
      expect(inserted!.created_at.getTime()).toBeLessThan(
        clock.now.getTime() + 10_000,
      );
    });
  });

  it('rejects malformed system-group identity and duplicate memberships in SQL', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const groupId = randomUUID();
      await insertUser(database, userId, 'charlie');
      await expect(database.insertInto('iam.groups').values({
        id: groupId,
        name: 'Broken system group',
        description: null,
        priority: 1,
        is_system: true,
        system_key: null,
        capabilities: [],
        revision: 1,
      }).execute()).rejects.toMatchObject({ code: '23514' });

      await database.insertInto('iam.groups').values({
        id: groupId,
        name: 'Users',
        description: null,
        priority: 10,
        is_system: true,
        system_key: 'users',
        capabilities: [],
        revision: 1,
      }).execute();
      await database.insertInto('iam.group_members').values({
        id: randomUUID(),
        group_id: groupId,
        user_id: userId,
      }).execute();
      await expect(database.insertInto('iam.group_members').values({
        id: randomUUID(),
        group_id: groupId,
        user_id: userId,
      }).execute()).rejects.toMatchObject({ code: '23505' });
    });
  });
});

function authService(
  repository: IamAuthRepository,
  audit: { append: ReturnType<typeof vi.fn> } = {
    append: vi.fn().mockResolvedValue(undefined),
  },
): AuthService {
  return new AuthService(
    repository,
    new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } }),
    {
      get: vi.fn((key: string) => key === 'auth.jwtSecret' ? 'test-secret' : 30),
    } as never,
    audit as never,
  );
}

async function insertUser(
  database: Parameters<typeof withPostgresTestDatabase>[0] extends
    (fixture: infer Fixture) => Promise<unknown>
    ? Fixture extends { database: infer Database } ? Database : never
    : never,
  id: string,
  username: string,
): Promise<void> {
  await database.insertInto('iam.users').values({
    id,
    numeric_id: username.length + 1_000,
    username,
    password_hash: 'unused',
    display_name: username,
    status: UserStatus.Active,
    auth_version: 0,
    authz_version: 0,
  }).execute();
}
