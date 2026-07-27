import { randomUUID } from 'node:crypto';
import {
  AgentTaskKind,
  AgentTaskStatus,
  ServerStatus,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { WorkflowFinalizerRegistry } from '../agent-tasks/workflow-finalizer.registry.js';
import { WorkflowFinalizerWorkerService } from '../agent-tasks/workflow-finalizer-worker.service.js';
import { createReadyAgentSession } from '../agent-tasks/workflow.pg-test-helper.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { ImageWorkflowFinalizerService } from './image-workflow-finalizer.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const dockerRef = 'registry.example/nyabase/image:latest';
const runtimeOverrides = {
  uid: 0,
  entrypoint: null,
  cmd: null,
  init: false,
};

describePg('Image Workflow finalizer PostgreSQL barrier', () => {
  it('registers both kinds and accepts a duplicate terminal result before ACK', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await setup(database, 1);
      expect(fixture.registry.supportedKinds()).toEqual([
        AgentTaskKind.ImageEnsureAbsent,
        AgentTaskKind.ImageEnsurePresent,
      ]);
      const enqueued = await fixture.transactions.run((transaction) =>
        fixture.enqueue.enqueueInTransaction(transaction, {
          kind: AgentTaskKind.ImageEnsurePresent,
          serverId: fixture.serverIds[0]!,
          resourceType: 'image',
          resourceId: fixture.imageId,
          requestedBy: null,
          payload: { dockerRef, imageId: fixture.imageId },
          resourceKeys: [
            fixture.keys.image(fixture.serverIds[0]!, fixture.imageId),
          ],
        }));
      const claim = await fixture.workflowRepository.claimNextDispatch(
        fixture.serverIds[0]!,
        'dispatcher',
        { agentSession: fixture.agentSessions.get(fixture.serverIds[0]!)! },
      );
      expect(claim?.task.id).toBe(enqueued.taskId);
      expect(await fixture.workflowRepository.markDispatchSent(
        enqueued.taskId,
        claim!.claimToken,
        fixture.agentSessions.get(fixture.serverIds[0]!)!,
      )).toBe(true);
      const terminal = {
        taskId: enqueued.taskId,
        payloadHash: claim!.task.payloadHash,
        status: 'succeeded' as const,
        result: {
          imageId: fixture.imageId,
          dockerId: 'sha256:image',
          dockerRef,
        },
      };
      await expect(fixture.workflowRepository.acceptAgentResult(
        fixture.serverIds[0]!,
        terminal,
        fixture.agentSessions.get(fixture.serverIds[0]!)!,
      )).resolves.toMatchObject({
        accepted: true,
        terminal: true,
        finalizerPending: true,
      });
      await expect(fixture.workflowRepository.acceptAgentResult(
        fixture.serverIds[0]!,
        terminal,
        fixture.agentSessions.get(fixture.serverIds[0]!)!,
      )).resolves.toMatchObject({ accepted: true });

      const worker = new WorkflowFinalizerWorkerService(
        fixture.workflowRepository,
        fixture.registry,
      );
      expect(await worker.process()).toBe(1);
      expect(await worker.process()).toBe(0);
      expect(await fixture.infrastructure.findImageById(fixture.imageId))
        .toMatchObject({ deleting: false });
      expect(await fixture.workflowRepository.findTask(enqueued.taskId))
        .toMatchObject({
          status: AgentTaskStatus.Succeeded,
          result: terminal.result,
          completedAt: expect.any(Date),
        });
      expect(await database.selectFrom('workflow.resource_claims')
        .select('task_id')
        .where('task_id', '=', enqueued.taskId)
        .execute()).toEqual([]);
    });
  });

  it('waits for every current-generation cleanup and rolls deletion back on crash', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await setup(database, 2, true);
      const tasks = await fixture.transactions.run(async (transaction) => {
        const result = [];
        for (const serverId of fixture.serverIds) {
          result.push(await fixture.enqueue.enqueueInTransaction(transaction, {
            kind: AgentTaskKind.ImageEnsureAbsent,
            serverId,
            resourceType: 'image',
            resourceId: fixture.imageId,
            requestedBy: null,
            request: {
              action: 'delete_image',
              dockerRef,
              cleanupGeneration: 1,
            },
            payload: { dockerRef, imageId: fixture.imageId },
            resourceKeys: [fixture.keys.image(serverId, fixture.imageId)],
          }));
        }
        return result;
      });

      await stageAbsent(fixture, fixture.serverIds[0]!, tasks[0]!.taskId);
      const worker = new WorkflowFinalizerWorkerService(
        fixture.workflowRepository,
        fixture.registry,
      );
      expect(await worker.process()).toBe(1);
      expect(await fixture.infrastructure.findImageById(fixture.imageId))
        .toMatchObject({ deleting: true, cleanupGeneration: 1 });

      await stageAbsent(fixture, fixture.serverIds[1]!, tasks[1]!.taskId);
      const real = fixture.registry.get(AgentTaskKind.ImageEnsureAbsent)!;
      fixture.finalizer.onModuleDestroy();
      let crash = true;
      fixture.registry.register(AgentTaskKind.ImageEnsureAbsent, async (...args) => {
        const outcome = await real(...args);
        if (crash) {
          crash = false;
          throw new Error('simulated crash after image deletion');
        }
        return outcome;
      });
      expect(await worker.process()).toBe(0);
      expect(await fixture.infrastructure.findImageById(fixture.imageId))
        .toMatchObject({ deleting: true });
      expect(await fixture.workflowRepository.findTask(tasks[1]!.taskId))
        .toMatchObject({ status: AgentTaskStatus.Pending });
      expect(await database.selectFrom('workflow.resource_claims')
        .select('task_id')
        .where('task_id', '=', tasks[1]!.taskId)
        .execute()).toHaveLength(1);

      await database.updateTable('workflow.tasks')
        .set({ finalizer_retry_at: new Date(0) })
        .where('id', '=', tasks[1]!.taskId)
        .execute();
      expect(await worker.process()).toBe(1);
      expect(await fixture.infrastructure.findImageById(fixture.imageId)).toBeNull();
      for (const task of tasks) {
        expect(await fixture.workflowRepository.findTask(task.taskId))
          .toMatchObject({
            status: AgentTaskStatus.Succeeded,
            result: {
              imageId: fixture.imageId,
              dockerId: null,
              dockerRef,
              present: false,
            },
            completedAt: expect.any(Date),
          });
      }
      expect(await database.selectFrom('workflow.resource_claims')
        .select('task_id')
        .where('task_id', 'in', tasks.map((task) => task.taskId))
        .execute()).toEqual([]);
    });
  });
});

