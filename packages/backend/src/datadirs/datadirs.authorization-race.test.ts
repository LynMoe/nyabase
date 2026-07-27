import { randomUUID } from 'node:crypto';
import {
  AgentTaskStatus,
  Capability,
  GpuGrantMode,
  RemoteFsType,
  ServerStatus,
  UserStatus,
  remoteFsSourceIdentity,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { AccessCacheEpochService } from '../access/access-cache-epoch.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AccessRevocationGuardService } from '../access/access-revocation-guard.service.js';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowDispatchService } from '../agent-tasks/workflow-dispatch.service.js';
import { WorkflowFinalizerWorkerService } from '../agent-tasks/workflow-finalizer-worker.service.js';
import { WorkflowFinalizerRegistry } from '../agent-tasks/workflow-finalizer.registry.js';
import { createReadyAgentSession } from '../agent-tasks/workflow.pg-test-helper.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';
import {
  WorkflowEnqueuePort,
  type WorkflowEnqueueInput,
  type WorkflowTransaction,
} from '../agent-tasks/workflow-enqueue.port.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AgentGateway } from '../gateway/agent-gateway.js';
import { MountSourcesService } from '../mount-sources/mount-sources.service.js';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import type { ServersService } from '../servers/servers.service.js';
import { StorageRepository } from '../storage/storage.repository.js';
import { QuotaDispatchService } from '../quota/quota-dispatch.service.js';
import { DataDirsService } from './datadirs.service.js';
import {
  DataDirWorkflowFinalizerService,
} from './data-dir-workflow-finalizer.service.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('DataDirs PostgreSQL authorization and source races', () => {
  it('rolls back directory, workflow task, and claims when required audit fails', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      context.audit.append.mockRejectedValueOnce(new Error('audit unavailable'));
      await expect(context.dataDirs.createDir(
        context.userId,
        context.userId,
        context.serverId,
        'local',
        'disk-a',
        'audit-rollback',
        1001,
      )).rejects.toThrow('audit unavailable');
      expect(await fixture.database.selectFrom('control.data_directories')
        .select('id').execute()).toEqual([]);
      expect(await fixture.database.selectFrom('workflow.tasks')
        .select('id')
        .where('kind', '=', 'datadir.ensure')
        .execute()).toEqual([]);
    });
  });

  it('rejects admission when revocation committed first', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await context.mountSources.deleteGrant(
        context.actorId,
        'user',
        context.userId,
        {
          sourceKind: 'local',
          sourceId: 'disk-a',
          serverId: context.serverId,
        },
      );
      await expect(context.dataDirs.createDir(
        context.userId,
        context.userId,
        context.serverId,
        'local',
        'disk-a',
        'revoked',
        1001,
      )).rejects.toThrow(/authorization changed/);
      expect(await fixture.database.selectFrom('control.data_directories')
        .select('id')
        .execute()).toEqual([]);
    });
  });

  it('holds admission grant locks until dependency commit, then blocks revocation', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => { reached = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const context = await setup(fixture, {
        wrapWorkflow: (workflow) => ({
          enqueueInTransaction: async (
            transaction: WorkflowTransaction,
            input: WorkflowEnqueueInput,
          ) => {
            reached();
            await gate;
            return workflow.enqueueInTransaction(transaction, input);
          },
        } as WorkflowEnqueuePort),
      });
      const create = context.dataDirs.createDir(
        context.userId,
        context.userId,
        context.serverId,
        'local',
        'disk-a',
        'locked',
        1001,
      );
      await paused;

      let deleteReached!: () => void;
      const deleting = new Promise<void>((resolve) => { deleteReached = resolve; });
      const original = context.storage.deleteExactMountSourceGrants.bind(context.storage);
      vi.spyOn(context.storage, 'deleteExactMountSourceGrants')
        .mockImplementation(async (...args) => {
          deleteReached();
          return original(...args);
        });
      const revoke = context.mountSources.deleteGrant(
        context.actorId,
        'user',
        context.userId,
        {
          sourceKind: 'local',
          sourceId: 'disk-a',
          serverId: context.serverId,
        },
      );
      await deleting;
      release();

      await expect(create).resolves.toMatchObject({ taskId: expect.any(String) });
      await expect(revoke).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ACCESS_REVOKE_HAS_RESOURCES' }),
      });
      expect(await fixture.database.selectFrom('control.authorization_dependencies')
        .select('dependency_kind')
        .executeTakeFirst()).toMatchObject({ dependency_kind: 'data_directory' });
      expect(await context.storage.listMountSourceGrantsForScope(
        'user',
        context.userId,
      )).toHaveLength(1);
    });
  });

  it('locks actor capability rows so committed revocation denies admin admission', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await fixture.database.updateTable('iam.groups')
        .set({ capabilities: [Capability.ManageGrants] })
        .where('id', '=', context.adminGroupId)
        .executeTakeFirstOrThrow();
      await expect(context.dataDirs.createDir(
        context.actorId,
        context.userId,
        context.serverId,
        'local',
        'disk-a',
        'admin',
        1001,
        'admin',
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
      expect(await fixture.database.selectFrom('workflow.tasks')
        .select('kind')
        .where('kind', 'in', ['data_dir.ensure', 'data_dir.absent'])
        .execute()).toEqual([]);
    });
  });

  it('rejects deletion after local physical identity replacement', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await context.insertDirectory({
        sourceKind: 'local',
        sourceId: 'disk-a',
        sourceIdentity: 'physical-a',
        serverId: context.serverId,
      });
      context.snapshot.disks[0]!.sourceIdentity = 'physical-replacement';
      await expect(context.dataDirs.deleteDir(
        context.userId,
        context.userId,
        context.serverId,
        'local',
        'disk-a',
        'data-a',
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'DATA_DIRECTORY_SOURCE_NOT_READY' }),
      });
      expect(await fixture.database.selectFrom('control.data_directories')
        .select(['desired_state', 'generation'])
        .executeTakeFirst()).toMatchObject({ desired_state: 'active', generation: 1 });
    });
  });

  it('rejects remote deletion when assignment disappeared before admission', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const mountId = randomUUID();
      const params = {
        type: RemoteFsType.Nfs as const,
        nfsServer: 'nfs.example',
        exportPath: '/data',
        version: '4.2' as const,
      };
      await context.storage.insertRemoteFsMount({
        id: mountId,
        name: 'remote',
        displayName: null,
        description: null,
        type: RemoteFsType.Nfs,
        hostMountPoint: `/mnt/remote-fs/${mountId}`,
        options: '',
        params,
      });
      await context.storage.insertMountSourceGrant(
        randomUUID(),
        'user',
        context.userId,
        { sourceKind: 'remote', sourceId: mountId },
      );
      await context.insertDirectory({
        sourceKind: 'remote',
        sourceId: mountId,
        sourceIdentity: remoteFsSourceIdentity(params),
        serverId: null,
      });
      await expect(context.dataDirs.deleteDir(
        context.userId,
        context.userId,
        context.serverId,
        'remote',
        mountId,
        'data-a',
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'DATA_DIRECTORY_SOURCE_NOT_READY' }),
      });
      expect(await fixture.database.selectFrom('control.data_directories')
        .select('desired_state')
        .executeTakeFirst()).toMatchObject({ desired_state: 'active' });
    });
  });

  it('finalizes create and delete projections through the Workflow worker', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const created = await context.dataDirs.createDir(
        context.userId,
        context.userId,
        context.serverId,
        'local',
        'disk-a',
        'finalized',
        1001,
      );
      const ensure = await context.workflowRepository.findTask(created.taskId);
      const ensureDispatch = await context.workflowDispatch.claimAndBuild(
        context.serverId,
        context.agentSession,
      );
      expect(ensureDispatch?.claim.task.id).toBe(created.taskId);
      await context.workflowDispatch.markSent(ensureDispatch!);
      await context.workflowRepository.acceptAgentResult(context.serverId, {
        taskId: created.taskId,
        payloadHash: ensure!.payloadHash,
        status: 'succeeded',
        result: {
          path: `/data/.nyabase/dirs/${created.resourceId}/data`,
          exists: true,
          isDirectory: true,
          uid: 1001,
          gid: 1001,
          resourceId: created.resourceId,
          quotaAssigned: true,
        },
      }, context.agentSession);
      expect(await context.finalizerWorker.process()).toBe(1);
      expect(await context.storage.findDataDirectoryById(created.resourceId))
        .toMatchObject({ desiredState: 'active', lastTaskId: created.taskId });

      const deleted = await context.dataDirs.deleteDir(
        context.userId,
        context.userId,
        context.serverId,
        'local',
        'disk-a',
        'finalized',
      );
      const absent = await context.workflowRepository.findTask(deleted.taskId);
      const absentDispatch = await context.workflowDispatch.claimAndBuild(
        context.serverId,
        context.agentSession,
      );
      expect(absentDispatch?.claim.task.id).toBe(deleted.taskId);
      await context.workflowDispatch.markSent(absentDispatch!);
      await context.workflowRepository.acceptAgentResult(context.serverId, {
        taskId: deleted.taskId,
        payloadHash: absent!.payloadHash,
        status: 'succeeded',
        result: {
          path: `/data/.nyabase/dirs/${created.resourceId}/data`,
          exists: false,
          isDirectory: false,
          uid: null,
          gid: null,
          resourceId: null,
          quotaAssigned: true,
        },
      }, context.agentSession);
      expect(await context.finalizerWorker.process()).toBe(1);
      expect(await context.storage.findDataDirectoryById(created.resourceId)).toBeNull();
      expect(await context.workflowRepository.findTask(deleted.taskId))
        .toMatchObject({ status: AgentTaskStatus.Succeeded });
      expect(await fixture.database.selectFrom('control.authorization_dependencies')
        .select('id')
        .where('dependency_id', '=', created.resourceId)
        .executeTakeFirst()).toBeUndefined();
    });
  });
});

