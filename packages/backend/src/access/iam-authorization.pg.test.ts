import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { ConflictException } from '@nestjs/common';
import {
  Capability,
  SystemGroupKey,
  UserStatus,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { AccessResolverService } from './access-resolver.service.js';
import { AccessRevocationGuardService } from './access-revocation-guard.service.js';
import { IamAuthRepository } from '../auth/iam-auth.repository.js';
import { AuthService } from '../auth/auth.service.js';
import { UsersService } from '../users/users.service.js';
import { UserSshIdentityService } from '../users/user-ssh-identity.service.js';
import { GroupsService } from '../groups/groups.service.js';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { PgAuditSnapshotResolver } from '../audit/audit-snapshot.resolver.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('PostgreSQL IAM users/groups/authorization integration', () => {
  it('allocates unique monotonic numeric IDs under concurrent user creation', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const services = createServices(fixture);
      const users = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        services.users.createUser({
          username: `user-${index}`,
          password: 'password-123',
          displayName: `User ${index}`,
        })));
      const numericIds = users.map((user) => user.numericId).sort((a, b) => a - b);
      expect(numericIds).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
      expect(new Set(numericIds)).toHaveProperty('size', 12);
      expect(await fixture.database.selectFrom('iam.user_internal_ssh_keys')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow()).toMatchObject({ count: '12' });
    });
  });

  it('boots system groups/admin and applies group revision CAS with one winner', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const services = createServices(fixture);
      const { admins } = await services.groups.ensureSystemGroups();
      await services.users.ensureAdminExists(
        (userId) => services.groups.addMember(admins.id, userId).then(() => undefined),
        (excluded) => services.groups.hasActiveSystemGroupMember(admins.id, excluded),
      );
      const admin = await fixture.database.selectFrom('iam.users')
        .select(['id', 'numeric_id', 'status'])
        .where('username', '=', 'admin')
        .executeTakeFirstOrThrow();
      expect(admin).toMatchObject({ numeric_id: 1, status: UserStatus.Active });
      expect(await services.access.userCapabilitiesCurrent(admin.id))
        .toEqual(new Set(Object.values(Capability)));

      const created = await services.groups.create({ name: 'Developers' });
      const updates = await Promise.allSettled([
        services.groups.update(
          created.id,
          { description: 'first' },
          undefined,
          created.revision,
        ),
        services.groups.update(
          created.id,
          { description: 'second' },
          undefined,
          created.revision,
        ),
      ]);
      expect(updates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(updates.filter((result) => result.status === 'rejected')).toHaveLength(1);
    });
  });

  it('prevents concurrent removal of every active administrator', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const services = createServices(fixture);
      const { admins } = await services.groups.ensureSystemGroups();
      const [first, second] = await Promise.all([
        services.users.createUser({
          username: 'admin-one',
          password: 'password-123',
          displayName: 'Admin One',
        }, { systemGroupKey: SystemGroupKey.Administrators, actorId: null }),
        services.users.createUser({
          username: 'admin-two',
          password: 'password-123',
          displayName: 'Admin Two',
        }, { systemGroupKey: SystemGroupKey.Administrators, actorId: null }),
      ]);
      const removals = await Promise.allSettled([
        services.groups.removeMember(admins.id, first.id),
        services.groups.removeMember(admins.id, second.id),
      ]);
      expect(removals.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(removals.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const remaining = await fixture.database.selectFrom('iam.group_members as membership')
        .innerJoin('iam.users as user', 'user.id', 'membership.user_id')
        .select('user.id')
        .where('membership.group_id', '=', admins.id)
        .where('user.status', '=', UserStatus.Active)
        .execute();
      expect(remaining).toHaveLength(1);
    });
  });

  it('invalidates another process cache from the durable epoch after revocation', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const first = createServices(fixture);
      const second = createServices(fixture);
      const user = await first.users.createUser({
        username: 'operator',
        password: 'password-123',
        displayName: 'Operator',
      });
      const group = await first.groups.create({
        name: 'Auditors',
        capabilities: [Capability.ViewAudit],
      });
      await first.groups.addMember(group.id, user.id);
      expect(await second.access.userCapabilities(user.id))
        .toEqual(new Set([Capability.ViewAudit]));
      await first.groups.removeMember(group.id, user.id);
      expect(await second.access.userCapabilities(user.id)).toEqual(new Set());
    });
  });

  it('rolls back server-grant revocation while a canonical dependency remains', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const services = createServices(fixture);
      const serverId = randomUUID();
      await new InfrastructureRepository(fixture.database).insertServer({
        id: serverId,
        name: 'Authorization Node',
        slug: `auth-${serverId.slice(0, 8)}`,
        agentTokenHash: 'f'.repeat(64),
      });
      const user = await services.users.createUser({
        username: 'owner',
        password: 'password-123',
        displayName: 'Owner',
      });
      await services.groups.upsertUserServerGrant(user.id, serverId, {
        diskBytes: 1024,
      });
      await fixture.database.insertInto('control.authorization_dependencies').values({
        id: randomUUID(),
        dependency_kind: 'container',
        dependency_id: 'container-a',
        user_id: user.id,
        server_id: serverId,
        source_kind: null,
        source_id: null,
        source_identity: null,
      }).execute();
      await expect(services.groups.deleteUserServerGrant(user.id, serverId))
        .rejects.toBeInstanceOf(ConflictException);
      expect(await fixture.database.selectFrom('iam.server_grants')
        .select('id')
        .where('user_id', '=', user.id)
        .where('server_id', '=', serverId)
        .executeTakeFirst()).toBeTruthy();
    });
  });
});

