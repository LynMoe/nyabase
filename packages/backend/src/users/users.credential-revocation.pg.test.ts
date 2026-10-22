import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@nyabase/common';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { AccessChangeNotifier, AccessResolverService } from '../iam/access-resolver.service.js';
import type { Actor } from '../iam/actor.js';
import { testActor } from '../iam/actor.test-helper.js';
import { AuthService } from '../iam/auth.service.js';
import { IamAuthRepository } from '../iam/iam-auth.repository.js';
import { SessionRevocationService } from '../iam/session-revocation.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { MonotonicClock } from '../platform/monotonic-clock.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { UsersService } from './users.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('credential revocation on password change, reset and account changes', () => {
  it('deletes API tokens and refresh sessions when an admin resets the password', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const context = await setup(database);
      const secret = await context.mintToken();
      await context.auth.login({ id: context.user.id });

      await context.users.updateUser(context.user.id, { password: 'reset-password-1' }, context.admin.id);

      expect(await context.credentialCounts()).toEqual({ apiTokens: 0, refreshTokens: 0 });
      await expect(context.auth.validateApiToken(secret)).resolves.toBeNull();
      expect(context.revoked).toEqual([context.user.id]);
    });
  });

  it('deletes API tokens and refresh sessions when the user changes their own password', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const context = await setup(database);
      const secret = await context.mintToken();
      await context.auth.login({ id: context.user.id });

      await context.users.updateSelf(context.user.id, { password: 'changed-password-1' }, 'user-password-1');

      expect(await context.credentialCounts()).toEqual({ apiTokens: 0, refreshTokens: 0 });
      await expect(context.auth.validateApiToken(secret)).resolves.toBeNull();
      expect(context.revoked).toEqual([context.user.id]);
    });
  });

  it('signals revocation after commit for disable, role change and deletion, never on rollback', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const context = await setup(database);

      await context.users.updateUser(context.user.id, { displayName: 'Renamed' }, context.admin.id);
      expect(context.revoked).toEqual([]);

      await context.users.updateUser(context.user.id, { role: Role.Operator }, context.admin.id);
      expect(context.revoked).toEqual([context.user.id]);
      await context.users.updateUser(context.user.id, { status: UserStatus.Disabled }, context.admin.id);
      expect(context.revoked).toEqual([context.user.id, context.user.id]);

      // The last active administrator cannot be demoted: the transaction rolls back.
      await expect(context.users.updateUser(context.admin.id, { role: Role.User }, context.admin.id))
        .rejects.toBeDefined();
      expect(context.revoked).not.toContain(context.admin.id);

      await context.users.deleteUserPermanently(context.adminActor, context.user.id);
      expect(context.revoked).toEqual([context.user.id, context.user.id, context.user.id]);
    });
  });
});

async function setup(database: Kysely<NyabaseDatabase>) {
  const transactions = new PgTransactionManager(database);
  const audit = { append: async (..._args: unknown[]) => undefined };
  const config = {
    get<T>(key: string): T {
      const values: Record<string, unknown> = {
        'runtime.nodeEnv': 'test',
        'auth.jwtSecret': 'revocation-jwt-secret-revocation-jwt-secret',
        'auth.refreshTokenExpiresDays': 7,
      };
      return values[key] as T;
    },
  };
  const auth = new AuthService(
    new IamAuthRepository(database, transactions),
    new JwtService({ secret: config.get<string>('auth.jwtSecret'), signOptions: { expiresIn: '15m' } }),
    config as never,
    audit as never,
    new MonotonicClock(),
  );
  const sessions = new SessionRevocationService();
  const revoked: string[] = [];
  sessions.subscribe((userId) => revoked.push(userId));
  const users = new UsersService(
    database,
    transactions,
    auth,
    new AccessResolverService(database, transactions),
    { notify: async () => undefined } as never,
    config as never,
    audit as never,
    new AccessChangeNotifier(),
    sessions,
  );
  const admin = await users.createUser({
    username: 'root-admin', password: 'admin-password-1', displayName: 'Admin', role: Role.Admin,
  });
  const user = await users.createUser({
    username: 'alice', password: 'user-password-1', displayName: 'Alice',
  });
  const userActor: Actor = { userId: user.id, role: Role.User, authKind: 'jwt', authVersion: 0 };
  return {
    auth,
    users,
    admin,
    user,
    revoked,
    adminActor: testActor(admin.id, Role.Admin),
    async mintToken(): Promise<string> {
      return (await auth.createApiToken(userActor, 'ci', 'user-password-1')).secret;
    },
    async credentialCounts() {
      const [apiTokens, refreshTokens] = await Promise.all([
        database.selectFrom('iam.api_tokens').select('id').where('user_id', '=', user.id).execute(),
        database.selectFrom('iam.refresh_tokens').select('id').where('user_id', '=', user.id).execute(),
      ]);
      return { apiTokens: apiTokens.length, refreshTokens: refreshTokens.length };
    },
  };
}
