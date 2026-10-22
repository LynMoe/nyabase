import { randomUUID } from 'node:crypto';
import { Role, UserStatus } from '@nyabase/common';
import { vi, type Mock } from 'vitest';
import { AccessChangeNotifier, AccessResolverService } from '../iam/access-resolver.service.js';
import type { PostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { UserSshKeysService } from './user-ssh-keys.service.js';
import { UsersService } from './users.service.js';

export interface UsersPgFixture {
  users: UsersService;
  sshKeys: UserSshKeysService;
  transactions: PgTransactionManager;
  access: AccessResolverService;
  changes: AccessChangeNotifier;
  auth: Record<string, Mock>;
  audit: Record<string, Mock>;
  proxySnapshots: Record<string, Mock>;
  convergence: Record<string, Mock>;
  actorId: string;
  userId: string;
}

export async function usersPgFixture(
  fixture: PostgresTestDatabase,
  options: {
    actorRole?: Role;
    targetStatus?: UserStatus;
    seedActor?: boolean;
    seedTarget?: boolean;
  } = {},
): Promise<UsersPgFixture> {
  const transactions = new PgTransactionManager(fixture.database);
  const access = new AccessResolverService(fixture.database, transactions);
  const changes = new AccessChangeNotifier();
  const actorId = randomUUID();
  const userId = randomUUID();
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
    proxySnapshots as never,
    { get: vi.fn((key: string) => key === 'runtime.nodeEnv' ? 'test' : 'admin123') } as never,
    audit as never,
    changes,
  );
  const sshKeys = new UserSshKeysService(
    fixture.database,
    transactions,
    convergence as never,
    proxySnapshots as never,
    audit as never,
  );

  const userRows = [];
  if (options.seedActor !== false) {
    userRows.push(userRow(actorId, 1001, 'actor', UserStatus.Active, options.actorRole ?? Role.Admin));
  }
  if (options.seedTarget !== false) {
    userRows.push(userRow(userId, 1002, 'target', options.targetStatus ?? UserStatus.Active));
  }
  if (userRows.length > 0) {
    await fixture.database.insertInto('iam.users').values(userRows).execute();
  }
  return {
    users,
    transactions,
    access,
    changes,
    auth,
    audit,
    proxySnapshots,
    convergence,
    sshKeys,
    actorId,
    userId,
  };
}

export function userRow(
  id: string,
  numericId: number,
  username: string,
  status: UserStatus,
  role: Role = Role.User,
) {
  return {
    id,
    numeric_id: numericId,
    username,
    password_hash: 'hash',
    display_name: username,
    status,
    role,
    auth_version: 0,
  };
}
