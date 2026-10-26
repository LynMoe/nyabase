import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@nyabase/common';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { AccessChangeNotifier, AccessResolverService } from '../iam/access-resolver.service.js';
import { AuthService } from '../iam/auth.service.js';
import { SessionRevocationService } from '../iam/session-revocation.service.js';
import { IamAuthRepository } from '../iam/iam-auth.repository.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { MonotonicClock } from '../platform/monotonic-clock.js';
import { IamBootstrapService } from './iam-bootstrap.service.js';
import { UsersService } from './users.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('API IAM bootstrap', () => {
  it('creates login-ready IAM state, is idempotent, and converges concurrent API replicas', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const first = createBootstrapContext(database);
      const second = createBootstrapContext(database);

      await Promise.all([
        first.app.onApplicationBootstrap(),
        second.app.onApplicationBootstrap(),
      ]);

      // No system groups: roles live on the users.
      await expect(database.selectFrom('iam.groups').select('id').execute()).resolves.toEqual([]);

      const admin = await database.selectFrom('iam.users')
        .select(['id', 'username', 'status', 'role'])
        .where('username', '=', 'admin')
        .executeTakeFirstOrThrow();
      expect(admin.status).toBe(UserStatus.Active);
      expect(admin.role).toBe(Role.Admin);

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

  it('promotes a pre-existing reserved admin account to the admin role, and leaves a disabled one alone when another admin exists', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const context = createBootstrapContext(database);
      const existing = await database.insertInto('iam.users').values({
        id: randomUUID(), numeric_id: 7, username: 'admin', password_hash: 'unused',
        display_name: 'Administrator', status: UserStatus.Active, auth_version: 0,
      }).returning(['id', 'role']).executeTakeFirstOrThrow();
      expect(existing.role).toBe(Role.User);

      await context.app.onApplicationBootstrap();

      const promoted = await database.selectFrom('iam.users').select('role').where('id', '=', existing.id)
        .executeTakeFirstOrThrow();
      expect(promoted.role).toBe(Role.Admin);
    });
  });

  it('does not undo a demotion of the reserved admin while another active administrator exists', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const context = createBootstrapContext(database);
      const demoted = await database.insertInto('iam.users').values({
        id: randomUUID(), numeric_id: 7, username: 'admin', password_hash: 'unused',
        display_name: 'Administrator', status: UserStatus.Active, role: Role.UserAdmin, auth_version: 0,
      }).returning('id').executeTakeFirstOrThrow();
      await database.insertInto('iam.users').values({
        id: randomUUID(), numeric_id: 8, username: 'other-admin', password_hash: 'unused',
        display_name: 'Other', status: UserStatus.Active, role: Role.Admin, auth_version: 0,
      }).execute();

      await context.app.onApplicationBootstrap();
      await context.app.onApplicationBootstrap();

      const row = await database.selectFrom('iam.users').select('role').where('id', '=', demoted.id)
        .executeTakeFirstOrThrow();
      expect(row.role).toBe(Role.UserAdmin);
    });
  });

  it.each([
    ['production', false],
    ['development', true],
  ] as const)('uses the well-known admin password only for an explicit development runtime (%s)', async (nodeEnv, wellKnown) => {
    // Production prints a generated password; keep it out of the test output.
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await withPostgresTestDatabase(async ({ database }) => {
        const context = createBootstrapContext(database, {
          'runtime.nodeEnv': nodeEnv,
          'auth.adminInitPassword': '',
        });
        await context.app.onApplicationBootstrap();
        const login = context.auth.authenticateAndLogin('admin', 'admin123', '127.0.0.1');
        if (wellKnown) await expect(login).resolves.toMatchObject({ accessToken: expect.any(String) });
        else await expect(login).rejects.toMatchObject({ status: 401 });
      });
    } finally {
      stderr.mockRestore();
    }
  });

  it('prints a generated admin password straight to stderr, whatever the log level, exactly once', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const nestLogs = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await withPostgresTestDatabase(async ({ database }) => {
        const context = createBootstrapContext(database, {
          'runtime.nodeEnv': 'production',
          'server.logLevel': 'error',
          'auth.adminInitPassword': '',
        });
        await context.app.onApplicationBootstrap();
        const printed = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
        const password = /^\[nyabase\] {5}([0-9a-f]{24})$/m.exec(printed)?.[1];
        expect(password).toBeDefined();
        expect(printed).toContain('shown only this once');
        // The secret never goes through the (level-filtered) Nest logger.
        expect(JSON.stringify(nestLogs.mock.calls)).not.toContain(password);
        await expect(context.auth.authenticateAndLogin('admin', password!, '127.0.0.1'))
          .resolves.toMatchObject({ accessToken: expect.any(String) });

        // An active admin now exists: later boots generate and print nothing.
        stderr.mockClear();
        await createBootstrapContext(database, {
          'runtime.nodeEnv': 'production',
          'auth.adminInitPassword': '',
        }).app.onApplicationBootstrap();
        expect(stderr).not.toHaveBeenCalled();
      });
    } finally {
      stderr.mockRestore();
      nestLogs.mockRestore();
    }
  });

  it('refuses to start when the reserved admin is disabled and no other active admin exists', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const context = createBootstrapContext(database);
      await database.insertInto('iam.users').values({
        id: randomUUID(), numeric_id: 7, username: 'admin', password_hash: 'unused',
        display_name: 'Administrator', status: UserStatus.Disabled, role: Role.Admin, auth_version: 0,
      }).execute();

      await expect(context.app.onApplicationBootstrap()).rejects.toMatchObject({
        response: { code: 'ADMIN_BOOTSTRAP_UNAVAILABLE' },
      });

      await database.insertInto('iam.users').values({
        id: randomUUID(), numeric_id: 8, username: 'other-admin', password_hash: 'unused',
        display_name: 'Other', status: UserStatus.Active, role: Role.Admin, auth_version: 0,
      }).execute();
      await expect(context.app.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });
});

function createBootstrapContext(
  database: Kysely<NyabaseDatabase>,
  overrides: Record<string, unknown> = {},
): {
  app: IamBootstrapService;
  auth: AuthService;
} {
  const transactions = new PgTransactionManager(database);
  const access = new AccessResolverService(database, transactions);
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
        'auth.sessionMaxLifetimeDays': 30,
        ...overrides,
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
    new MonotonicClock(),
    new SessionRevocationService(),
  );
  const users = new UsersService(
    database,
    transactions,
    auth,
    access,
    { notify: async () => undefined } as never,
    config as never,
    audit as never,
    new AccessChangeNotifier(),
    new SessionRevocationService(),
  );
  const app = new IamBootstrapService(users);
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

