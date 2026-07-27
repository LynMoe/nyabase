import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import {
  AgentTaskKind,
  AgentTaskStatus,
  ServerStatus,
  type TaskResultPayload,
} from '@nyabase/common';
import {
  withPostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AgentTaskPayloadCodecService } from './agent-task-payload-codec.service.js';
import { ResourceKeyService } from './resource-key.service.js';
import {
  WorkflowEnqueuePort,
  type WorkflowEnqueueInput,
} from './workflow-enqueue.port.js';
import { WorkflowRepository } from './workflow.repository.js';
import { WorkflowFinalizerRegistry } from './workflow-finalizer.registry.js';
import { WorkflowDispatchService } from './workflow-dispatch.service.js';
import {
  WorkflowFinalizerWorkerService,
} from './workflow-finalizer-worker.service.js';
import {
  AGENT_TASK_MIN_RETENTION_MS,
  MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW,
} from './agent-task-retention.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('Workflow PostgreSQL durable queue', () => {
  it('enforces canonical Storage and Container task references', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const mountId = randomUUID();
      await expect(database.insertInto('infra.remote_fs_mounts').values({
        id: mountId,
        name: 'fk-proof',
        display_name: 'FK proof',
        description: null,
        type: 'nfs',
        host_mount_point: `/mnt/remote-fs/${mountId}`,
        options: '',
        params: JSON.stringify({
          type: 'nfs',
          nfsServer: '127.0.0.1',
          exportPath: '/export',
          version: '4.2',
        }),
        desired_state: 'active',
        generation: 1,
        last_task_id: randomUUID(),
      }).execute()).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('rolls caller business state, task, claims and outbox back together', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue } = fixture(database);
      const serverId = await seedServer(database);
      await expect(transactions.run(async (transaction) => {
        await enqueue.enqueueInTransaction(
          transaction,
          imageTask(serverId, randomUUID()),
        );
        await transaction.updateTable('infra.servers')
          .set({ name: 'must roll back' })
          .where('id', '=', serverId)
          .execute();
        throw new Error('rollback requested');
      })).rejects.toThrow('rollback requested');

      expect(await taskCount(database)).toBe(0);
      expect(await database.selectFrom('workflow.resource_claims')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow()).toMatchObject({ count: '0' });
      expect(await database.selectFrom('workflow.outbox')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow()).toMatchObject({ count: '0' });
      expect((await database.selectFrom('infra.servers').select('name')
        .where('id', '=', serverId).executeTakeFirstOrThrow()).name).toBe('Node');
    });
  });

  it('admits only one concurrent owner for the same resource claim', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue } = fixture(database);
      const serverId = await seedServer(database);
      const resourceId = randomUUID();
      const attempts = await Promise.allSettled([
        transactions.run((transaction) =>
          enqueue.enqueueInTransaction(transaction, imageTask(serverId, resourceId))),
        transactions.run((transaction) =>
          enqueue.enqueueInTransaction(transaction, imageTask(serverId, resourceId))),
      ]);
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await taskCount(database)).toBe(1);
      expect(await database.selectFrom('workflow.resource_claims')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow()).toMatchObject({ count: '1' });
    });
  });

  it('supersedes only never-dispatched authority in the caller transaction', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue } = fixture(database);
      const serverId = await seedServer(database);
      const resourceId = randomUUID();
      const first = await transactions.run((transaction) =>
        enqueue.enqueueInTransaction(
          transaction,
          imageTask(serverId, resourceId),
        ));
      const successor = await transactions.run(async (transaction) => {
        expect(await enqueue.supersedePendingForResourceInTransaction(
          transaction,
          {
            serverId,
            resourceType: 'image',
            resourceId,
            reason: 'new desired generation',
          },
        )).toEqual([first.taskId]);
        return enqueue.enqueueInTransaction(
          transaction,
          imageTask(serverId, resourceId),
        );
      });
      expect(successor.taskId).not.toBe(first.taskId);
      expect(await database.selectFrom('workflow.tasks')
        .select(['id', 'status'])
        .orderBy('created_at')
        .execute()).toEqual([
        { id: first.taskId, status: AgentTaskStatus.Failed },
        { id: successor.taskId, status: AgentTaskStatus.Pending },
      ]);
      expect(await database.selectFrom('workflow.resource_claims')
        .select(['task_id'])
        .execute()).toEqual([{ task_id: successor.taskId }]);
    });
  });

  it('uses PostgreSQL time for terminalization and production retention under app skew', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue, repository } = fixture(database);
      const serverId = await seedServer(database);
      const resourceId = randomUUID();
      const before = await database.selectNoFrom((expression) =>
        expression.fn<Date>('clock_timestamp').as('now'))
        .executeTakeFirstOrThrow();

      vi.useFakeTimers({ toFake: ['Date'] });
      let taskId: string;
      try {
        vi.setSystemTime(new Date(before.now.getTime() + 365 * 86_400_000));
        const task = await transactions.run((transaction) =>
          enqueue.enqueueInTransaction(
            transaction,
            imageTask(serverId, resourceId),
          ));
        taskId = task.taskId;
        await transactions.run((transaction) =>
          enqueue.supersedePendingForResourceInTransaction(transaction, {
            serverId,
            resourceType: 'image',
            resourceId,
            reason: 'clock authority proof',
          }));
      } finally {
        vi.useRealTimers();
      }

      const after = await database.selectNoFrom((expression) =>
        expression.fn<Date>('clock_timestamp').as('now'))
        .executeTakeFirstOrThrow();
      const terminal = await database.selectFrom('workflow.tasks')
        .select('completed_at')
        .where('id', '=', taskId!)
        .executeTakeFirstOrThrow();
      expect(terminal.completed_at!.getTime()).toBeGreaterThanOrEqual(
        before.now.getTime(),
      );
      expect(terminal.completed_at!.getTime()).toBeLessThanOrEqual(
        after.now.getTime(),
      );
      expect(await repository.purgeTerminalRetention(
        AGENT_TASK_MIN_RETENTION_MS,
      )).toBe(0);
      expect(await repository.findTask(taskId!)).not.toBeNull();
    });
  });

  it('uses PostgreSQL time for retention-window admission under fast and slow app clocks', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue } = fixture(database);
      const serverId = await seedServer(database);
      await sql`
        INSERT INTO workflow.commands (
          id, kind, server_id, resource_type, resource_id, admission_class
        )
        SELECT
          md5('capacity-command-' || series.value::text)::uuid,
          ${AgentTaskKind.ImageEnsurePresent},
          ${serverId}::uuid,
          'image',
          'capacity-' || series.value::text,
          'normal'
        FROM generate_series(
          1,
          ${MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW}
        ) AS series(value)
      `.execute(database);
      await sql`
        INSERT INTO workflow.tasks (
          id, command_id, kind, server_id, resource_type, resource_id,
          payload_json, payload_hash, admission_class, status, completed_at
        )
        SELECT
          md5('capacity-task-' || series.value::text)::uuid,
          md5('capacity-command-' || series.value::text)::uuid,
          ${AgentTaskKind.ImageEnsurePresent},
          ${serverId}::uuid,
          'image',
          'capacity-' || series.value::text,
          '{}'::jsonb,
          repeat('a', 64),
          'normal',
          'succeeded',
          clock_timestamp()
        FROM generate_series(
          1,
          ${MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW}
        ) AS series(value)
      `.execute(database);

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date(Date.now() + 365 * 86_400_000));
        await expect(transactions.run((transaction) =>
          enqueue.enqueueInTransaction(
            transaction,
            imageTask(serverId, randomUUID()),
          ))).rejects.toMatchObject({
          response: expect.objectContaining({
            code: 'AGENT_TASK_RETENTION_WINDOW_CAPACITY_REACHED',
          }),
        });

        await database.updateTable('workflow.tasks')
          .set({
            created_at: sql<Date>`clock_timestamp() - interval '8 days'`,
            completed_at: sql<Date>`clock_timestamp() - interval '8 days'`,
          })
          .execute();
        vi.setSystemTime(new Date(Date.now() - 730 * 86_400_000));
        await expect(transactions.run((transaction) =>
          enqueue.enqueueInTransaction(
            transaction,
            imageTask(serverId, randomUUID()),
          ))).resolves.toMatchObject({ ok: true });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('retains domain facts but clears task pointers during bounded retention', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue, repository } = fixture(database);
      const serverId = await seedServer(database);
      const resourceId = randomUUID();
      const task = await transactions.run((transaction) =>
        enqueue.enqueueInTransaction(
          transaction,
          imageTask(serverId, resourceId),
        ));
      await transactions.run(async (transaction) => {
        await enqueue.supersedePendingForResourceInTransaction(transaction, {
          serverId,
          resourceType: 'image',
          resourceId,
          reason: 'retention proof',
        });
        await transaction.updateTable('workflow.tasks')
          .set({ completed_at: new Date('2020-01-01T00:00:00Z') })
          .where('id', '=', task.taskId)
          .execute();
        const mountId = randomUUID();
        await transaction.insertInto('infra.remote_fs_mounts').values({
          id: mountId,
          name: 'retained-domain-fact',
          display_name: 'Retained domain fact',
          description: null,
          type: 'nfs',
          host_mount_point: `/mnt/remote-fs/${mountId}`,
          options: '',
          params: JSON.stringify({
            type: 'nfs',
            nfsServer: '127.0.0.1',
            exportPath: '/retained',
            version: '4.2',
          }),
          desired_state: 'active',
          generation: 1,
          last_task_id: task.taskId,
        }).execute();
      });

      expect(await repository.purgeTerminalBeforeForTest(
        new Date('2021-01-01T00:00:00Z'),
      )).toBe(1);
      expect(await repository.findTask(task.taskId)).toBeNull();
      expect(await database.selectFrom('infra.remote_fs_mounts')
        .select(['name', 'last_task_id'])
        .where('name', '=', 'retained-domain-fact')
        .executeTakeFirstOrThrow()).toEqual({
        name: 'retained-domain-fact',
        last_task_id: null,
      });
    });
  });

  it('lists bounded requester and capability-scoped task summaries', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue, repository } = fixture(database);
      const serverId = await seedServer(database);
      const userA = randomUUID();
      const userB = randomUUID();
      await database.insertInto('iam.users').values([
        {
          id: userA,
          numeric_id: 1001,
          username: `user-${userA.slice(0, 8)}`,
          password_hash: 'unused',
          display_name: 'User A',
          status: 'active',
          auth_version: 0,
          authz_version: 0,
        },
        {
          id: userB,
          numeric_id: 1002,
          username: `user-${userB.slice(0, 8)}`,
          password_hash: 'unused',
          display_name: 'User B',
          status: 'active',
          auth_version: 0,
          authz_version: 0,
        },
      ]).execute();
      await transactions.run((transaction) =>
        enqueue.enqueueInTransaction(transaction, {
          ...imageTask(serverId, randomUUID()),
          requestedBy: userA,
        }));
      await transactions.run((transaction) =>
        enqueue.enqueueInTransaction(transaction, {
          ...imageTask(serverId, randomUUID()),
          requestedBy: userB,
        }));
      expect(await repository.listTasks({ requestedBy: userA }))
        .toHaveLength(1);
      expect(await repository.listTasks({
        scopes: [{
          resourceType: 'image',
          kinds: [AgentTaskKind.ImageEnsurePresent],
        }],
      })).toHaveLength(2);
      expect(await repository.listTasks({
        scopes: [{
          resourceType: 'quota',
          kinds: [AgentTaskKind.QuotaEnsure],
        }],
      })).toEqual([]);
    });
  });

  it('leases one physical task per server and reclaims an expired worker crash', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue, repository } = fixture(database);
      const serverId = await seedServer(database);
      await transactions.run((transaction) =>
        enqueue.enqueueInTransaction(transaction, imageTask(serverId, randomUUID())));
      await transactions.run((transaction) =>
        enqueue.enqueueInTransaction(transaction, imageTask(serverId, randomUUID())));

      const now = new Date('2026-07-25T00:00:00Z');
      const agentSession = await readyAgentSession(repository, serverId, now);
      const claims = await Promise.all([
        repository.claimNextDispatch(serverId, 'worker-a', {
          now,
          leaseMs: 1_000,
          agentSession,
        }),
        repository.claimNextDispatch(serverId, 'worker-b', {
          now,
          leaseMs: 1_000,
          agentSession,
        }),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const first = claims.find(Boolean)!;

      const reclaimed = await repository.claimNextDispatch(
        serverId,
        'worker-c',
        {
          now: new Date(now.getTime() + 1_001),
          leaseMs: 1_000,
          agentSession,
        },
      );
      expect(reclaimed?.task.id).toBe(first.task.id);
      expect(reclaimed?.claimToken).not.toBe(first.claimToken);
      expect(reclaimed?.task.dispatchAttemptCount).toBe(2);
      expect(reclaimed?.task.startedAt).toBeNull();
      expect(reclaimed?.task.lastSentAt).toBeNull();
      const attempts = await database.selectFrom('workflow.task_attempts')
        .select(['state', 'claim_token'])
        .where('task_id', '=', first.task.id)
        .orderBy('id')
        .execute();
      expect(attempts.map((attempt) => attempt.state)).toEqual(['abandoned', 'claimed']);

      const sentAt = new Date(now.getTime() + 1_010);
      expect(await repository.markDispatchSent(
        reclaimed!.task.id,
        reclaimed!.claimToken,
        agentSession,
        sentAt,
      )).toBe(true);
      expect(await database.selectFrom('workflow.tasks')
        .select(['started_at', 'retry_window_started_at', 'last_sent_at'])
        .where('id', '=', reclaimed!.task.id)
        .executeTakeFirstOrThrow()).toEqual({
        started_at: sentAt,
        retry_window_started_at: sentAt,
        last_sent_at: sentAt,
      });
    });
  });

  it('dispatches only kinds with an atomic PostgreSQL finalizer', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue, repository, payloadCodec } = fixture(database);
      const serverId = await seedServer(database);
      const enqueued = await transactions.run((transaction) =>
        enqueue.enqueueInTransaction(
          transaction,
          imageTask(serverId, randomUUID()),
        ));
      const registry = new WorkflowFinalizerRegistry();
      const agentSession = await readyAgentSession(repository, serverId);
      const dispatch = new WorkflowDispatchService(
        repository,
        payloadCodec,
        registry,
      );
      await expect(dispatch.claimAndBuild(serverId)).resolves.toBeNull();
      expect((await repository.findTask(enqueued.taskId))?.dispatchAttemptCount).toBe(0);

      registry.register(AgentTaskKind.ImageEnsurePresent, async () => ({
        status: AgentTaskStatus.Succeeded,
        result: { projected: true },
        releaseClaims: true,
      }));
      const claimed = await dispatch.claimAndBuild(serverId, agentSession);
      expect(claimed?.payload).toMatchObject({
        taskId: enqueued.taskId,
        kind: AgentTaskKind.ImageEnsurePresent,
      });
      await dispatch.markSent(claimed!);
      const task = claimed!.claim.task;
      await repository.acceptAgentResult(serverId, {
        taskId: task.id,
        payloadHash: task.payloadHash,
        status: 'succeeded',
        result: {
          imageId: task.resourceId,
          dockerId: 'sha256:dispatch-gate',
          dockerRef: (task.payload as { dockerRef: string }).dockerRef,
        },
      }, agentSession);
      const worker = new WorkflowFinalizerWorkerService(
        repository,
        registry,
      );
      await expect(worker.process()).resolves.toBe(1);
      expect(await repository.findTask(task.id)).toMatchObject({
        status: AgentTaskStatus.Succeeded,
        result: { projected: true },
      });
    });
  });

  it('stages terminal evidence before ACK and finalizes exactly once', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue, repository } = fixture(database);
      const serverId = await seedServer(database);
      const enqueued = await transactions.run((transaction) =>
        enqueue.enqueueInTransaction(
          transaction,
          imageTask(serverId, randomUUID()),
        ));
      const agentSession = await readyAgentSession(repository, serverId);
      const claimed = await repository.claimNextDispatch(serverId, 'dispatcher', {
        agentSession,
      });
      expect(claimed?.task.id).toBe(enqueued.taskId);
      expect(await repository.markDispatchSent(
        claimed!.task.id,
        claimed!.claimToken,
        agentSession,
      )).toBe(true);
      const result: TaskResultPayload = {
        taskId: enqueued.taskId,
        payloadHash: claimed!.task.payloadHash,
        status: 'succeeded',
        result: {
          imageId: claimed!.task.resourceId,
          dockerId: 'sha256:image-a',
          dockerRef: (claimed!.task.payload as { dockerRef: string }).dockerRef,
        },
      };
      const accepted = await repository.acceptAgentResult(serverId, result, agentSession);
      expect(accepted).toMatchObject({
        accepted: true,
        terminal: true,
        finalizerPending: true,
      });
      await expect(repository.acceptAgentResult(
        serverId,
        result,
        agentSession,
      )).resolves.toMatchObject({
        accepted: true,
      });

      const [workerA, workerB] = await Promise.all([
        repository.claimFinalizers('finalizer-a'),
        repository.claimFinalizers('finalizer-b'),
      ]);
      expect([...workerA, ...workerB]).toHaveLength(1);
      const finalizer = [...workerA, ...workerB][0]!;
      expect(await repository.completeFinalizer(
        finalizer.task.id,
        finalizer.generation,
        finalizer.claimToken,
        {
          status: AgentTaskStatus.Succeeded,
          result: { projected: true },
          releaseClaims: true,
        },
      )).toBe(true);
      expect(await repository.completeFinalizer(
        finalizer.task.id,
        finalizer.generation,
        finalizer.claimToken,
        {
          status: AgentTaskStatus.Succeeded,
          result: { projected: true },
          releaseClaims: true,
        },
      )).toBe(false);
      expect(await database.selectFrom('workflow.resource_claims')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow()).toMatchObject({ count: '0' });
    });
  });

  it('fences Agent generations and stores immutable monotonic observations', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository } = fixture(database);
      const serverId = await seedServer(database);
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      const gatewayA = 'gateway:test-a';
      const gatewayB = 'gateway:test-b';
      const admissions = await Promise.allSettled([
        repository.admitAgentSession({
          id: sessionA,
          serverId,
          sessionToken: `token:${sessionA}`,
          hostFingerprint: 'host-a',
          configFingerprint: 'config-a',
          gatewayId: gatewayA,
        }),
        repository.admitAgentSession({
          id: sessionB,
          serverId,
          sessionToken: `token:${sessionB}`,
          hostFingerprint: 'host-a',
          configFingerprint: 'config-a',
          gatewayId: gatewayB,
        }),
      ]);
      expect(admissions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(admissions.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const admitted = admissions.find(
        (result): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof repository.admitAgentSession>>
        > => result.status === 'fulfilled',
      )!.value;
      expect(admitted.generation).toBe(1);

      expect(await repository.markAgentSessionReady(
        serverId,
        admitted.id,
        admitted.generation,
        admitted.gatewayId,
      )).toMatchObject({ state: 'ready', generation: 1 });
      const first = await repository.recordAgentObservation({
        serverId,
        sessionId: admitted.id,
        sessionGeneration: admitted.generation,
        gatewayId: admitted.gatewayId,
        sequence: 7,
        kind: 'state_report',
        payload: { containers: [], observedAt: 123 },
      });
      expect(first).toMatchObject({ accepted: true, duplicate: false });
      expect(await repository.recordAgentObservation({
        serverId,
        sessionId: admitted.id,
        sessionGeneration: admitted.generation,
        gatewayId: admitted.gatewayId,
        sequence: 7,
        kind: 'state_report',
        payload: { containers: [], observedAt: 123 },
      })).toMatchObject({
        accepted: true,
        duplicate: true,
        payloadHash: first.payloadHash,
      });
      await expect(repository.recordAgentObservation({
        serverId,
        sessionId: admitted.id,
        sessionGeneration: admitted.generation,
        gatewayId: admitted.gatewayId,
        sequence: 7,
        kind: 'state_report',
        payload: { containers: ['changed'], observedAt: 123 },
      })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'AGENT_OBSERVATION_CONFLICT' }),
      });
      await expect(repository.recordAgentObservation({
        serverId,
        sessionId: admitted.id,
        sessionGeneration: admitted.generation,
        gatewayId: admitted.gatewayId,
        sequence: 6,
        kind: 'state_report',
        payload: { containers: [] },
      })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'AGENT_OBSERVATION_STALE' }),
      });

      expect(await repository.retireAgentSession(
        serverId,
        admitted.id,
        'socket closed',
      )).toBe(true);
      await expect(repository.recordAgentObservation({
        serverId,
        sessionId: admitted.id,
        sessionGeneration: admitted.generation,
        gatewayId: admitted.gatewayId,
        sequence: 8,
        kind: 'state_report',
        payload: { containers: [] },
      })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'AGENT_SESSION_STALE' }),
      });

      const successorId = admitted.id === sessionA ? sessionB : sessionA;
      const successor = await repository.admitAgentSession({
        id: successorId,
        serverId,
        sessionToken: `successor:${successorId}`,
        hostFingerprint: 'host-a',
        configFingerprint: 'config-a',
        gatewayId: admitted.gatewayId === gatewayA ? gatewayB : gatewayA,
      });
      expect(successor).toMatchObject({
        id: successorId,
        generation: 2,
        state: 'admitted',
      });
    });
  });

  it('holds an exact report fence without self-deadlock and makes takeover wait', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository } = fixture(database);
      const serverId = await seedServer(database);
      const sessionId = randomUUID();
      const gatewayId = 'gateway:fence-a';
      const admitted = await repository.admitAgentSession({
        id: sessionId,
        serverId,
        sessionToken: `token:${sessionId}`,
        hostFingerprint: 'host-fence',
        configFingerprint: 'config-fence',
        gatewayId,
      });
      await repository.markAgentSessionReady(
        serverId,
        sessionId,
        admitted.generation,
        gatewayId,
      );
      const binding = {
        serverId,
        sessionId,
        sessionGeneration: admitted.generation,
        gatewayId,
      };
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const report = repository.runWithAgentSessionFence(binding, async () => {
        await repository.recordAgentObservation({
          ...binding,
          sequence: 1,
          kind: 'state_report',
          payload: { containers: [], observedAt: 1 },
        });
        enter();
        await released;
      });
      await entered;

      const retirement = repository.retireAgentSession(
        serverId,
        sessionId,
        'gateway takeover',
      );
      await expect(Promise.race([
        retirement.then(() => 'retired'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ])).resolves.toBe('waiting');

      release();
      await expect(report).resolves.toBeUndefined();
      await expect(retirement).resolves.toBe(true);
      await expect(repository.runWithAgentSessionFence(binding, async () => undefined))
        .rejects.toMatchObject({
          response: expect.objectContaining({ code: 'AGENT_SESSION_STALE' }),
        });
    });
  });

  it('rejects a runtime projection when report processing crosses the durable lease', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository } = fixture(database);
      const serverId = await seedServer(database);
      const sessionId = randomUUID();
      const gatewayId = 'gateway:lease-proof';
      const admitted = await repository.admitAgentSession({
        id: sessionId,
        serverId,
        sessionToken: `token:${sessionId}`,
        hostFingerprint: 'host-lease',
        configFingerprint: 'config-lease',
        gatewayId,
      });
      await repository.markAgentSessionReady(
        serverId,
        sessionId,
        admitted.generation,
        gatewayId,
      );
      await sql`
        update workflow.agent_sessions
        set lease_expires_at = clock_timestamp() + interval '75 milliseconds'
        where id = ${sessionId}
      `.execute(database);
      const binding = {
        serverId,
        sessionId,
        sessionGeneration: admitted.generation,
        gatewayId,
      };
      let projectionAccepted: boolean | undefined;
      await expect(repository.runWithAgentSessionFence(binding, async () => {
        await new Promise((resolve) => setTimeout(resolve, 125));
        projectionAccepted = await repository.publishAgentRuntimeProjection({
          ...binding,
          sequence: 1,
          stateReport: { containers: [] },
          observedAt: new Date('2026-01-01T00:00:00Z'),
        });
      })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'AGENT_SESSION_STALE' }),
      });
      expect(projectionAccepted).toBe(false);
      expect(await database
        .selectFrom('workflow.agent_runtime_projections')
        .select(['state_report_json', 'state_observed_at'])
        .where('server_id', '=', serverId)
        .executeTakeFirst()).toBeUndefined();
    });
  });

  it('publishes a session-fenced Docker daemon projection independently of full reports', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository } = fixture(database);
      const serverId = await seedServer(database);
      const sessionId = randomUUID();
      const gatewayId = 'gateway:docker-status';
      const admitted = await repository.admitAgentSession({
        id: sessionId,
        serverId,
        sessionToken: `token:${sessionId}`,
        hostFingerprint: 'host-docker-status',
        configFingerprint: 'config-docker-status',
        gatewayId,
      });
      const binding = {
        serverId,
        sessionId,
        sessionGeneration: admitted.generation,
        gatewayId,
      };
      await repository.recordAgentObservation({
        ...binding,
        sequence: 0,
        kind: 'hello',
        payload: { serverId },
      });
      const status = {
        serverId,
        state: 'active',
        active: true,
        storageDriver: 'overlay2',
      };

      await expect(repository.publishAgentDockerDaemonProjection({
        ...binding,
        status,
      })).resolves.toBe(true);
      await expect(database
        .selectFrom('workflow.agent_runtime_projections')
        .select('docker_daemon_json')
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow()).resolves.toMatchObject({
          docker_daemon_json: status,
        });

      await repository.retireAgentSession(serverId, sessionId, 'test fence');
      await expect(repository.publishAgentDockerDaemonProjection({
        ...binding,
        status: { ...status, state: 'inactive' },
      })).resolves.toBe(false);
    });
  });

  it('does not mark or enqueue a dispatch that waited past the Agent lease', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue, repository } = fixture(database);
      const serverId = await seedServer(database);
      const sessionId = randomUUID();
      const gatewayId = 'gateway:send-lease';
      const admitted = await repository.admitAgentSession({
        id: sessionId,
        serverId,
        sessionToken: `token:${sessionId}`,
        hostFingerprint: 'host-send',
        configFingerprint: 'config-send',
        gatewayId,
      });
      await repository.markAgentSessionReady(
        serverId,
        sessionId,
        admitted.generation,
        gatewayId,
      );
      const enqueued = await transactions.run((transaction) =>
        enqueue.enqueueInTransaction(
          transaction,
          imageTask(serverId, randomUUID()),
        ));
      const agentSession = {
        id: sessionId,
        generation: admitted.generation,
        gatewayId,
      };
      const claim = await repository.claimNextDispatch(serverId, 'dispatcher', {
        agentSession,
      });
      expect(claim?.task.id).toBe(enqueued.taskId);

      let blockerEntered!: () => void;
      let releaseBlocker!: () => void;
      const entered = new Promise<void>((resolve) => { blockerEntered = resolve; });
      const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
      const blocker = database.connection().execute(async (connection) => {
        await sql`
          select pg_advisory_lock(
            hashtext('nyabase-agent-session'),
            hashtext(${serverId})
          )
        `.execute(connection);
        blockerEntered();
        await release;
        await sql`
          select pg_advisory_unlock(
            hashtext('nyabase-agent-session'),
            hashtext(${serverId})
          )
        `.execute(connection);
      });
      await entered;
      await sql`
        update workflow.agent_sessions
        set lease_expires_at = clock_timestamp() + interval '75 milliseconds'
        where id = ${sessionId}
      `.execute(database);
      let sendCount = 0;
      const sending = repository.markDispatchSentAndSend(
        enqueued.taskId,
        claim!.claimToken,
        { serverId, ...agentSession },
        () => {
          sendCount += 1;
          return true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 125));
      releaseBlocker();
      await blocker;
      await expect(sending).resolves.toBe(false);
      expect(sendCount).toBe(0);
      expect(await database
        .selectFrom('workflow.task_attempts')
        .select(['state', 'sent_at'])
        .where('task_id', '=', enqueued.taskId)
        .executeTakeFirstOrThrow()).toEqual({
        state: 'claimed',
        sent_at: null,
      });
    });
  });

  it('explicitly releases inventory quarantine only after the audit callback commits', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { repository } = fixture(database);
      const serverId = await seedServer(database);
      await database
        .updateTable('infra.servers')
        .set({
          status: ServerStatus.AgentQuarantined,
          quarantine_code: 'AGENT_INVENTORY_FAULT',
          quarantine_message: 'provider-owned local DataDir orphan detected',
        })
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow();

      await expect(repository.retryAgentQuarantine(
        serverId,
        async (_transaction, taskIds) => {
          expect(taskIds).toEqual([]);
          throw new Error('audit unavailable');
        },
      )).rejects.toThrow('audit unavailable');
      expect(await database.selectFrom('infra.servers')
        .select(['status', 'quarantine_code', 'quarantine_message'])
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow()).toEqual({
        status: ServerStatus.AgentQuarantined,
        quarantine_code: 'AGENT_INVENTORY_FAULT',
        quarantine_message: 'provider-owned local DataDir orphan detected',
      });

      await expect(repository.retryAgentQuarantine(
        serverId,
        async (transaction, taskIds) => {
          expect(taskIds).toEqual([]);
          expect(await transaction.selectFrom('infra.servers')
            .select(['status', 'quarantine_code'])
            .where('id', '=', serverId)
            .executeTakeFirstOrThrow()).toEqual({
            status: ServerStatus.AgentQuarantined,
            quarantine_code: 'AGENT_INVENTORY_FAULT',
          });
        },
      )).resolves.toEqual([]);
      expect(await database.selectFrom('infra.servers')
        .select(['status', 'quarantine_code', 'quarantine_message'])
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow()).toEqual({
        status: ServerStatus.Unknown,
        quarantine_code: null,
        quarantine_message: null,
      });
    });
  });

  it('fail-stops unsafe quota evidence and retries only retained exact authority', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue, repository } = fixture(database);
      const serverId = await seedServer(database);
      const sessionId = randomUUID();
      const admitted = await repository.admitAgentSession({
        id: sessionId,
        serverId,
        sessionToken: `token:${sessionId}`,
        hostFingerprint: 'host-quota',
        configFingerprint: 'config-quota',
        gatewayId: 'gateway:quota',
      });
      await repository.markAgentSessionReady(
        serverId,
        sessionId,
        admitted.generation,
        admitted.gatewayId,
      );
      const enqueued = await transactions.run((transaction) =>
        enqueue.enqueueInTransaction(
          transaction,
          quotaTask(serverId, randomUUID()),
        ));
      const binding = {
        id: sessionId,
        generation: admitted.generation,
        gatewayId: admitted.gatewayId,
      };
      const claim = await repository.claimNextDispatch(serverId, 'dispatcher', {
        agentSession: binding,
      });
      expect(claim?.task.id).toBe(enqueued.taskId);
      expect(await repository.markDispatchSent(
        claim!.task.id,
        claim!.claimToken,
        binding,
      )).toBe(true);
      const accepted = await repository.acceptAgentResult(serverId, {
        taskId: enqueued.taskId,
        payloadHash: claim!.task.payloadHash,
        status: 'failed',
        error: {
          code: 'quota_mismatch',
          message: 'hard limit remained zero',
        },
        observed: {
          numericUserId: 1001,
          hardLimitBytes: 0,
        },
      }, binding);
      expect(accepted).toMatchObject({
        accepted: true,
        terminal: true,
        finalizerPending: false,
        serverQuarantined: true,
      });
      expect(await repository.findTask(enqueued.taskId)).toMatchObject({
        status: AgentTaskStatus.Failed,
        failureStage: 'agent',
        error: expect.objectContaining({ code: 'AGENT_QUOTA_OUTCOME_UNSAFE' }),
      });
      expect(await database.selectFrom('infra.servers')
        .select(['status', 'quarantine_code'])
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow()).toEqual({
        status: ServerStatus.AgentQuarantined,
        quarantine_code: 'AGENT_TASK_FAIL_STOP',
      });
      expect(await repository.findCurrentAgentSession(serverId)).toBeNull();
      expect(await database.selectFrom('workflow.resource_claims')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .where('task_id', '=', enqueued.taskId)
        .executeTakeFirstOrThrow()).toMatchObject({ count: '1' });

      await expect(repository.retryAgentQuarantine(
        serverId,
        async () => {
          throw new Error('audit unavailable');
        },
      )).rejects.toThrow('audit unavailable');
      expect(await repository.findTask(enqueued.taskId)).toMatchObject({
        status: AgentTaskStatus.Failed,
        failureStage: 'agent',
      });
      expect(await database.selectFrom('infra.servers')
        .select(['status', 'quarantine_code'])
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow()).toEqual({
        status: ServerStatus.AgentQuarantined,
        quarantine_code: 'AGENT_TASK_FAIL_STOP',
      });

      await expect(repository.retryAgentQuarantine(
        serverId,
        async (transaction, taskIds) => {
          expect(taskIds).toEqual([enqueued.taskId]);
          expect(await transaction.selectFrom('workflow.tasks')
            .select('status')
            .where('id', '=', enqueued.taskId)
            .executeTakeFirstOrThrow()).toEqual({
            status: AgentTaskStatus.Failed,
          });
        },
      )).resolves.toEqual([enqueued.taskId]);
      expect(await repository.findTask(enqueued.taskId)).toMatchObject({
        status: AgentTaskStatus.Pending,
        admissionClass: 'safety',
        agentResult: null,
        error: null,
        dispatchAttemptCount: 1,
      });
      expect(await database.selectFrom('infra.servers')
        .select(['status', 'quarantine_code'])
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow()).toEqual({
        status: ServerStatus.Unknown,
        quarantine_code: null,
      });
      expect(await database.selectFrom('workflow.resource_claims')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .where('task_id', '=', enqueued.taskId)
        .executeTakeFirstOrThrow()).toMatchObject({ count: '1' });

      const recoverySessionId = randomUUID();
      const recoverySession = await repository.admitAgentSession({
        id: recoverySessionId,
        serverId,
        sessionToken: `token:${recoverySessionId}`,
        hostFingerprint: 'host-quota',
        configFingerprint: 'config-quota',
        gatewayId: 'gateway:quota-recovery',
      });
      await repository.markAgentSessionReady(
        serverId,
        recoverySessionId,
        recoverySession.generation,
        recoverySession.gatewayId,
      );
      await database
        .updateTable('infra.servers')
        .set({ status: ServerStatus.Online })
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow();
      const recoveryClaim = await repository.claimNextDispatch(
        serverId,
        'recovery-dispatcher',
        {
          agentSession: {
            id: recoverySessionId,
            generation: recoverySession.generation,
            gatewayId: recoverySession.gatewayId,
          },
        },
      );
      expect(recoveryClaim).toMatchObject({
        task: {
          id: enqueued.taskId,
          dispatchAttemptCount: 2,
        },
      });
      expect(await database
        .selectFrom('workflow.task_attempts')
        .select(['attempt_no', 'state'])
        .where('task_id', '=', enqueued.taskId)
        .orderBy('attempt_no')
        .execute()).toEqual([
        { attempt_no: 1, state: 'result_received' },
        { attempt_no: 2, state: 'claimed' },
      ]);
    });
  });

  it('claims outbox rows with SKIP LOCKED and completes by claim token', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, enqueue, repository } = fixture(database);
      const serverId = await seedServer(database);
      await transactions.run((transaction) =>
        enqueue.enqueueInTransaction(transaction, imageTask(serverId, randomUUID())));
      const [a, b] = await Promise.all([
        repository.claimOutbox('outbox-a'),
        repository.claimOutbox('outbox-b'),
      ]);
      expect([...a, ...b]).toHaveLength(1);
      const claim = [...a, ...b][0]!;
      expect(await repository.completeOutboxClaims([claim])).toBe(1);
      expect(await repository.completeOutboxClaims([claim])).toBe(0);
    });
  });

  it('uses the PostgreSQL clock for distributed due times and leases under app skew', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
      await withPostgresTestDatabase(async ({ database }) => {
        const { transactions, enqueue, repository } = fixture(database);
        const serverId = await seedServer(database);
        const enqueued = await transactions.run((transaction) =>
          enqueue.enqueueInTransaction(
            transaction,
            imageTask(serverId, randomUUID()),
          ));
        await transactions.run((transaction) =>
          repository.enqueueReconcileInTransaction(transaction, {
            dedupeKey: `server:${serverId}:clock-skew`,
            serverId,
            resourceType: 'server',
            resourceId: serverId,
            reason: 'database clock proof',
          }));

        // A far-future application clock must not push durable work out of
        // reach. A far-past clock must not create already-expired leases that
        // a second worker can claim concurrently.
        vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
        const agentSession = await readyAgentSession(repository, serverId);
        const dispatch = await repository.claimNextDispatch(
          serverId,
          'clock-dispatch-a',
          { agentSession },
        );
        expect(dispatch?.task.id).toBe(enqueued.taskId);
        await expect(repository.claimNextDispatch(
          serverId,
          'clock-dispatch-b',
          { agentSession },
        )).resolves.toBeNull();

        const databaseNow = await repository.currentDatabaseTime();
        expect(dispatch!.leaseExpiresAt.getTime()).toBeGreaterThan(
          databaseNow.getTime(),
        );
        expect(dispatch!.leaseExpiresAt.getTime()).toBeLessThan(
          databaseNow.getTime() + 60_000,
        );

        const outbox = await repository.claimOutbox('clock-outbox-a');
        expect(outbox).toHaveLength(1);
        expect(await repository.completeOutboxClaims([outbox[0]!])).toBe(1);
        await expect(repository.claimOutbox('clock-outbox-b')).resolves.toEqual([]);
        const completedOutbox = await database
          .selectFrom('workflow.outbox')
          .select('id')
          .where('id', '=', outbox[0]!.id)
          .executeTakeFirst();
        expect(completedOutbox).toBeUndefined();

        const reconcile = await repository.claimReconcile('clock-reconcile-a');
        expect(reconcile).toHaveLength(1);
        expect(await repository.deferReconcile(
          reconcile[0]!.id,
          reconcile[0]!.claimToken,
          new Error('clock proof'),
          { afterMs: 1_000 },
        )).toBe(true);
        await expect(repository.claimReconcile('clock-reconcile-b'))
          .resolves.toEqual([]);

        expect(await repository.markDispatchSent(
          dispatch!.task.id,
          dispatch!.claimToken,
          agentSession,
        )).toBe(true);
        await repository.acceptAgentResult(serverId, {
          taskId: dispatch!.task.id,
          payloadHash: dispatch!.task.payloadHash,
          status: 'succeeded',
          result: {
            imageId: dispatch!.task.resourceId,
            dockerId: 'sha256:clock-proof',
            dockerRef: (dispatch!.task.payload as { dockerRef: string }).dockerRef,
          },
        }, agentSession);
        const finalizer = await repository.claimFinalizers('clock-finalizer-a');
        expect(finalizer).toHaveLength(1);
        await expect(repository.claimFinalizers('clock-finalizer-b'))
          .resolves.toEqual([]);
        expect(finalizer[0]!.leaseExpiresAt.getTime()).toBeGreaterThan(
          databaseNow.getTime(),
        );
        expect(await repository.deferFinalizer(
          finalizer[0]!.task.id,
          finalizer[0]!.generation,
          finalizer[0]!.claimToken,
          new Error('clock proof'),
          { afterMs: 1_000 },
        )).toBe(true);
        const retryAt = (await database
          .selectFrom('workflow.tasks')
          .select('finalizer_retry_at')
          .where('id', '=', finalizer[0]!.task.id)
          .executeTakeFirstOrThrow()).finalizer_retry_at;
        expect(retryAt?.getTime()).toBeGreaterThan(databaseNow.getTime());
        expect(retryAt?.getTime()).toBeLessThan(databaseNow.getTime() + 10_000);

        // Result-driven retry scheduling is equally database-authoritative;
        // a future-skewed Gateway must not defer a retry for decades.
        vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
        const retryEnqueued = await transactions.run((transaction) =>
          enqueue.enqueueInTransaction(
            transaction,
            imageTask(serverId, randomUUID()),
          ));
        const retryDispatch = await repository.claimNextDispatch(
          serverId,
          'clock-retry-dispatch',
          { agentSession },
        );
        expect(retryDispatch?.task.id).toBe(retryEnqueued.taskId);
        expect(await repository.markDispatchSent(
          retryDispatch!.task.id,
          retryDispatch!.claimToken,
          agentSession,
        )).toBe(true);
        const retryDatabaseNow = await repository.currentDatabaseTime();
        await expect(repository.acceptAgentResult(serverId, {
          taskId: retryDispatch!.task.id,
          payloadHash: retryDispatch!.task.payloadHash,
          status: 'incomplete',
          error: {
            code: 'INTERRUPTED',
            message: 'retry the immutable task',
          },
        }, agentSession)).resolves.toMatchObject({
          accepted: false,
          terminal: false,
        });
        const retrySchedule = await database
          .selectFrom('workflow.tasks')
          .select('next_dispatch_at')
          .where('id', '=', retryDispatch!.task.id)
          .executeTakeFirstOrThrow();
        expect(retrySchedule.next_dispatch_at?.getTime()).toBeGreaterThan(
          retryDatabaseNow.getTime(),
        );
        expect(retrySchedule.next_dispatch_at?.getTime()).toBeLessThan(
          retryDatabaseNow.getTime() + 10_000,
        );
        const retryWake = await database
          .selectFrom('workflow.outbox')
          .select('available_at')
          .where('topic', '=', 'dispatch')
          .orderBy('id', 'desc')
          .executeTakeFirstOrThrow();
        expect(retryWake.available_at.getTime()).toBeGreaterThan(
          retryDatabaseNow.getTime(),
        );
        expect(retryWake.available_at.getTime()).toBeLessThan(
          retryDatabaseNow.getTime() + 10_000,
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates reconcile intent and reclaims an expired worker lease', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, repository } = fixture(database);
      const serverId = await seedServer(database);
      const now = new Date('2026-07-25T00:00:00Z');
      const firstId = await transactions.run((transaction) =>
        repository.enqueueReconcileInTransaction(transaction, {
          dedupeKey: `server:${serverId}:inventory`,
          serverId,
          resourceType: 'server',
          resourceId: serverId,
          reason: 'initial observation',
          payload: { generation: 1 },
          dueAt: now,
        }));
      const duplicateId = await transactions.run((transaction) =>
        repository.enqueueReconcileInTransaction(transaction, {
          dedupeKey: `server:${serverId}:inventory`,
          serverId,
          resourceType: 'server',
          resourceId: serverId,
          reason: 'newer observation',
          payload: { generation: 2 },
          dueAt: now,
        }));
      expect(duplicateId).toBe(firstId);

      const [a, b] = await Promise.all([
        repository.claimReconcile('reconcile-a', 1, { now, leaseMs: 1_000 }),
        repository.claimReconcile('reconcile-b', 1, { now, leaseMs: 1_000 }),
      ]);
      expect([...a, ...b]).toHaveLength(1);
      expect([...a, ...b][0]).toMatchObject({
        id: firstId,
        reason: 'newer observation',
        payload: { generation: 2 },
      });
      const reclaimed = await repository.claimReconcile(
        'reconcile-c',
        1,
        { now: new Date(now.getTime() + 1_001), leaseMs: 1_000 },
      );
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]?.claimToken).not.toBe([...a, ...b][0]?.claimToken);
      expect(await repository.completeReconcile(
        reclaimed[0]!.id,
        reclaimed[0]!.claimToken,
      )).toBe(true);
    });
  });
});

