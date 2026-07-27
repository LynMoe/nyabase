import { randomUUID } from 'node:crypto';
import {
  AgentTaskKind,
  AgentTaskStatus,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  LABEL,
  ServerStatus,
  UserStatus,
  type ContainerSnapshot,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';
import {
  ContainerControlRepository,
  type NewContainerAggregate,
} from '../containers/container-control.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { RuntimeDriftReconcilerService } from './runtime-drift-reconciler.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('PostgreSQL runtime drift convergence', () => {
  it('claims unknown runtime identity before enqueue and deduplicates repeated reports', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const containerId = randomUUID();
      const { serverId, service, workflowRepository } = await setup(database);
      const report = snapshot(serverId, containerId);
      const first = await service.reconcile(
        serverId,
        [report],
        '/var/lib/docker',
      );
      expect(first).toMatchObject({
        claimsChanged: true,
        failedContainerIds: [],
        quarantineReason: null,
      });
      expect(first.taskIds).toHaveLength(1);
      expect(await database.selectFrom('control.container_network_claims')
        .select(['owner_kind', 'owner_id', 'address', 'state'])
        .execute()).toEqual([{
        owner_kind: 'runtime_cleanup',
        owner_id: 'runtime-orphan',
        address: '10.44.0.3',
        state: 'active',
      }]);
      expect(await workflowRepository.findTask(first.taskIds[0]!)).toMatchObject({
        kind: AgentTaskKind.ContainerRuntimeAbsent,
        status: AgentTaskStatus.Pending,
        admissionClass: 'safety',
      });

      const second = await service.reconcile(
        serverId,
        [report],
        '/var/lib/docker',
      );
      expect(second.taskIds).toEqual(first.taskIds);
      expect(second.claimsChanged).toBe(false);
      expect(await database.selectFrom('workflow.tasks')
        .select('id')
        .where('kind', '=', AgentTaskKind.ContainerRuntimeAbsent)
        .execute()).toHaveLength(1);
    });
  });

  it('adopts a deleted container release fence for its late runtime snapshot', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const containerId = randomUUID();
      const claimId = randomUUID();
      const { serverId, service } = await setup(database);
      await database.insertInto('control.container_network_claims').values({
        id: claimId,
        container_id: null,
        owner_kind: 'container',
        owner_id: containerId,
        server_id: serverId,
        network_key: '10.44.0.0/29',
        address: '10.44.0.3',
        state: 'releasing',
        reusable_at: new Date(Date.now() + 60_000),
        cleanup_payload_json: null,
      }).execute();

      const result = await service.reconcile(
        serverId,
        [snapshot(serverId, containerId)],
        '/var/lib/docker',
      );

      expect(result).toMatchObject({
        claimsChanged: true,
        failedContainerIds: [],
        quarantineReason: null,
      });
      expect(result.taskIds).toHaveLength(1);
      expect(await database.selectFrom('control.container_network_claims')
        .select([
          'id',
          'container_id',
          'owner_kind',
          'owner_id',
          'state',
          'reusable_at',
          'cleanup_payload_json',
        ])
        .executeTakeFirstOrThrow()).toMatchObject({
        id: claimId,
        container_id: null,
        owner_kind: 'runtime_cleanup',
        owner_id: 'runtime-orphan',
        state: 'active',
        reusable_at: null,
        cleanup_payload_json: expect.objectContaining({
          runtimeId: 'runtime-orphan',
          containerId,
          observedIp: '10.44.0.3',
        }),
      });
    });
  });

  it('accepts an active reservation while its create result awaits projection', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const containerId = randomUUID();
      const userId = randomUUID();
      const imageId = randomUUID();
      const {
        serverId,
        service,
        transactions,
        containers,
        workflow,
        keys,
      } = await setup(database);
      await database.insertInto('iam.users').values({
        id: userId,
        numeric_id: 1001,
        username: 'runtime-owner',
        password_hash: 'test-hash',
        display_name: 'Runtime Owner',
        status: UserStatus.Active,
        auth_version: 0,
        authz_version: 0,
      }).execute();
      await database.insertInto('infra.images').values({
        id: imageId,
        name: 'Runtime Image',
        docker_image: 'example/runtime:latest',
        runtime_overrides: runtimeOverrides,
        description: null,
        is_active: true,
        disable_ssh: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      await transactions.run(async (transaction) => {
        const aggregate: NewContainerAggregate = {
          id: containerId,
          serverId,
          ownerId: userId,
          imageId,
          createdBy: userId,
          name: 'projection-race',
          imageRef: 'example/runtime:latest',
          imageDefaultUid: 0,
          imageRuntimeOverrides: runtimeOverrides,
          cpuMillis: 1000,
          memBytes: 1024,
          diskBytes: 4096,
          gpuMode: 'none',
          gpuIndices: [],
          mountsJson: [],
          powerIntent: ContainerPowerIntent.Running,
          lifecyclePhase: ContainerPhase.Provisioning,
        };
        const inserted = await containers.insert(aggregate, transaction);
        await containers.insertNetworkClaim({
          id: randomUUID(),
          containerId,
          serverId,
          networkKey: '10.44.0.0/29',
          address: '10.44.0.3',
        }, transaction);
        const task = await workflow.enqueueInTransaction(transaction, {
          kind: AgentTaskKind.ContainerCreate,
          serverId,
          resourceType: 'container',
          resourceId: containerId,
          requestedBy: userId,
          request: { name: 'projection-race' },
          payload: {
            containerId,
            specGeneration: 1,
            quotaGeneration: 1,
            dockerRoot: '/var/lib/docker',
            ownerId: userId,
            numericOwnerId: 1001,
            imageDockerRef: 'example/runtime:latest',
            imageDockerId: 'sha256:image',
            imageId,
            assignedIp: '10.44.0.3',
            runtimeOverrides,
            name: 'projection-race',
            cpuMillis: 1000,
            memBytes: 1024,
            diskBytes: 4096,
            gpuIndices: [],
            mounts: [],
            ssh: { enabled: false },
          },
          resourceKeys: [keys.container(containerId)],
        });
        expect(await containers.transition(containerId, inserted.revision, {
          activeTaskId: task.taskId,
        }, transaction)).toBeTruthy();
      });

      expect(await service.reconcile(
        serverId,
        [snapshot(serverId, containerId)],
        '/var/lib/docker',
      )).toEqual({
        taskIds: [],
        failedContainerIds: [],
        claimsChanged: false,
        quarantineReason: null,
      });
      expect(await database.selectFrom('control.container_network_claims')
        .select(['container_id', 'owner_kind', 'owner_id', 'state'])
        .executeTakeFirstOrThrow()).toEqual({
        container_id: containerId,
        owner_kind: 'container',
        owner_id: containerId,
        state: 'active',
      });
      expect(await database.selectFrom('infra.servers')
        .select('status')
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow()).toEqual({ status: ServerStatus.Online });
    });
  });

  it('retries a report when concurrent task projection advances the container revision', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const containerId = randomUUID();
      const userId = randomUUID();
      const imageId = randomUUID();
      const {
        serverId,
        service,
        transactions,
        containers,
      } = await setup(database);
      await database.insertInto('iam.users').values({
        id: userId,
        numeric_id: 1002,
        username: 'runtime-retry-owner',
        password_hash: 'test-hash',
        display_name: 'Runtime Retry Owner',
        status: UserStatus.Active,
        auth_version: 0,
        authz_version: 0,
      }).execute();
      await database.insertInto('infra.images').values({
        id: imageId,
        name: 'Runtime Retry Image',
        docker_image: 'example/runtime-retry:latest',
        runtime_overrides: runtimeOverrides,
        description: null,
        is_active: true,
        disable_ssh: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      await transactions.run(async (transaction) => {
        await containers.insert({
          id: containerId,
          serverId,
          ownerId: userId,
          imageId,
          createdBy: userId,
          name: 'projection-retry',
          imageRef: 'example/runtime-retry:latest',
          imageDefaultUid: 0,
          imageRuntimeOverrides: runtimeOverrides,
          cpuMillis: 1000,
          memBytes: 1024,
          diskBytes: 4096,
          gpuMode: 'none',
          gpuIndices: [],
          mountsJson: [],
          powerIntent: ContainerPowerIntent.Running,
          lifecyclePhase: ContainerPhase.Active,
        }, transaction);
      });

      const transition = vi.spyOn(containers, 'transition')
        .mockResolvedValueOnce(null);
      expect(await service.reconcile(serverId, [], '/var/lib/docker')).toEqual({
        taskIds: [],
        failedContainerIds: [containerId],
        claimsChanged: false,
        quarantineReason: null,
      });
      expect(transition).toHaveBeenCalledTimes(2);
      expect(await containers.find(containerId)).toMatchObject({
        lifecyclePhase: ContainerPhase.Failed,
        failureCode: 'runtime_missing',
      });
    });
  });

  it('quarantines a runtime that reports an address fenced by another owner', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const containerId = randomUUID();
      const otherContainerId = randomUUID();
      const { serverId, service } = await setup(database);
      await database.insertInto('control.container_network_claims').values({
        id: randomUUID(),
        container_id: null,
        owner_kind: 'container',
        owner_id: otherContainerId,
        server_id: serverId,
        network_key: '10.44.0.0/29',
        address: '10.44.0.3',
        state: 'releasing',
        reusable_at: new Date(Date.now() + 60_000),
        cleanup_payload_json: null,
      }).execute();

      const result = await service.reconcile(
        serverId,
        [snapshot(serverId, containerId)],
        '/var/lib/docker',
      );

      expect(result.taskIds).toEqual([]);
      expect(result.failedContainerIds).toEqual([]);
      expect(result.quarantineReason).toContain(
        `address 10.44.0.3 is fenced by container owner ${otherContainerId}`,
      );
      expect(await database.selectFrom('infra.servers')
        .select(['status', 'quarantine_code'])
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow()).toEqual({
        status: ServerStatus.AgentQuarantined,
        quarantine_code: 'AGENT_INVENTORY_FAULT',
      });
    });
  });
});