function createServices(fixture: PostgresTestDatabase) {
  const transactions = new PgTransactionManager(fixture.database);
  const audit = new AuditService(
    new AuditRepository(fixture.database, transactions),
    transactions,
    {
      get: vi.fn((key: string) => {
        if (key === 'audit.retentionDays') return 0;
        if (key === 'audit.retentionMaxEntries') return 0;
        return undefined;
      }),
    } as never,
    new PgAuditSnapshotResolver(),
  );
  const cacheEpoch = new AccessCacheEpochService(fixture.database);
  const gateway = { stateCache: new Map() };
  const access = new AccessResolverService(
    fixture.database,
    transactions,
    gateway as never,
    cacheEpoch,
  );
  const authRepository = new IamAuthRepository(fixture.database, transactions);
  const auth = new AuthService(
    authRepository,
    new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } }),
    {
      get: vi.fn((key: string) => {
        if (key === 'auth.jwtSecret') return 'test-secret';
        if (key === 'auth.refreshTokenExpiresDays') return 30;
        return undefined;
      }),
    } as never,
    audit,
  );
  vi.spyOn(auth, 'hashPassword').mockResolvedValue('test-password-hash');
  const identities = new UserSshIdentityService(
    fixture.database,
    transactions,
    {
      generateEd25519: vi.fn(async (comment: string) => ({
        privateKey: `private:${comment}`,
        publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest ${comment}`,
        fingerprint: `SHA256:${Buffer.from(comment).toString('base64url')}`,
      })),
    } as never,
    {
      encrypt: vi.fn((value: string) => `encrypted:${value}`),
      decrypt: vi.fn((value: string) => value.slice('encrypted:'.length)),
    } as never,
    audit,
  );
  const users = new UsersService(
    fixture.database,
    transactions,
    auth,
    access,
    { reconcileUser: vi.fn().mockResolvedValue(undefined) } as never,
    identities,
    { notify: vi.fn().mockResolvedValue(undefined) } as never,
    {
      get: vi.fn((key: string) => {
        if (key === 'runtime.nodeEnv') return 'test';
        if (key === 'auth.adminInitPassword') return 'admin123';
        return undefined;
      }),
    } as never,
    audit,
  );
  const groups = new GroupsService(
    fixture.database,
    transactions,
    access,
    audit,
    new AccessRevocationGuardService(),
    {} as never,
    {
      applyManyInTransaction: vi.fn(async (
        _transaction: unknown,
        requests: readonly unknown[],
      ) => requests.map(() => randomUUID())),
    } as never,
    { notify: vi.fn().mockResolvedValue(undefined) } as never,
    auth,
  );
  return { access, auth, users, groups };
}
