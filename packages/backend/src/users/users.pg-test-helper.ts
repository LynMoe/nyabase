import { randomUUID } from 'node:crypto';
import { Capability, UserStatus } from '@nyabase/common';
import { vi } from 'vitest';
import { AccessCacheEpochService } from '../access/access-cache-epoch.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import type { PostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { UsersService } from './users.service.js';

export interface UsersPgFixture {
  users: UsersService;
  transactions: PgTransactionManager;
  access: AccessResolverService;
  auth: any;
  audit: any;
  proxySnapshots: any;
  convergence: any;
  actorId: string;
  userId: string;
  actorGroupId: string;
}

export async function usersPgFixture(
  fixture: PostgresTestDatabase,
  options: {
    actorCapabilities?: Capability[];
    targetStatus?: UserStatus;
    seedActor?: boolean;
    seedTarget?: boolean;
  } = {},
): Promise<UsersPgFixture> {
  const transactions = new PgTransactionManager(fixture.database);
  const access = new AccessResolverService(
    fixture.database,
    transactions,
    new AccessCacheEpochService(fixture.database),
  );
  const actorId = randomUUID();
  const userId = randomUUID();
  const actorGroupId = randomUUID();
  const auth = {
    hashPassword: vi.fn(async (password: string) => `hash:${password}`),
    verifyPassword: vi.fn().mockResolvedValue(true),
    revokeBrowserSessionsInTransaction: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  Object.assign(audit, {
    append: vi.fn(async (_transaction: unknown, ...args: unknown[]) => audit.log(...args)),
  });
  const proxySnapshots = { notify: vi.fn().mockResolvedValue(undefined) };
  const convergence = { reconcileUser: vi.fn().mockResolvedValue(undefined) };
  const users = new UsersService(
    fixture.database,
    transactions,
    auth as never,
    access,
    convergence as never,
    proxySnapshots as never,
    { get: vi.fn((key: string) => key === 'runtime.nodeEnv' ? 'test' : 'admin123') } as never,
    audit as never,
  );

  const userRows = [];
  if (options.seedActor !== false) {
    userRows.push(userRow(actorId, 1001, 'actor', UserStatus.Active));
  }
  if (options.seedTarget !== false) {
    userRows.push(userRow(userId, 1002, 'target', options.targetStatus ?? UserStatus.Active));
  }
  if (userRows.length > 0) {
    await fixture.database.insertInto('iam.users').values(userRows).execute();
  }
  if (options.seedActor !== false) {
    await fixture.database.insertInto('iam.groups').values({
      id: actorGroupId,
      name: `Managers ${actorGroupId.slice(0, 8)}`,
      description: null,
      priority: 1,
      is_system: false,
      system_key: null,
      capabilities: options.actorCapabilities ?? [Capability.ManageUsers],
      revision: 1,
    }).execute();
    await fixture.database.insertInto('iam.group_members').values({
      id: randomUUID(),
      group_id: actorGroupId,
      user_id: actorId,
    }).execute();
  }
  await fixture.database.insertInto('iam.policy_state')
    .values({ singleton: true, policy_epoch: 0 })
    .onConflict((conflict) => conflict.column('singleton').doNothing())
    .execute();
  return {
    users,
    transactions,
    access,
    auth,
    audit,
    proxySnapshots,
    convergence,
    actorId,
    userId,
    actorGroupId,
  };
}

export function userRow(
  id: string,
  numericId: number,
  username: string,
  status: UserStatus,
) {
  return {
    id,
    numeric_id: numericId,
    username,
    password_hash: 'hash',
    display_name: username,
    status,
    auth_version: 0,
    authz_version: 0,
  };
}
