import { randomUUID } from 'node:crypto';
import {
  AgentTaskStatus,
  MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION,
  ServerStatus,
  UserStatus,
} from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowDispatchService } from '../agent-tasks/workflow-dispatch.service.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { WorkflowFinalizerWorkerService } from '../agent-tasks/workflow-finalizer-worker.service.js';
import { WorkflowFinalizerRegistry } from '../agent-tasks/workflow-finalizer.registry.js';
import { createReadyAgentSession } from '../agent-tasks/workflow.pg-test-helper.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { StorageRepository } from '../storage/storage.repository.js';
import { QuotaDispatchService } from './quota-dispatch.service.js';
import {
  QuotaWorkflowFinalizerService,
} from './quota-workflow-finalizer.service.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('QuotaDispatchService PostgreSQL workflow generations', () => {
  it('atomically supersedes only an undispatched generation', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const firstId = await context.service.apply(context.request(100));
      const secondId = await context.service.apply(context.request(10));

      const desired = await context.storage.findQuotaDesired(
        context.serverId,
        context.userId,
      );
      const tasks = await fixture.database.selectFrom('workflow.tasks')
        .selectAll()
        .orderBy('created_at')
        .execute();
      expect(desired).toMatchObject({
        generation: 2,
        limitBytes: 10,
        lastTaskId: secondId,
      });
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toMatchObject({
        id: firstId,
        status: AgentTaskStatus.Failed,
      });
      expect(tasks[0]?.error_json).toMatchObject({ code: 'TASK_SUPERSEDED' });
      expect(tasks[1]).toMatchObject({
        id: secondId,
        status: AgentTaskStatus.Pending,
      });
      expect(tasks[1]?.payload_json).toMatchObject({ generation: 2, diskBytes: 10 });
      expect(await fixture.database.selectFrom('workflow.resource_claims')
        .selectAll()
        .execute()).toEqual([
        expect.objectContaining({ task_id: secondId }),
      ]);
    });
  });

  it('rolls back a new limit while an older physical task may finish', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const firstId = await context.service.apply(context.request(100));
      await fixture.database.updateTable('workflow.tasks')
        .set({
          dispatch_attempt_count: 1,
          started_at: new Date(),
          last_sent_at: new Date(),
        })
        .where('id', '=', firstId)
        .executeTakeFirstOrThrow();

      await expect(context.service.apply(context.request(10))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'QUOTA_MUTATION_IN_PROGRESS' }),
      });
      expect(await context.storage.findQuotaDesired(
        context.serverId,
        context.userId,
      )).toMatchObject({
        generation: 1,
        limitBytes: 100,
        lastTaskId: firstId,
      });
      expect(await fixture.database.selectFrom('workflow.tasks')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow()).toMatchObject({ count: '1' });
    });
  });

  it('accepts only the internal zero-limit drain while a user is deleting', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await fixture.database.updateTable('iam.users')
        .set({ status: UserStatus.Deleting })
        .where('id', '=', context.userId)
        .executeTakeFirstOrThrow();

      await expect(context.service.apply(context.request(10))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'USER_DELETING' }),
      });
      await expect(context.service.apply({
        ...context.request(0),
        allowDeleting: true,
      })).resolves.toEqual(expect.any(String));
      expect(await context.storage.findQuotaDesired(
        context.serverId,
        context.userId,
      )).toMatchObject({ limitBytes: 0, generation: 1 });
    });
  });

  it('rolls back quota projection when workflow enqueue validation fails', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await expect(context.service.apply({
        ...context.request(100),
        numericUserId: 9999,
      })).rejects.toThrow(/numeric quota identity changed/);
      expect(await context.storage.findQuotaDesired(
        context.serverId,
        context.userId,
      )).toBeNull();
      expect(await fixture.database.selectFrom('workflow.tasks')
        .select('id')
        .execute()).toEqual([]);
    });
  });

  it('rejects oversized and duplicate-key internal batches before enqueue', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await expect(context.transactions.run((transaction) =>
        context.service.applyManyInTransaction(
          transaction,
          Array.from(
            { length: MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION + 1 },
            () => context.request(100),
          ),
        ))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'QUOTA_FANOUT_LIMIT' }),
      });
      await expect(context.transactions.run((transaction) =>
        context.service.applyManyInTransaction(
          transaction,
          [context.request(100), context.request(200)],
        ))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'DUPLICATE_QUOTA_MUTATION' }),
      });
      expect(await fixture.database.selectFrom('workflow.tasks')
        .select('id').execute()).toEqual([]);
    });
  });

  it('stages Agent evidence and atomically terminalizes through the registered finalizer', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const taskId = await context.service.apply(context.request(4096));
      const task = await context.repository.findTask(taskId);
      expect(task).toBeTruthy();
      const claimed = await context.dispatch.claimAndBuild(
        context.serverId,
        context.agentSession,
      );
      expect(claimed?.claim.task.id).toBe(taskId);
      await context.dispatch.markSent(claimed!);
      await context.repository.acceptAgentResult(context.serverId, {
        taskId,
        payloadHash: task!.payloadHash,
        status: 'succeeded',
        result: { numericUserId: 1001, hardLimitBytes: 4096 },
      }, context.agentSession);
      expect(await context.worker.process()).toBe(1);
      expect(await context.repository.findTask(taskId)).toMatchObject({
        status: AgentTaskStatus.Succeeded,
        result: { numericUserId: 1001, hardLimitBytes: 4096 },
      });
      expect(await fixture.database.selectFrom('workflow.resource_claims')
        .select('resource_key')
        .where('task_id', '=', taskId)
        .execute()).toEqual([]);
    });
  });
});

async function setup(fixture: PostgresTestDatabase) {
  const transactions = new PgTransactionManager(fixture.database);
  const storage = new StorageRepository(fixture.database);
  const keys = new ResourceKeyService();
  const codec = new AgentTaskPayloadCodecService({
    decryptIfEncrypted: (value: string) => value,
  } as never);
  const workflow = new WorkflowEnqueuePort(
    keys,
    codec,
  );
  const repository = new WorkflowRepository(fixture.database, transactions);
  const serverId = randomUUID();
  const userId = randomUUID();
  await fixture.database.insertInto('infra.servers').values({
    id: serverId,
    name: 'Quota Node',
    slug: `quota-${serverId.slice(0, 8)}`,
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
  await fixture.database.insertInto('iam.users').values({
    id: userId,
    numeric_id: 1001,
    username: `quota-${userId.slice(0, 8)}`,
    password_hash: 'hash',
    display_name: 'Quota User',
    status: UserStatus.Active,
    auth_version: 1,
    authz_version: 1,
  }).execute();
  const service = new QuotaDispatchService(
    transactions,
    storage,
    workflow,
    keys,
  );
  const registry = new WorkflowFinalizerRegistry();
  const registrar = new QuotaWorkflowFinalizerService(registry, storage);
  registrar.onModuleInit();
  const worker = new WorkflowFinalizerWorkerService(repository, registry);
  const dispatch = new WorkflowDispatchService(repository, codec, registry);
  const agentSession = await createReadyAgentSession(repository, serverId);
  return {
    service,
    repository,
    dispatch,
    agentSession,
    worker,
    storage,
    transactions,
    serverId,
    userId,
    request: (diskBytes: number) => ({
      serverId,
      userId,
      numericUserId: 1001,
      diskBytes,
      requestedBy: userId,
    }),
  };
}
