import { randomUUID } from 'node:crypto';
import {
  AgentTaskKind,
  AgentTaskStatus,
  CONTAINER_DELETE_PROXY_DRAIN_MS,
  ContainerPhase,
  ContainerPowerIntent,
  ServerStatus,
  UserStatus,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { WorkflowFinalizerRegistry } from '../agent-tasks/workflow-finalizer.registry.js';
import { WorkflowFinalizerWorkerService } from '../agent-tasks/workflow-finalizer-worker.service.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import {
  ContainerControlRepository,
  type NewContainerAggregate,
} from './container-control.repository.js';
import { ContainerWorkflowFinalizerService } from './container-workflow-finalizer.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const overrides = { uid: 0, entrypoint: null, cmd: null, init: false };

describePg('Container Workflow finalizer PostgreSQL barrier', () => {
  it('rolls projection back on crash, retains claims, and retries exactly once', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await setup(database, ContainerPhase.Provisioning);
      const result = await enqueueAndStageCreate(fixture);
      const real = fixture.registry.get(AgentTaskKind.ContainerCreate)!;
      fixture.finalizer.onModuleDestroy();
      let crash = true;
      fixture.registry.register(AgentTaskKind.ContainerCreate, async (...args) => {
        const outcome = await real(...args);
        if (crash) {
          crash = false;
          throw new Error('simulated process crash after projection');
        }
        return outcome;
      });
      const worker = new WorkflowFinalizerWorkerService(
        fixture.workflowRepository,
        fixture.registry,
      );
      expect(await worker.process()).toBe(0);
      expect(await fixture.repository.find(fixture.containerId)).toMatchObject({
        lifecyclePhase: ContainerPhase.Provisioning,
        boundRuntimeId: null,
        activeTaskId: result.taskId,
      });
      expect(await fixture.workflowRepository.findTask(result.taskId)).toMatchObject({
        status: AgentTaskStatus.Pending,
      });
      expect(await database.selectFrom('workflow.resource_claims')
        .select('task_id')
        .where('task_id', '=', result.taskId)
        .execute()).toHaveLength(1);

      await database.updateTable('workflow.tasks')
        .set({ finalizer_retry_at: new Date(0) })
        .where('id', '=', result.taskId)
        .execute();
      expect(await worker.process()).toBe(1);
      expect(await fixture.repository.find(fixture.containerId)).toMatchObject({
        lifecyclePhase: ContainerPhase.Active,
        boundRuntimeId: 'runtime-a',
        observedGeneration: 1,
        activeTaskId: null,
      });
      expect(await fixture.workflowRepository.findTask(result.taskId)).toMatchObject({
        status: AgentTaskStatus.Succeeded,
      });
      expect(await database.selectFrom('workflow.resource_claims')
        .select('task_id')
        .where('task_id', '=', result.taskId)
        .execute()).toEqual([]);
      expect(await worker.process()).toBe(0);
    });
  });

  it('deletes the aggregate while retaining the IP drain claim', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await setup(database, ContainerPhase.Active, true);
      const enqueued = await fixture.transactions.run(async (transaction) => {
        const current = (await fixture.repository.lock(
          fixture.containerId,
          transaction,
        ))!;
        return fixture.enqueue.enqueueInTransaction(transaction, {
          kind: AgentTaskKind.ContainerDelete,
          serverId: fixture.serverId,
          resourceType: 'container',
          resourceId: fixture.containerId,
          requestedBy: fixture.userId,
          payload: {
            containerId: fixture.containerId,
            runtimeId: 'runtime-a',
            serverId: fixture.serverId,
            specGeneration: '1',
            runtimeSpecHash: 'a'.repeat(64),
            numericOwnerId: 1001,
            quotaPaths: ['/var/lib/docker/a', '/var/lib/docker/b'],
          },
          resourceKeys: [fixture.keys.container(fixture.containerId)],
          beforeCommit: async (tx, context) => {
            expect(await fixture.repository.transition(
              fixture.containerId,
              current.revision,
              {
                lifecyclePhase: ContainerPhase.Deleting,
                activeTaskId: context.taskId,
              },
              tx,
            )).toBeTruthy();
          },
        });
      });
      const claim = await fixture.workflowRepository.claimNextDispatch(
        fixture.serverId,
        'dispatcher',
        { agentSession: fixture.agentSession },
      );
      expect(await fixture.workflowRepository.markDispatchSent(
        enqueued.taskId,
        claim!.claimToken,
        fixture.agentSession,
      )).toBe(true);
      await fixture.workflowRepository.acceptAgentResult(fixture.serverId, {
        taskId: enqueued.taskId,
        payloadHash: claim!.task.payloadHash,
        status: 'succeeded',
        result: {
          containerId: fixture.containerId,
          runtimeId: null,
          quotaPaths: ['/var/lib/docker/a', '/var/lib/docker/b'],
        },
      }, fixture.agentSession);
      const worker = new WorkflowFinalizerWorkerService(
        fixture.workflowRepository,
        fixture.registry,
      );
      const databaseNow = await fixture.repository.currentDatabaseTime();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
        expect(await worker.process()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      expect(await fixture.repository.find(fixture.containerId)).toBeNull();
      const releasedClaim = await database
        .selectFrom('control.container_network_claims')
        .select(['container_id', 'owner_kind', 'owner_id', 'state', 'reusable_at'])
        .executeTakeFirstOrThrow();
      expect(releasedClaim).toMatchObject({
        container_id: null,
        owner_kind: 'container',
        owner_id: fixture.containerId,
        state: 'releasing',
        reusable_at: expect.any(Date),
      });
      expect(releasedClaim.reusable_at!.getTime()).toBeGreaterThan(
        databaseNow.getTime() + CONTAINER_DELETE_PROXY_DRAIN_MS - 5_000,
      );
      expect(releasedClaim.reusable_at!.getTime()).toBeLessThan(
        databaseNow.getTime() + CONTAINER_DELETE_PROXY_DRAIN_MS + 10_000,
      );
    });
  });

  it('terminalizes runtime-absent once and preserves its draining evidence', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await setup(database, ContainerPhase.Active, true);
      const payload = {
        runtimeId: 'runtime-orphan',
        containerId: fixture.containerId,
        serverId: fixture.serverId,
        specGeneration: '1',
        runtimeSpecHash: 'b'.repeat(64),
        quotaPaths: ['/var/lib/docker/orphan-a', '/var/lib/docker/orphan-b'],
        observedIp: '10.44.0.3',
      };
      const enqueued = await fixture.transactions.run(async (transaction) => {
        await fixture.repository.insertRuntimeCleanupClaim({
          id: randomUUID(),
          runtimeId: payload.runtimeId,
          serverId: fixture.serverId,
          networkKey: '10.44.0.0/29',
          address: payload.observedIp,
          cleanupPayload: payload,
        }, transaction);
        return fixture.enqueue.enqueueInTransaction(transaction, {
          kind: AgentTaskKind.ContainerRuntimeAbsent,
          serverId: fixture.serverId,
          resourceType: 'container_runtime',
          resourceId: payload.runtimeId,
          requestedBy: null,
          payload,
          admissionClass: 'safety',
          resourceKeys: [fixture.keys.runtime(fixture.serverId, payload.runtimeId)],
        });
      });
      const claim = await fixture.workflowRepository.claimNextDispatch(
        fixture.serverId,
        'dispatcher',
        { agentSession: fixture.agentSession },
      );
      expect(await fixture.workflowRepository.markDispatchSent(
        enqueued.taskId,
        claim!.claimToken,
        fixture.agentSession,
      )).toBe(true);
      await fixture.workflowRepository.acceptAgentResult(fixture.serverId, {
        taskId: enqueued.taskId,
        payloadHash: claim!.task.payloadHash,
        status: 'succeeded',
        result: {
          containerId: fixture.containerId,
          runtimeId: null,
          quotaPaths: payload.quotaPaths,
        },
      }, fixture.agentSession);
      const worker = new WorkflowFinalizerWorkerService(
        fixture.workflowRepository,
        fixture.registry,
      );
      expect(await worker.process()).toBe(1);
      expect(await worker.process()).toBe(0);
      expect(await database.selectFrom('control.container_network_claims')
        .select(['owner_id', 'state', 'cleanup_payload_json'])
        .where('owner_kind', '=', 'runtime_cleanup')
        .executeTakeFirstOrThrow()).toMatchObject({
        owner_id: payload.runtimeId,
        state: 'releasing',
        cleanup_payload_json: payload,
      });
    });
  });
});