async function setup(database: Kysely<NyabaseDatabase>): Promise<{
  serverId: string;
  service: RuntimeDriftReconcilerService;
  workflowRepository: WorkflowRepository;
  transactions: PgTransactionManager;
  containers: ContainerControlRepository;
  workflow: WorkflowEnqueuePort;
  keys: ResourceKeyService;
}> {
  const serverId = randomUUID();
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
  const transactions = new PgTransactionManager(database);
  const codec = new AgentTaskPayloadCodecService({
    decryptIfEncrypted: (value: string) => value,
  } as never);
  const keys = new ResourceKeyService();
  const workflow = new WorkflowEnqueuePort(keys, codec);
  const containers = new ContainerControlRepository(database);
  const workflowRepository = new WorkflowRepository(
    database,
    transactions,
    codec,
  );
  return {
    serverId,
    workflowRepository,
    transactions,
    containers,
    workflow,
    keys,
    service: new RuntimeDriftReconcilerService(
      transactions,
      containers,
      workflow,
      workflowRepository,
      keys,
    ),
  };
}

const runtimeOverrides = {
  uid: 0,
  entrypoint: null,
  cmd: null,
  init: false,
};

function snapshot(
  serverId: string,
  containerId: string,
): ContainerSnapshot {
  return {
    runtime: {
      runtimeId: 'runtime-orphan',
      ip: '10.44.0.3',
      serverId,
      specGeneration: '1',
      quotaPaths: [
        '/var/lib/docker/overlay2/runtime-orphan/diff',
        '/var/lib/docker/overlay2/runtime-orphan/work',
      ],
    },
    status: ContainerStatus.Running,
    sshServer: {
      enabled: false,
      status: 'disabled',
      user: 'root',
      port: 22,
    },
    labels: {
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: containerId,
      [LABEL.SERVER_ID]: serverId,
      [LABEL.SPEC_GENERATION]: '1',
      [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
    },
  };
}