async function stageAbsent(
  fixture: Awaited<ReturnType<typeof setup>>,
  serverId: string,
  taskId: string,
): Promise<void> {
  const claim = await fixture.workflowRepository.claimNextDispatch(
    serverId,
    'dispatcher',
    { agentSession: fixture.agentSessions.get(serverId)! },
  );
  expect(claim?.task.id).toBe(taskId);
  expect(await fixture.workflowRepository.markDispatchSent(
    taskId,
    claim!.claimToken,
    fixture.agentSessions.get(serverId)!,
  )).toBe(true);
  await expect(fixture.workflowRepository.acceptAgentResult(serverId, {
    taskId,
    payloadHash: claim!.task.payloadHash,
    status: 'succeeded',
    result: {
      imageId: fixture.imageId,
      dockerId: null,
      dockerRef,
      present: false,
    },
  }, fixture.agentSessions.get(serverId)!)).resolves.toMatchObject({
    accepted: true,
    terminal: true,
    finalizerPending: true,
  });
}

async function setup(
  database: Kysely<NyabaseDatabase>,
  serverCount: number,
  deleting = false,
) {
  const imageId = randomUUID();
  const serverIds: string[] = [];
  for (let index = 0; index < serverCount; index += 1) {
    const id = randomUUID();
    serverIds.push(id);
    await database.insertInto('infra.servers').values({
      id,
      name: `Node ${index + 1}`,
      slug: `node-${id.slice(0, 8)}`,
      agent_token_hash: id.replaceAll('-', '').padEnd(64, '0'),
      host_fingerprint: null,
      agent_config_fingerprint: null,
      status: ServerStatus.Online,
      quarantine_code: null,
      quarantine_message: null,
      last_seen_at: new Date(),
      macvlan_cidr: null,
      macvlan_gateway: null,
      macvlan_reserved_ips: '[]',
      revision: 1,
    }).execute();
  }
  await database.insertInto('infra.images').values({
    id: imageId,
    name: 'Image',
    docker_image: dockerRef,
    runtime_overrides: runtimeOverrides,
    description: null,
    is_active: !deleting,
    disable_ssh: false,
    deleting,
    cleanup_generation: deleting ? 1 : 0,
    revision: deleting ? 2 : 1,
  }).execute();
  const transactions = new PgTransactionManager(database);
  const codec = new AgentTaskPayloadCodecService({
    decryptIfEncrypted: (value: string) => value,
  } as never);
  const keys = new ResourceKeyService();
  const enqueue = new WorkflowEnqueuePort(keys, codec);
  const workflowRepository = new WorkflowRepository(
    database,
    transactions,
    codec,
  );
  const agentSessions = new Map(
    await Promise.all(serverIds.map(async (serverId) => [
      serverId,
      await createReadyAgentSession(workflowRepository, serverId),
    ] as const)),
  );
  const infrastructure = new InfrastructureRepository(database);
  const registry = new WorkflowFinalizerRegistry();
  const finalizer = new ImageWorkflowFinalizerService(
    registry,
    infrastructure,
  );
  finalizer.onModuleInit();
  return {
    transactions,
    enqueue,
    workflowRepository,
    agentSessions,
    infrastructure,
    registry,
    finalizer,
    keys,
    imageId,
    serverIds,
  };
}