function fixture(database: Parameters<
  Parameters<typeof withPostgresTestDatabase>[0]
>[0]['database']) {
  const transactions = new PgTransactionManager(database);
  const payloadCodec = new AgentTaskPayloadCodecService({
    decryptIfEncrypted: (value: string) => value,
  } as never);
  return {
    transactions,
    payloadCodec,
    enqueue: new WorkflowEnqueuePort(new ResourceKeyService(), payloadCodec),
    repository: new WorkflowRepository(database, transactions, payloadCodec),
  };
}

async function seedServer(
  database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'],
): Promise<string> {
  const id = randomUUID();
  await database.insertInto('infra.servers').values({
    id,
    name: 'Node',
    slug: `node-${id.slice(0, 8)}`,
    agent_token_hash: id.replaceAll('-', '').padEnd(64, '0'),
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
  return id;
}

async function readyAgentSession(
  repository: WorkflowRepository,
  serverId: string,
  now = new Date(),
) {
  const id = randomUUID();
  const gatewayId = `gateway:test:${id}`;
  const admitted = await repository.admitAgentSession({
    id,
    serverId,
    sessionToken: `token:${id}`,
    hostFingerprint: `host:${id}`,
    configFingerprint: `config:${id}`,
    gatewayId,
    now,
  });
  await repository.markAgentSessionReady(
    serverId,
    id,
    admitted.generation,
    gatewayId,
    now,
  );
  return {
    id,
    generation: admitted.generation,
    gatewayId,
  };
}

function imageTask(serverId: string, imageId: string): WorkflowEnqueueInput {
  return {
    kind: AgentTaskKind.ImageEnsurePresent,
    serverId,
    resourceType: 'image',
    resourceId: imageId,
    requestedBy: null,
    payload: {
      dockerRef: `registry.example/${imageId}:1`,
      imageId,
    },
    resourceKeys: [`image:${serverId}:${imageId}`],
  };
}

function quotaTask(serverId: string, userId: string): WorkflowEnqueueInput {
  return {
    kind: AgentTaskKind.QuotaEnsure,
    serverId,
    resourceType: 'quota',
    resourceId: userId,
    requestedBy: null,
    payload: {
      generation: 1,
      numericUserId: 1001,
      diskBytes: 4096,
    },
    resourceKeys: [`quota:${serverId}:${userId}`],
  };
}

async function taskCount(
  database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'],
): Promise<number> {
  const row = await database.selectFrom('workflow.tasks')
    .select((expression) => expression.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