async function enqueueAndStageCreate(
  fixture: Awaited<ReturnType<typeof setup>>,
) {
  const enqueued = await fixture.transactions.run(async (transaction) => {
    const current = (await fixture.repository.lock(
      fixture.containerId,
      transaction,
    ))!;
    return fixture.enqueue.enqueueInTransaction(transaction, {
      kind: AgentTaskKind.ContainerCreate,
      serverId: fixture.serverId,
      resourceType: 'container',
      resourceId: fixture.containerId,
      requestedBy: fixture.userId,
      payload: {
        containerId: fixture.containerId,
        specGeneration: 1,
        quotaGeneration: 1,
        dockerRoot: '/var/lib/docker',
        ownerId: fixture.userId,
        numericOwnerId: 1001,
        imageDockerRef: 'example/image:latest',
        imageDockerId: 'sha256:image',
        imageId: fixture.imageId,
        assignedIp: '10.44.0.2',
        runtimeOverrides: overrides,
        name: 'container-a',
        cpuMillis: 1000,
        memBytes: 1024,
        diskBytes: 4096,
        gpuIndices: [],
        mounts: [],
        ssh: { enabled: false },
      },
      resourceKeys: [fixture.keys.container(fixture.containerId)],
      beforeCommit: async (tx, context) => {
        expect(await fixture.repository.transition(
          fixture.containerId,
          current.revision,
          { activeTaskId: context.taskId },
          tx,
        )).toBeTruthy();
      },
    });
  });
  const claim = await fixture.workflowRepository.claimNextDispatch(
    fixture.serverId,
    'dispatcher',
    { agentSession: fixture.agentSession },
  );
  expect(await fixture.workflowRepository.markDispatchSent(
    enqueued.taskId,
    claim!.claimToken,
    fixture.agentSession,
  )).toBe(true);
  await fixture.workflowRepository.acceptAgentResult(fixture.serverId, {
    taskId: enqueued.taskId,
    payloadHash: claim!.task.payloadHash,
    status: 'succeeded',
    result: {
      containerId: fixture.containerId,
      runtimeId: 'runtime-a',
      ip: '10.44.0.2',
      quotaPaths: ['/var/lib/docker/a', '/var/lib/docker/b'],
      runtimeSpecHash: 'a'.repeat(64),
    },
  }, fixture.agentSession);
  return enqueued;
}

