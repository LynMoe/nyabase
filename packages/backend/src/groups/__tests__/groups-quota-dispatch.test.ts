import { randomUUID } from 'node:crypto';
import {
  AuditAction,
  Capability,
  GpuGrantMode,
  MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION,
  ServerStatus,
  UserStatus,
} from '@nyabase/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AccessCacheEpochService } from '../../access/access-cache-epoch.service.js';
import { AccessResolverService } from '../../access/access-resolver.service.js';
import { AccessRevocationGuardService } from '../../access/access-revocation-guard.service.js';
import { AgentTaskPayloadCodecService } from '../../agent-tasks/agent-task-payload-codec.service.js';
import { ResourceKeyService } from '../../agent-tasks/resource-key.service.js';
import { WorkflowEnqueuePort } from '../../agent-tasks/workflow-enqueue.port.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { MountSourcesService } from '../../mount-sources/mount-sources.service.js';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../../persistence-pg/transaction.js';
import type { NyabaseDatabase } from '../../persistence-pg/database.types.js';
import type {
  ProxySnapshotNotifierService,
} from '../../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { QuotaDispatchService } from '../../quota/quota-dispatch.service.js';
import { StorageRepository } from '../../storage/storage.repository.js';
import { GroupsController } from '../groups.controller.js';
import { GroupsService } from '../groups.service.js';
import { UserGrantsController } from '../user-grants.controller.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('GroupsService PostgreSQL quota workflow', () => {
  it('adds membership and quota intent in one transaction', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await fixture.database.insertInto('iam.server_grants').values(
        serverGrant(context.groupId, context.serverId, 4096),
      ).execute();

      const result = await context.service.addMember(
        context.groupId,
        context.userId,
        context.actorId,
      );
      expect(result.taskIds).toEqual([expect.any(String)]);
      expect(await fixture.database.selectFrom('iam.group_members')
        .select('id')
        .where('group_id', '=', context.groupId)
        .where('user_id', '=', context.userId)
        .executeTakeFirst()).toBeTruthy();
      expect(await context.storage.findQuotaDesired(
        context.serverId,
        context.userId,
      )).toMatchObject({
        limitBytes: 4096,
        lastTaskId: result.taskIds[0],
      });
      expect(await fixture.database.selectFrom('workflow.tasks')
        .selectAll()
        .where('id', '=', result.taskIds[0]!)
        .executeTakeFirst()).toMatchObject({
        resource_id: context.userId,
        requested_by: context.actorId,
      });
      expect(context.audit.log).toHaveBeenCalledWith(
        context.actorId,
        AuditAction.AddGroupMember,
        context.groupId,
        'group',
        { userId: context.userId },
      );
    });
  });

  it('returns every durable quota task id with a group grant mutation', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture, { member: true });
      const result = await context.service.upsertGroupServerGrant(
        context.groupId,
        context.serverId,
        { diskBytes: 8192, gpuMode: GpuGrantMode.None, gpuIndices: [] },
        context.actorId,
      );
      expect(result).toMatchObject({
        serverId: context.serverId,
        gpuMode: GpuGrantMode.None,
        gpuIndices: null,
        taskIds: [expect.any(String)],
      });
      expect(await fixture.database.selectFrom('iam.server_grants')
        .select(['gpu_mode', 'gpu_indices'])
        .where('group_id', '=', context.groupId)
        .where('server_id', '=', context.serverId)
        .executeTakeFirstOrThrow()).toEqual({
        gpu_mode: GpuGrantMode.None,
        gpu_indices: null,
      });
      expect(await context.storage.findQuotaDesired(
        context.serverId,
        context.userId,
      )).toMatchObject({ limitBytes: 8192, lastTaskId: result.taskIds[0] });
    });
  });

  it('bounds the maximum admitted synchronous quota fanout on real PostgreSQL', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      let queryCount = 0;
      const pool = new Pool({
        connectionString: fixture.connectionString,
        max: 8,
      });
      pool.on('error', () => undefined);
      pool.on('connect', (client) => {
        const mutable = client as unknown as {
          query: (...args: unknown[]) => unknown;
        };
        const query = mutable.query.bind(client);
        mutable.query = (...args: unknown[]) => {
          queryCount += 1;
          return query(...args);
        };
      });
      const countedDatabase = new Kysely<NyabaseDatabase>({
        dialect: new PostgresDialect({ pool }),
      });
      const countedFixture = {
        ...fixture,
        database: countedDatabase,
      };
      try {
        const context = await setup(countedFixture, { member: true });
        const extraUsers = Array.from(
          { length: MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION - 1 },
          (_, index) => user(
            randomUUID(),
            2_000 + index,
            `QuotaMax${index}`,
          ),
        );
        await countedFixture.database.insertInto('iam.users').values(extraUsers).execute();
        await countedFixture.database.insertInto('iam.group_members').values(
          extraUsers.map((member) => ({
            id: randomUUID(),
            group_id: context.groupId,
            user_id: member.id,
          })),
        ).execute();

        queryCount = 0;
        const startedAt = performance.now();
        const result = await context.service.upsertGroupServerGrant(
          context.groupId,
          context.serverId,
          { diskBytes: 8192, gpuMode: GpuGrantMode.None, gpuIndices: [] },
          context.actorId,
        );
        const elapsedMs = performance.now() - startedAt;

        expect(result.taskIds).toHaveLength(
          MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION,
        );
        expect(queryCount).toBe(144);
        expect(elapsedMs).toBeLessThan(5_000);
      } finally {
        await countedDatabase.destroy();
      }
    });
  });

  it('rolls back the grant when quota workflow enqueue fails', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const quota = {
        applyManyInTransaction: vi.fn().mockRejectedValue(new Error('quota task failed')),
      };
      const context = await setup(fixture, { member: true, quota });
      await expect(context.service.upsertGroupServerGrant(
        context.groupId,
        context.serverId,
        { diskBytes: 8192 },
        context.actorId,
      )).rejects.toThrow('quota task failed');
      expect(await fixture.database.selectFrom('iam.server_grants')
        .select('id')
        .where('group_id', '=', context.groupId)
        .where('server_id', '=', context.serverId)
        .executeTakeFirst()).toBeUndefined();
    });
  });

  it('rejects a deleted Server before grant or quota intent', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const quota = { applyManyInTransaction: vi.fn() };
      const context = await setup(fixture, { quota });
      const missing = randomUUID();
      await expect(context.service.upsertUserServerGrant(
        context.userId,
        missing,
        { diskBytes: 8192 },
        context.actorId,
      )).rejects.toThrow('Server not found');
      expect(quota.applyManyInTransaction).not.toHaveBeenCalled();
      expect(await fixture.database.selectFrom('iam.server_grants')
        .select('id')
        .where('server_id', '=', missing)
        .execute()).toEqual([]);
    });
  });
});

