import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@nyabase/common';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
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
import { UserSshKeysService } from './user-ssh-keys.service.js';
import { UsersService } from './users.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

const SSH_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3';

describePg('credential revocation on password change, reset and account changes', () => {
  it('ends refresh sessions but keeps SSH keys when an admin resets the password', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const context = await setup(database);
      await context.addKey();
      await context.auth.login({ id: context.user.id });

      await context.users.updateUser(context.user.id, { password: 'reset-password-1' }, context.admin.id);

      expect(await context.credentialCounts()).toEqual({ refreshTokens: 0, sshKeys: 1 });
      expect(context.revoked).toEqual([context.user.id]);
    });
  });

  it('ends refresh sessions but keeps SSH keys when the user changes their own password', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const context = await setup(database);
      await context.addKey();
      await context.auth.login({ id: context.user.id });

      await context.users.updateSelf(context.user.id, { password: 'changed-password-1' }, 'user-password-1');

      expect(await context.credentialCounts()).toEqual({ refreshTokens: 0, sshKeys: 1 });
      expect(context.revoked).toEqual([context.user.id]);
    });
  });

  it('adds an SSH key only after proving the current password', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const context = await setup(database);

      await expect(context.sshKeys.addSshKey(context.userActor, 'k', SSH_KEY, 'wrong-password'))
        .rejects.toMatchObject({ response: { code: 'CURRENT_PASSWORD_INCORRECT' } });
      expect((await context.credentialCounts()).sshKeys).toBe(0);

      await context.addKey();
      expect((await context.credentialCounts()).sshKeys).toBe(1);
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
  const convergence = { reconcileUser: vi.fn().mockResolvedValue(undefined) };
  const sshKeys = new UserSshKeysService(
    database,
    transactions,
    convergence as never,
    { notify: async () => undefined } as never,
    audit as never,
    auth,
  );
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
    sshKeys,
    userActor,
    adminActor: testActor(admin.id, Role.Admin),
    async addKey(): Promise<void> {
      await sshKeys.addSshKey(userActor, 'laptop', SSH_KEY, 'user-password-1');
    },
    async credentialCounts() {
      const [refreshTokens, sshKeys] = await Promise.all([
        database.selectFrom('iam.refresh_tokens').select('id').where('user_id', '=', user.id).execute(),
        database.selectFrom('iam.ssh_public_keys').select('id').where('user_id', '=', user.id).execute(),
      ]);
      return { refreshTokens: refreshTokens.length, sshKeys: sshKeys.length };
    },
  };
}
