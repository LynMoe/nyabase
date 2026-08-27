import { JwtService } from '@nestjs/jwt';
import { SystemGroupKey, UserStatus } from '@nyabase/common';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { AccessCacheEpochService } from './access/access-cache-epoch.service.js';
import { AccessResolverService } from './access/access-resolver.service.js';
import { AccessRevocationGuardService } from './access/access-revocation-guard.service.js';
import { AuthService } from './auth/auth.service.js';
import { GroupsService } from './groups/groups.service.js';
import { IamAuthRepository } from './auth/iam-auth.repository.js';
import type { NyabaseDatabase } from './persistence-pg/database.types.js';
import { PgTransactionManager } from './persistence-pg/transaction.js';
import { withPostgresTestDatabase } from './persistence-pg/postgres-test-harness.js';
import { AppService } from './app.service.js';
import { UsersService } from './users/users.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('API IAM bootstrap', () => {
  it('creates login-ready IAM state, is idempotent, and converges concurrent API replicas', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const first = createBootstrapContext(database, 'api');
      const second = createBootstrapContext(database, 'api');

      await Promise.all([
        first.app.onApplicationBootstrap(),
        second.app.onApplicationBootstrap(),
      ]);

      const groups = await database.selectFrom('iam.groups')
        .select(['id', 'system_key'])
        .orderBy('system_key')
        .execute();
      expect(groups).toHaveLength(3);
      expect(groups.map((group) => group.system_key)).toEqual([
        SystemGroupKey.Administrators,
        SystemGroupKey.Operators,
        SystemGroupKey.Users,
      ]);

      const admin = await database.selectFrom('iam.users')
        .select(['id', 'username', 'status'])
        .where('username', '=', 'admin')
        .executeTakeFirstOrThrow();
      expect(admin.status).toBe(UserStatus.Active);
      await expect(database.selectFrom('iam.group_members as member')
        .innerJoin('iam.groups as group', 'group.id', 'member.group_id')
        .select('member.id')
        .where('member.user_id', '=', admin.id)
        .where('group.system_key', '=', SystemGroupKey.Administrators)
        .execute()).resolves.toHaveLength(1);

      const login = await first.auth.authenticateAndLogin(
        'admin',
        'bootstrap-password',
        '127.0.0.1',
      );
      expect(login.accessToken).toEqual(expect.any(String));
      expect(login.refreshToken).toEqual(expect.any(String));

      const before = await bootstrapCounts(database);
      await first.app.onApplicationBootstrap();
      const after = await bootstrapCounts(database);
      expect(after).toEqual(before);
    });
  });

  it('does not seed IAM state in the worker role', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const worker = createBootstrapContext(database, 'worker');

      await worker.app.onApplicationBootstrap();

      await expect(database.selectFrom('iam.users').select('id').execute()).resolves.toHaveLength(0);
      await expect(database.selectFrom('iam.groups').select('id').execute()).resolves.toHaveLength(0);
    });
  });
});

function createBootstrapContext(
  database: Kysely<NyabaseDatabase>,
  role: 'api' | 'worker',
): {
  app: AppService;
  auth: AuthService;
} {
  const transactions = new PgTransactionManager(database);
  const access = new AccessResolverService(
    database,
    transactions,
    new AccessCacheEpochService(database),
  );
  const audit = {
    append: async (..._args: unknown[]) => undefined,
  };
  const config = {
    get<T>(key: string): T {
      const values: Record<string, unknown> = {
        'runtime.nodeEnv': 'test',
        'auth.adminInitPassword': 'bootstrap-password',
        'auth.jwtSecret': 'bootstrap-jwt-secret-bootstrap-jwt-secret',
        'auth.refreshTokenExpiresDays': 7,
      };
      return values[key] as T;
    },
  };
  const auth = new AuthService(
    new IamAuthRepository(database, transactions),
    new JwtService({
      secret: config.get<string>('auth.jwtSecret'),
      signOptions: { expiresIn: '15m' },
    }),
    config as never,
    audit as never,
  );
  const users = new UsersService(
    database,
    transactions,
    auth,
    access,
    { reconcileUser: async () => undefined } as never,
    { notify: async () => undefined } as never,
    config as never,
    audit as never,
  );
  const groups = new GroupsService(
    database,
    transactions,
    access,
    audit as never,
    new AccessRevocationGuardService(),
  );
  const app = new AppService(
    {
      servesApi: () => role === 'api',
    } as never,
    groups,
    users,
  );
  return { app, auth };
}

async function bootstrapCounts(database: Kysely<NyabaseDatabase>): Promise<{
  users: number;
  groups: number;
  memberships: number;
}> {
  const [users, groups, memberships] = await Promise.all([
    database.selectFrom('iam.users').select('id').execute(),
    database.selectFrom('iam.groups').select('id').execute(),
    database.selectFrom('iam.group_members').select('id').execute(),
  ]);
  return {
    users: users.length,
    groups: groups.length,
    memberships: memberships.length,
  };
}