async function setup(
  database: Kysely<NyabaseDatabase>,
  phase: ContainerPhase,
  bound = false,
) {
  const userId = randomUUID();
  const serverId = randomUUID();
  const imageId = randomUUID();
  const containerId = randomUUID();
  await database.insertInto('iam.users').values({
    id: userId,
    numeric_id: 1001,
    username: `user-${userId.slice(0, 8)}`,
    password_hash: 'hash',
    display_name: 'User',
    status: UserStatus.Active,
    auth_version: 0,
    authz_version: 0,
  }).execute();
  await database.insertInto('infra.servers').values({
    id: serverId,
    name: 'Node',
    slug: `node-${serverId.slice(0, 8)}`,
    agent_token_hash: 'a'.repeat(64),
    host_fingerprint: 'host',
    agent_config_fingerprint: 'config',
    status: ServerStatus.Online,
    quarantine_code: null,
    quarantine_message: null,
    last_seen_at: new Date(),
    macvlan_cidr: '10.44.0.0/29',
    macvlan_gateway: '10.44.0.1',
    macvlan_reserved_ips: JSON.stringify([]),
    revision: 1,
  }).execute();
  await database.insertInto('infra.images').values({
    id: imageId,
    name: 'Image',
    docker_image: 'example/image:latest',
    runtime_overrides: overrides,
    description: null,
    is_active: true,
    disable_ssh: true,
    deleting: false,
    cleanup_generation: 0,
    revision: 1,
  }).execute();
  const transactions = new PgTransactionManager(database);
  const repository = new ContainerControlRepository(database);
  const aggregate: NewContainerAggregate = {
    id: containerId,
    serverId,
    ownerId: userId,
    imageId,
    createdBy: userId,
    name: 'container-a',
    imageRef: 'example/image:latest',
    imageDefaultUid: 0,
    imageRuntimeOverrides: overrides,
    cpuMillis: 1000,
    memBytes: 1024,
    diskBytes: 4096,
    gpuMode: 'none',
    gpuIndices: [],
    mountsJson: [],
    powerIntent: ContainerPowerIntent.Running,
    lifecyclePhase: phase,
  };
  await transactions.run(async (transaction) => {
    const inserted = await repository.insert(aggregate, transaction);
    if (bound) {
      await repository.transition(containerId, inserted.revision, {
        boundRuntimeId: 'runtime-a',
        quotaPaths: ['/var/lib/docker/a', '/var/lib/docker/b'],
        runtimeSpecHash: 'a'.repeat(64),
        observedGeneration: 1,
      }, transaction);
    }
    await repository.insertNetworkClaim({
      id: randomUUID(),
      containerId,
      serverId,
      networkKey: '10.44.0.0/29',
      address: '10.44.0.2',
    }, transaction);
  });
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
  const gatewayId = `gateway:test:${randomUUID()}`;
  const agentSessionId = randomUUID();
  const admittedAgentSession = await workflowRepository.admitAgentSession({
    id: agentSessionId,
    serverId,
    sessionToken: `token:${agentSessionId}`,
    hostFingerprint: 'host',
    configFingerprint: 'config',
    gatewayId,
    consolePublicUrl: 'wss://gateway.test/ws/console',
  });
  await workflowRepository.markAgentSessionReady(
    serverId,
    agentSessionId,
    admittedAgentSession.generation,
    gatewayId,
  );
  const agentSession = {
    id: agentSessionId,
    generation: admittedAgentSession.generation,
    gatewayId,
  };
  const registry = new WorkflowFinalizerRegistry();
  const finalizer = new ContainerWorkflowFinalizerService(
    registry,
    repository,
  );
  finalizer.onModuleInit();
  return {
    database,
    transactions,
    repository,
    enqueue,
    workflowRepository,
    agentSession,
    registry,
    finalizer,
    keys,
    userId,
    serverId,
    imageId,
    containerId,
  };
}