describe('mount-source grant controller input', () => {
  it('accepts non-UUID local source ids for group grants', async () => {
    const groupsService = {
      upsertGroupMountSourceGrant: vi.fn().mockResolvedValue({
        id: 'grant-a',
        sourceKind: 'local',
        sourceId: 'disk-a',
      }),
    };
    const controller = new GroupsController(groupsService as never);
    await expect(controller.upsertMountSourceGrant(
      'group-a',
      { sourceKind: 'local', sourceId: 'disk-a', serverId: 'server-a' },
      { id: 'actor-a' } as never,
    )).resolves.toMatchObject({ sourceId: 'disk-a' });
  });

  it('accepts non-UUID local source ids for user grants', async () => {
    const groupsService = {
      upsertUserMountSourceGrant: vi.fn().mockResolvedValue({
        id: 'grant-a',
        sourceKind: 'local',
        sourceId: 'disk-a',
      }),
    };
    const controller = new UserGrantsController(groupsService as never, {} as never);
    await expect(controller.upsertUserMountSourceGrant(
      'user-a',
      { sourceKind: 'local', sourceId: 'disk-a', serverId: 'server-a' },
      { id: 'actor-a' } as never,
    )).resolves.toMatchObject({ sourceId: 'disk-a' });
  });
});

async function setup(
  fixture: PostgresTestDatabase,
  options: {
    member?: boolean;
    quota?: { applyManyInTransaction: ReturnType<typeof vi.fn> };
  } = {},
) {
  const transactions = new PgTransactionManager(fixture.database);
  const storage = new StorageRepository(fixture.database);
  const keys = new ResourceKeyService();
  const actorId = randomUUID();
  const userId = randomUUID();
  const groupId = randomUUID();
  const actorGroupId = randomUUID();
  const serverId = randomUUID();
  await fixture.database.insertInto('infra.servers').values({
    id: serverId,
    name: 'Quota Node',
    slug: `quota-node-${serverId.slice(0, 8)}`,
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
    user(actorId, 1001, 'Grant Actor'),
    user(userId, 1002, 'Quota User'),
  ]).execute();
  await fixture.database.insertInto('iam.groups').values([
    group(groupId, 'Quota Group', []),
    group(actorGroupId, 'Grant Operators', [
      Capability.ManageGroups,
      Capability.ManageGrants,
    ]),
  ]).execute();
  await fixture.database.insertInto('iam.group_members').values([
    {
      id: randomUUID(),
      group_id: actorGroupId,
      user_id: actorId,
    },
    ...(options.member ? [{
      id: randomUUID(),
      group_id: groupId,
      user_id: userId,
    }] : []),
  ]).execute();
  const access = new AccessResolverService(
    fixture.database,
    transactions,
    { stateCache: { get: () => undefined } } as never,
    new AccessCacheEpochService(fixture.database),
  );
  const audit = { log: vi.fn().mockResolvedValue(undefined), append: vi.fn() };
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
  const service = new GroupsService(
    fixture.database,
    transactions,
    access,
    audit as unknown as AuditService,
    new AccessRevocationGuardService(),
    {} as MountSourcesService,
    quota as QuotaDispatchService,
    ({
      notify: vi.fn().mockResolvedValue(undefined),
    } as unknown as ProxySnapshotNotifierService),
    { deleteUserCredentialsInTransaction: vi.fn() } as unknown as AuthService,
  );
  return {
    service,
    storage,
    audit,
    actorId,
    userId,
    groupId,
    serverId,
  };
}

function user(id: string, numericId: number, displayName: string) {
  return {
    id,
    numeric_id: numericId,
    username: `${displayName.toLowerCase().replace(' ', '-')}-${id.slice(0, 8)}`,
    password_hash: 'hash',
    display_name: displayName,
    status: UserStatus.Active,
    auth_version: 1,
    authz_version: 1,
  };
}

function group(id: string, name: string, capabilities: Capability[]) {
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

function serverGrant(groupId: string, serverId: string, diskBytes: number) {
  return {
    id: randomUUID(),
    user_id: null,
    group_id: groupId,
    server_id: serverId,
    cpu_millis: 1000,
    mem_bytes: 1024,
    disk_bytes: diskBytes,
    gpu_mode: GpuGrantMode.None,
    gpu_indices: null,
  };
}
