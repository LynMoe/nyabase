import { randomUUID } from 'node:crypto';
import {
  Capability,
  GpuGrantMode,
  ServerStatus,
  UserStatus,
} from '@nyabase/common';
import { vi } from 'vitest';
import { AccessCacheEpochService } from '../access/access-cache-epoch.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AccessRevocationGuardService } from '../access/access-revocation-guard.service.js';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { MountSourcesService } from '../mount-sources/mount-sources.service.js';
import type { PostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import type { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { QuotaDispatchService } from '../quota/quota-dispatch.service.js';
import { StorageRepository } from '../storage/storage.repository.js';
import { GroupsService } from './groups.service.js';

export interface GroupsPgFixture {
  service: GroupsService;
  access: AccessResolverService;
  audit: {
    log: (...args: any[]) => Promise<unknown>;
    append: (...args: any[]) => Promise<unknown>;
  };
  auth: { deleteUserCredentialsInTransaction: (...args: any[]) => Promise<void> };
  proxy: { notify: (...args: any[]) => Promise<unknown> };
  quota: QuotaDispatchService;
  storage: StorageRepository;
  transactions: PgTransactionManager;
  actorId: string;
  userId: string;
  alternativeAdminId: string;
  groupId: string;
  actorGroupId: string;
  serverId: string;
}

export async function groupsPgFixture(
  fixture: PostgresTestDatabase,
  options: {
    actorCapabilities?: Capability[];
    member?: boolean;
    groupCapabilities?: Capability[];
    groupGrantBytes?: number;
    quota?: QuotaDispatchService;
  } = {},
): Promise<GroupsPgFixture> {
  const transactions = new PgTransactionManager(fixture.database);
  const storage = new StorageRepository(fixture.database);
  const keys = new ResourceKeyService();
  const actorId = randomUUID();
  const userId = randomUUID();
  const alternativeAdminId = randomUUID();
  const groupId = randomUUID();
  const actorGroupId = randomUUID();
  const serverId = randomUUID();
  await fixture.database.insertInto('infra.servers').values({
    id: serverId,
    name: 'IAM Node',
    slug: `iam-node-${serverId.slice(0, 8)}`,
    agent_token_hash: 'a'.repeat(64),
    host_fingerprint: null,
    agent_config_fingerprint: null,
    status: ServerStatus.Online,
    quarantine_code: null,
    quarantine_message: null,
    last_seen_at: null,
    macvlan_cidr: null,
    macvlan_gateway: null,
    macvlan_reserved_ips: '[]',
    revision: 1,
  }).execute();
  await fixture.database.insertInto('iam.users').values([
    iamUser(actorId, 1001, 'Actor'),
    iamUser(userId, 1002, 'Target'),
    iamUser(alternativeAdminId, 1003, 'Alternative'),
  ]).execute();
  await fixture.database.insertInto('iam.groups').values([
    iamGroup(groupId, 'Target Group', options.groupCapabilities ?? []),
    iamGroup(
      actorGroupId,
      'Actor Authority',
      options.actorCapabilities ?? [
        Capability.ManageGroups,
        Capability.ManageGrants,
        Capability.ManageUsers,
      ],
    ),
  ]).execute();
  await fixture.database.insertInto('iam.group_members').values([
    { id: randomUUID(), group_id: actorGroupId, user_id: actorId },
    ...(options.member
      ? [{ id: randomUUID(), group_id: groupId, user_id: userId }]
      : []),
  ]).execute();
  if (options.groupGrantBytes !== undefined) {
    await fixture.database.insertInto('iam.server_grants').values({
      id: randomUUID(),
      user_id: null,
      group_id: groupId,
      server_id: serverId,
      cpu_millis: 1000,
      mem_bytes: 1024,
      disk_bytes: options.groupGrantBytes,
      gpu_mode: GpuGrantMode.None,
      gpu_indices: null,
    }).execute();
  }
  const access = new AccessResolverService(
    fixture.database,
    transactions,
    { stateCache: { get: () => undefined } } as never,
    new AccessCacheEpochService(fixture.database),
  );
  const audit = {
    log: vi.fn().mockResolvedValue(undefined),
    append: vi.fn(),
  };
  audit.append.mockImplementation(
    async (_transaction: unknown, ...args: unknown[]) => audit.log(...args),
  );
  const quota = options.quota ?? new QuotaDispatchService(
    transactions,
    storage,
    new WorkflowEnqueuePort(
      keys,
      new AgentTaskPayloadCodecService({
        decryptIfEncrypted: (value: string) => value,
      } as never),
    ),
    keys,
  );
  const auth = {
    deleteUserCredentialsInTransaction: vi.fn(async (transaction: any, id: string) => {
      await transaction.deleteFrom('iam.refresh_tokens').where('user_id', '=', id).execute();
      await transaction.deleteFrom('iam.api_tokens').where('user_id', '=', id).execute();
    }),
  };
  const proxy = { notify: vi.fn().mockResolvedValue(undefined) };
  const service = new GroupsService(
    fixture.database,
    transactions,
    access,
    audit as unknown as AuditService,
    new AccessRevocationGuardService(),
    {} as MountSourcesService,
    quota,
    proxy as unknown as ProxySnapshotNotifierService,
    auth as unknown as AuthService,
  );
  return {
    service,
    access,
    audit,
    auth,
    proxy,
    quota,
    storage,
    transactions,
    actorId,
    userId,
    alternativeAdminId,
    groupId,
    actorGroupId,
    serverId,
  };
}

function iamUser(id: string, numericId: number, displayName: string) {
  return {
    id,
    numeric_id: numericId,
    username: `${displayName.toLowerCase()}-${id.slice(0, 8)}`,
    password_hash: 'hash',
    display_name: displayName,
    status: UserStatus.Active,
    auth_version: 1,
    authz_version: 1,
  };
}

function iamGroup(id: string, name: string, capabilities: Capability[]) {
  return {
    id,
    name: `${name} ${id.slice(0, 8)}`,
    description: null,
    priority: 1,
    is_system: false,
    system_key: null,
    capabilities,
    revision: 1,
  };
}