async function setup(
  fixture: PostgresTestDatabase,
  options: {
    wrapWorkflow?: (workflow: WorkflowEnqueuePort) => WorkflowEnqueuePort;
  } = {},
) {
  const transactions = new PgTransactionManager(fixture.database);
  const storage = new StorageRepository(fixture.database);
  const keys = new ResourceKeyService();
  const codec = new AgentTaskPayloadCodecService({
    decryptIfEncrypted: (value: string) => value,
  } as never);
  const canonicalWorkflow = new WorkflowEnqueuePort(keys, codec);
  const workflowRepository = new WorkflowRepository(
    fixture.database,
    transactions,
    codec,
  );
  const workflow = options.wrapWorkflow?.(canonicalWorkflow) ?? canonicalWorkflow;
  const serverId = randomUUID();
  const userId = randomUUID();
  const actorId = randomUUID();
  const adminGroupId = randomUUID();
  await fixture.database.insertInto('infra.servers').values({
    id: serverId,
    name: 'DataDir Node',
    slug: `datadir-${serverId.slice(0, 8)}`,
    agent_token_hash: 'd'.repeat(64),
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
    {
      id: userId,
      numeric_id: 1001,
      username: `data-${userId.slice(0, 8)}`,
      password_hash: 'hash',
      display_name: 'Data User',
      status: UserStatus.Active,
      auth_version: 1,
      authz_version: 1,
    },
    {
      id: actorId,
      numeric_id: 1002,
      username: `admin-${actorId.slice(0, 8)}`,
      password_hash: 'hash',
      display_name: 'Grant Admin',
      status: UserStatus.Active,
      auth_version: 1,
      authz_version: 1,
    },
  ]).execute();
  await fixture.database.insertInto('iam.groups').values({
    id: adminGroupId,
    name: `Grant Admins ${adminGroupId.slice(0, 8)}`,
    description: null,
    priority: 1,
    is_system: false,
    system_key: null,
    capabilities: [Capability.ManageGrants, Capability.ManageContainersAny],
    revision: 1,
  }).execute();
  await fixture.database.insertInto('iam.group_members').values({
    id: randomUUID(),
    group_id: adminGroupId,
    user_id: actorId,
  }).execute();
  await fixture.database.insertInto('iam.server_grants').values({
    id: randomUUID(),
    user_id: userId,
    group_id: null,
    server_id: serverId,
    cpu_millis: 1000,
    mem_bytes: 1024,
    disk_bytes: 4096,
    gpu_mode: GpuGrantMode.None,
    gpu_indices: null,
  }).execute();
  await storage.insertMountSourceGrant(
    randomUUID(),
    'user',
    userId,
    {
      sourceKind: 'local',
      sourceId: 'disk-a',
      serverId,
      sourceIdentity: 'physical-a',
    },
  );
  const snapshot = {
    helloAt: Date.now(),
    runtimeReady: true,
    disks: [{
      diskId: 'disk-a',
      mountPoint: '/data',
      sourceIdentity: 'physical-a',
    }],
    containers: new Map(),
  };
  const gateway = {
    stateCache: {
      get: () => snapshot,
    },
  } as unknown as AgentGateway;
  const cache = new AccessCacheEpochService(fixture.database);
  const access = new AccessResolverService(
    fixture.database,
    transactions,
    gateway,
    cache,
  );
  const audit = {
    append: vi.fn().mockResolvedValue(undefined),
  };
  const mountSources = new MountSourcesService(
    storage,
    transactions,
    access,
    audit as unknown as AuditService,
    gateway,
    new AccessRevocationGuardService(),
  );
  const quota = new QuotaDispatchService(
    transactions,
    storage,
    canonicalWorkflow,
    keys,
  );
  const quotaTaskId = await quota.apply({
    serverId,
    userId,
    numericUserId: 1001,
    diskBytes: 4096,
    requestedBy: userId,
  });
  await fixture.database.updateTable('workflow.tasks')
    .set({ status: 'succeeded', completed_at: new Date() })
    .where('id', '=', quotaTaskId)
    .executeTakeFirstOrThrow();
  await fixture.database.deleteFrom('workflow.resource_claims')
    .where('task_id', '=', quotaTaskId)
    .execute();
  const dataDirs = new DataDirsService(
    storage,
    transactions,
    ({
      findById: vi.fn().mockResolvedValue({ id: serverId, name: 'DataDir Node' }),
    } as unknown as ServersService),
    audit as unknown as AuditService,
    workflow,
    keys,
    gateway.stateCache,
    access,
  );
  const finalizerRegistry = new WorkflowFinalizerRegistry();
  const finalizerRegistrar = new DataDirWorkflowFinalizerService(
    finalizerRegistry,
    storage,
  );
  finalizerRegistrar.onModuleInit();
  const finalizerWorker = new WorkflowFinalizerWorkerService(
    workflowRepository,
    finalizerRegistry,
  );
  const workflowDispatch = new WorkflowDispatchService(
    workflowRepository,
    codec,
    finalizerRegistry,
  );
  const agentSession = await createReadyAgentSession(
    workflowRepository,
    serverId,
  );
  return {
    serverId,
    userId,
    actorId,
    audit,
    adminGroupId,
    storage,
    workflowRepository,
    workflowDispatch,
    agentSession,
    finalizerWorker,
    snapshot,
    dataDirs,
    mountSources,
    insertDirectory: async (input: {
      sourceKind: 'local' | 'remote';
      sourceId: string;
      sourceIdentity: string;
      serverId: string | null;
    }) => transactions.run((transaction) =>
      storage.insertDataDirectory({
        id: randomUUID(),
        userId,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        name: 'data-a',
        sourceIdentity: input.sourceIdentity,
        serverId: input.serverId,
        uid: 1001,
        desiredState: 'active',
        generation: 1,
        lastTaskId: quotaTaskId,
      }, serverId, transaction)),
  };
}
