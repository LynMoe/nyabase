import { randomUUID } from 'node:crypto';
import {
  AgentTaskKind,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  GpuGrantMode,
  LABEL,
  MAX_CONTAINER_MOUNTS,
  RemoteFsType,
  ServerStatus,
  UserStatus,
  remoteFsSourceIdentity,
  type ContainerSnapshot,
} from '@nyabase/common';
import type {
  Kysely,
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
} from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import {
  withPostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import {
  ContainerControlRepository,
  type NewContainerAggregate,
} from './container-control.repository.js';
import { ContainerTaskService } from './container-task.service.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import { ContainerControlService } from './container-control.service.js';
import { resolveContainerMountIntegrity } from './container-mount-integrity.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const runtimeOverrides = {
  uid: 0,
  entrypoint: null,
  cmd: null,
  init: false,
};

describePg('PostgreSQL Container Control aggregate', () => {
  it('resolves 64 RemoteFS mounts with three fixed PostgreSQL queries', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      const mountRows = Array.from({ length: MAX_CONTAINER_MOUNTS }, (_, index) => {
        const id = randomUUID();
        const params = {
          type: RemoteFsType.Nfs as const,
          nfsServer: 'nfs.internal',
          exportPath: `/export-${index}`,
          version: '4.2' as const,
        };
        return {
          id,
          name: `remote-${index}`,
          display_name: null,
          description: null,
          type: RemoteFsType.Nfs,
          host_mount_point: `/mnt/remote-fs/${id}`,
          options: '',
          params,
          desired_state: 'active' as const,
          generation: 1,
          last_task_id: null,
        };
      });
      await database.insertInto('infra.remote_fs_mounts').values(mountRows).execute();
      await database.insertInto('infra.remote_fs_server_assignments').values(
        mountRows.map((mount) => ({
          id: randomUUID(),
          remote_fs_mount_id: mount.id,
          server_id: seed.serverId,
          desired_state: 'active' as const,
          generation: 1,
          last_task_id: null,
        })),
      ).execute();
      const directoryRows = (
        mountRows.map((mount, index) => ({
          id: randomUUID(),
          user_id: seed.userId,
          source_kind: 'remote' as const,
          source_id: mount.id,
          name: `dir-${index}`,
          source_identity: remoteFsSourceIdentity(mount.params),
          server_id: null,
          uid: 1001,
          desired_state: 'active' as const,
          generation: 1,
          last_task_id: null,
        }))
      );
      await database.insertInto('control.data_directories').values(directoryRows).execute();
      let queryCount = 0;
      const counter: KyselyPlugin = {
        transformQuery(args: PluginTransformQueryArgs) {
          queryCount += 1;
          return args.node;
        },
        async transformResult(args: PluginTransformResultArgs) {
          return args.result;
        },
      };
      const counted = database.withPlugin(counter);
      const { service } = containerService(
        counted,
        seed,
        async () => currentGrant(),
      );
      const mounts = mountRows.map((mount, index) => ({
        id: `remote:${mount.id}:dir-${index}:/data-${index}`,
        sourceKind: 'remote' as const,
        sourceId: mount.id,
        dirName: `dir-${index}`,
        containerPath: `/data-${index}`,
      }));

      const resolved = await (service as unknown as {
        resolveMounts(
          executor: Kysely<NyabaseDatabase>,
          serverId: string,
          userId: string,
          mounts: readonly {
            id: string;
            sourceKind: 'remote';
            sourceId: string;
            dirName: string;
            containerPath: string;
          }[],
        ): Promise<unknown[]>;
      }).resolveMounts(counted, seed.serverId, seed.userId, mounts);
      expect(resolved).toHaveLength(MAX_CONTAINER_MOUNTS);
      expect(queryCount).toBe(3);

      queryCount = 0;
      const containerId = randomUUID();
      const integrityContainer = {
        ...aggregate(containerId, 'integrity-batch', seed),
        revision: 1,
        desiredGeneration: 1,
        observedGeneration: null,
        boundRuntimeId: null,
        quotaPaths: [],
        runtimeSpecHash: null,
        activeTaskId: null,
        lastTransitionAt: new Date(),
        failureReason: null,
        failureCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        mountsJson: mounts,
      };
      const integrityRows = mounts.map((mount, index) => ({
        id: randomUUID(),
        containerId,
        serverId: seed.serverId,
        resourceId: directoryRows[index]!.id,
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
        sourceIdentity: directoryRows[index]!.source_identity,
        userId: seed.userId,
        dirName: mount.dirName,
        containerPath: mount.containerPath,
      }));
      const integrity = await counted.transaction().execute((transaction) =>
        resolveContainerMountIntegrity(
          transaction,
          integrityContainer,
          integrityRows,
        ));
      expect(integrity).toHaveLength(MAX_CONTAINER_MOUNTS);
      expect(queryCount).toBe(2);
    });
  });

  it('rolls back container, task, and claims when required audit append fails', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      await seedQuota(database, seed);
      const audit = { append: vi.fn().mockRejectedValue(new Error('audit unavailable')) };
      const { service } = containerService(
        database,
        seed,
        async () => currentGrant(),
        audit,
      );
      await expect(service.create(seed.userId, {
        serverId: seed.serverId,
        imageId: seed.imageId,
        name: 'audit-rollback',
      })).rejects.toThrow('audit unavailable');
      expect(await database.selectFrom('control.containers').select('id').execute())
        .toEqual([]);
      expect(await database.selectFrom('workflow.tasks').select('id').execute())
        .toEqual([]);
      expect(await database.selectFrom('workflow.resource_claims').select('resource_key').execute())
        .toEqual([]);
    });
  });

  it('maps the exact duplicate container-name constraint to the public conflict contract', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      await seedQuota(database, seed);
      const { service } = containerService(
        database,
        seed,
        async () => currentGrant(),
      );
      const request = {
        serverId: seed.serverId,
        imageId: seed.imageId,
        name: 'duplicate-name',
      };

      await expect(service.create(seed.userId, request)).resolves.toMatchObject({
        status: 'pending',
      });
      await expect(service.create(seed.userId, request)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({
          statusCode: 409,
          message: expect.stringMatching(/name|already in use/i),
        }),
      });
      expect(await database.selectFrom('control.containers')
        .select('id')
        .execute()).toHaveLength(1);
      expect(await database.selectFrom('workflow.tasks')
        .select('id')
        .execute()).toHaveLength(1);
    });
  });

  it('enforces identity/network uniqueness and maintains authorization dependencies', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      const transactions = new PgTransactionManager(database);
      const repository = new ContainerControlRepository(database);
      const firstId = randomUUID();
      const directoryId = randomUUID();
      await database.insertInto('control.data_directories').values({
        id: directoryId,
        user_id: seed.userId,
        source_kind: 'local',
        source_id: 'disk-a',
        name: 'workspace',
        source_identity: 'disk-identity-a',
        server_id: seed.serverId,
        uid: 1001,
        desired_state: 'active',
        generation: 1,
        last_task_id: null,
      }).execute();
      await transactions.run(async (transaction) => {
        await repository.insert(
          aggregate(firstId, 'workspace', seed),
          transaction,
        );
        await repository.replaceMounts(firstId, [{
          id: randomUUID(),
          containerId: firstId,
          serverId: seed.serverId,
          resourceId: directoryId,
          sourceKind: 'local',
          sourceId: 'disk-a',
          sourceIdentity: 'disk-identity-a',
          userId: seed.userId,
          dirName: 'workspace',
          containerPath: '/workspace',
        }], transaction);
        await repository.replaceGpuClaims(firstId, seed.serverId, [0, 1], transaction);
        await repository.insertNetworkClaim({
          id: randomUUID(),
          containerId: firstId,
          serverId: seed.serverId,
          networkKey: '10.44.0.0/29',
          address: '10.44.0.2',
        }, transaction);
      });
      expect(await database.selectFrom('control.authorization_dependencies')
        .select(['dependency_kind', 'dependency_id'])
        .where('user_id', '=', seed.userId)
        .orderBy('dependency_kind')
        .execute()).toEqual([
        { dependency_kind: 'container', dependency_id: firstId },
        expect.objectContaining({ dependency_kind: 'container_mount' }),
      ]);

      await expect(transactions.run((transaction) =>
        repository.insert(aggregate(randomUUID(), 'workspace', seed), transaction)))
        .rejects.toMatchObject({ code: '23505' });

      const secondId = randomUUID();
      await transactions.run((transaction) =>
        repository.insert(aggregate(secondId, 'other', seed), transaction));
      await expect(transactions.run((transaction) =>
        repository.insertNetworkClaim({
          id: randomUUID(),
          containerId: secondId,
          serverId: seed.serverId,
          networkKey: '10.44.0.0/29',
          address: '10.44.0.2',
        }, transaction))).rejects.toMatchObject({ code: '23505' });

      const first = await repository.find(firstId);
      await transactions.run(async (transaction) => {
        expect(await repository.markNetworkClaimReleasing(
          firstId,
          new Date(Date.now() + 20_000),
          transaction,
        )).toBe(true);
        expect(await repository.delete(firstId, first!.revision, transaction)).toBe(true);
      });
      expect(await database.selectFrom('control.authorization_dependencies')
        .select('id')
        .where('dependency_id', '=', firstId)
        .execute()).toEqual([]);
      expect(await database.selectFrom('control.container_mounts')
        .select('id')
        .where('container_id', '=', firstId)
        .execute()).toEqual([]);
      expect(await database.selectFrom('control.container_gpu_claims')
        .select('id')
        .where('container_id', '=', firstId)
        .execute()).toEqual([]);
      expect(await database.selectFrom('control.container_network_claims')
        .select(['container_id', 'owner_id', 'state'])
        .where('owner_id', '=', firstId)
        .executeTakeFirstOrThrow()).toEqual({
        container_id: null,
        owner_id: firstId,
        state: 'releasing',
      });
    });
  });

  it('admits one optimistic transition winner under concurrency', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      const transactions = new PgTransactionManager(database);
      const repository = new ContainerControlRepository(database);
      const containerId = randomUUID();
      await transactions.run((transaction) =>
        repository.insert(aggregate(containerId, 'cas', seed), transaction));
      const expected = (await repository.find(containerId))!.revision;
      const attempts = await Promise.all([
        transactions.run((transaction) => repository.transition(
          containerId,
          expected,
          { lifecyclePhase: ContainerPhase.Active },
          transaction,
        )),
        transactions.run((transaction) => repository.transition(
          containerId,
          expected,
          { lifecyclePhase: ContainerPhase.Failed, failureCode: 'race' },
          transaction,
        )),
      ]);
      expect(attempts.filter(Boolean)).toHaveLength(1);
      expect((await repository.find(containerId))!.revision).toBe(expected + 1);
    });
  });

  it('rolls aggregate and dependency writers back when durable enqueue rejects', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      const transactions = new PgTransactionManager(database);
      const repository = new ContainerControlRepository(database);
      const workflowRepository = new WorkflowRepository(database, transactions);
      const tasks = new ContainerTaskService({
        enqueueInTransaction: async () => {
          throw new Error('workflow unavailable');
        },
      } as never, workflowRepository);
      const containerId = randomUUID();
      await expect(transactions.run(async (transaction) => {
        await repository.insert(aggregate(containerId, 'rollback', seed), transaction);
        await tasks.enqueueInTransaction(transaction, {
          containerId,
          serverId: seed.serverId,
          requestedBy: seed.userId,
          kind: AgentTaskKind.ContainerCreate,
          request: { name: 'rollback' },
          payload: createPayload(containerId, seed),
          resourceKeys: [`container:${containerId}`],
        });
      })).rejects.toThrow('workflow unavailable');
      expect(await repository.find(containerId)).toBeNull();
      expect(await database.selectFrom('control.authorization_dependencies')
        .select('id')
        .where('dependency_id', '=', containerId)
        .execute()).toEqual([]);
    });
  });

  it('atomically enqueues recovery, claims the resource and applies failed-state CAS', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      const transactions = new PgTransactionManager(database);
      const repository = new ContainerControlRepository(database);
      const workflowRepository = new WorkflowRepository(database, transactions);
      const enqueue = new WorkflowEnqueuePort(
        new ResourceKeyService(),
        new AgentTaskPayloadCodecService({
          decryptIfEncrypted: (value: string) => value,
        } as never),
      );
      const tasks = new ContainerTaskService(enqueue, workflowRepository);
      const containerId = randomUUID();
      await transactions.run(async (transaction) => {
        const created = await repository.insert(
          aggregate(containerId, 'recover', seed),
          transaction,
        );
        expect(await repository.transition(containerId, created.revision, {
          lifecyclePhase: ContainerPhase.Failed,
          failureCode: 'runtime_missing',
          failureReason: 'runtime missing',
        }, transaction)).toBeTruthy();
      });
      const failed = (await repository.find(containerId))!;
      const task = await transactions.run((transaction) =>
        tasks.enqueueInTransaction(transaction, {
          containerId,
          serverId: seed.serverId,
          requestedBy: seed.userId,
          kind: AgentTaskKind.ContainerCreate,
          request: { recovery: true },
          payload: createPayload(containerId, seed),
          resourceKeys: [`container:${containerId}`],
          beforeCommit: async (sameTransaction, taskId) => {
            expect(await repository.recoverFailed(
              containerId,
              failed.revision,
              taskId,
              sameTransaction,
            )).toBeTruthy();
          },
        }));
      const recovered = (await repository.find(containerId))!;
      expect(recovered).toMatchObject({
        lifecyclePhase: ContainerPhase.Updating,
        activeTaskId: task.taskId,
        failureCode: null,
        failureReason: null,
      });
      expect(await database.selectFrom('workflow.tasks')
        .select(['id', 'status'])
        .where('id', '=', task.taskId)
        .executeTakeFirstOrThrow()).toMatchObject({
        id: task.taskId,
        status: 'pending',
      });
      expect(await database.selectFrom('workflow.resource_claims')
        .select(['resource_key', 'task_id'])
        .where('task_id', '=', task.taskId)
        .execute()).toEqual([{
        resource_key: `container:${containerId}`,
        task_id: task.taskId,
      }]);
      expect(await database.selectFrom('workflow.outbox')
        .select('id')
        .where('topic', '=', 'dispatch')
        .execute()).toHaveLength(1);
    });
  });

  it('rolls create back across an SSH generation race and succeeds on retry', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      await database.updateTable('infra.images')
        .set({ disable_ssh: false })
        .where('id', '=', seed.imageId)
        .execute();
      await seedQuota(database, seed);
      let rotate = true;
      const { service } = containerService(database, seed, async () => {
        if (rotate) {
          rotate = false;
          await database.updateTable('iam.user_internal_ssh_keys').set({
            public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRotated',
            fingerprint: 'SHA256:rotated',
            generation: 2,
            rotated_at: new Date(),
          }).where('user_id', '=', seed.userId).execute();
        }
        return currentGrant();
      });
      await expect(service.create(seed.userId, {
        serverId: seed.serverId,
        imageId: seed.imageId,
        name: 'ssh-race',
      })).rejects.toThrow('Internal SSH key rotated');
      expect(await database.selectFrom('control.containers')
        .select('id').execute()).toEqual([]);
      expect(await database.selectFrom('workflow.tasks')
        .select('id').execute()).toEqual([]);

      await expect(service.create(seed.userId, {
        serverId: seed.serverId,
        imageId: seed.imageId,
        name: 'ssh-race',
      })).resolves.toMatchObject({ status: 'pending' });
      expect(await database.selectFrom('control.containers')
        .select(['name', 'active_task_id'])
        .executeTakeFirstOrThrow()).toMatchObject({
        name: 'ssh-race',
        active_task_id: expect.any(String),
      });
    });
  });

  it('allocates after every gateway and reservation on the shared network', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      await seedQuota(database, seed);
      await database.updateTable('infra.servers')
        .set({ macvlan_reserved_ips: JSON.stringify(['10.44.0.2']) })
        .where('id', '=', seed.serverId)
        .execute();
      await database.insertInto('infra.servers').values({
        id: randomUUID(),
        name: 'Online network peer',
        slug: 'online-network-peer',
        agent_token_hash: 'b'.repeat(64),
        host_fingerprint: 'peer-host',
        agent_config_fingerprint: 'peer-config',
        status: ServerStatus.Online,
        quarantine_code: null,
        quarantine_message: null,
        last_seen_at: new Date(),
        macvlan_cidr: '10.44.0.0/29',
        macvlan_gateway: '10.44.0.1',
        macvlan_reserved_ips: JSON.stringify(['10.44.0.3']),
        revision: 1,
      }).execute();
      const { service } = containerService(
        database,
        seed,
        async () => currentGrant(),
      );

      await expect(service.create(seed.userId, {
        serverId: seed.serverId,
        imageId: seed.imageId,
        name: 'shared-network-reservations',
      })).resolves.toMatchObject({ status: 'pending' });

      expect(await database.selectFrom('control.container_network_claims')
        .select(['network_key', 'address'])
        .executeTakeFirstOrThrow()).toEqual({
        network_key: '10.44.0.0/29',
        address: '10.44.0.4',
      });
    });
  });

  it('keeps immutable runtime generation stable across power lifecycle actions', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      await seedQuota(database, seed);
      const transactions = new PgTransactionManager(database);
      const repository = new ContainerControlRepository(database);
      const containerId = randomUUID();
      await transactions.run(async (transaction) => {
        const inserted = await repository.insert(
          aggregate(containerId, 'power-cycle', seed),
          transaction,
        );
        expect(await repository.transition(containerId, inserted.revision, {
          lifecyclePhase: ContainerPhase.Active,
          powerIntent: ContainerPowerIntent.Stopped,
          observedGeneration: 1,
          boundRuntimeId: 'runtime-a',
          quotaPaths: ['/var/lib/docker/a', '/var/lib/docker/b'],
          runtimeSpecHash: 'a'.repeat(64),
        }, transaction)).toMatchObject({
          desiredGeneration: 1,
          observedGeneration: 1,
        });
      });
      const runtime: ContainerSnapshot = {
        runtime: {
          runtimeId: 'runtime-a',
          ip: '10.44.0.2',
          serverId: seed.serverId,
          specGeneration: '1',
          quotaPaths: ['/var/lib/docker/a', '/var/lib/docker/b'],
        },
        status: ContainerStatus.Exited,
        sshServer: {
          enabled: false,
          status: 'disabled',
          user: 'root',
          port: 22,
        },
        labels: {
          [LABEL.MANAGED]: 'true',
          [LABEL.CONTAINER_ID]: containerId,
          [LABEL.SERVER_ID]: seed.serverId,
          [LABEL.SPEC_GENERATION]: '1',
          [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
        },
      };
      const { service } = containerService(
        database,
        seed,
        async () => currentGrant(),
        undefined,
        runtime,
      );

      const task = await service.action(containerId, 'start', seed.userId);

      expect(await repository.find(containerId)).toMatchObject({
        desiredGeneration: 1,
        observedGeneration: 1,
        lifecyclePhase: ContainerPhase.Updating,
        powerIntent: ContainerPowerIntent.Running,
        activeTaskId: task.taskId,
      });
      expect(await database.selectFrom('workflow.tasks')
        .select(['id', 'kind', 'status'])
        .where('id', '=', task.taskId)
        .executeTakeFirstOrThrow()).toEqual({
        id: task.taskId,
        kind: AgentTaskKind.ContainerStart,
        status: 'pending',
      });
    });
  });

  it('preserves the forbidden immutable-mount contract without enqueueing work', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      const transactions = new PgTransactionManager(database);
      const repository = new ContainerControlRepository(database);
      const containerId = randomUUID();
      await transactions.run((transaction) =>
        repository.insert(aggregate(containerId, 'immutable-mounts', seed), transaction));
      const { service } = containerService(
        database,
        seed,
        async () => currentGrant(),
      );

      await expect(service.action(
        containerId,
        'updateMounts',
        seed.userId,
        [],
      )).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({
          statusCode: 403,
          message: expect.stringContaining('Container mounts are immutable'),
        }),
      });
      expect(await database.selectFrom('workflow.tasks')
        .select('id')
        .execute()).toEqual([]);
    });
  });

  it('masks a stale running snapshot after durable runtime-missing reconciliation', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      const transactions = new PgTransactionManager(database);
      const repository = new ContainerControlRepository(database);
      const containerId = randomUUID();
      await transactions.run(async (transaction) => {
        const inserted = await repository.insert(
          aggregate(containerId, 'runtime-missing-view', seed),
          transaction,
        );
        expect(await repository.transition(containerId, inserted.revision, {
          lifecyclePhase: ContainerPhase.Failed,
          boundRuntimeId: 'runtime-stale',
          observedGeneration: 1,
          quotaPaths: ['/var/lib/docker/a', '/var/lib/docker/b'],
          runtimeSpecHash: 'a'.repeat(64),
          failureCode: 'runtime_missing',
          failureReason: 'Bound runtime is absent from authoritative inventory',
        }, transaction)).toBeTruthy();
      });
      const staleSnapshot: ContainerSnapshot = {
        runtime: {
          runtimeId: 'runtime-stale',
          ip: '10.44.0.2',
          serverId: seed.serverId,
          specGeneration: '1',
          quotaPaths: ['/var/lib/docker/a', '/var/lib/docker/b'],
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
          [LABEL.SERVER_ID]: seed.serverId,
          [LABEL.SPEC_GENERATION]: '1',
          [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
        },
      };
      const { service } = containerService(
        database,
        seed,
        async () => currentGrant(),
        undefined,
        staleSnapshot,
      );

      await expect(service.get(containerId, seed.userId)).resolves.toMatchObject({
        failureCode: 'runtime_missing',
        runtime: {
          bound: true,
          runtimeId: 'runtime-stale',
          status: ContainerStatus.Unknown,
          ip: null,
          observedAt: null,
        },
        actions: {
          delete: { enabled: true },
          console: expect.objectContaining({ enabled: false }),
        },
      });
    });
  });

  it.each([
    ['offline'],
    ['agent_quarantined'],
  ])('fails closed when a shared-network peer is %s', async (peerStatus) => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedBase(database);
      await seedQuota(database, seed);
      await database.insertInto('infra.servers').values({
        id: randomUUID(),
        name: `Peer ${peerStatus}`,
        slug: `peer-${peerStatus.replace('_', '-')}`,
        agent_token_hash: 'b'.repeat(64),
        host_fingerprint: 'peer-host',
        agent_config_fingerprint: 'peer-config',
        status: peerStatus,
        quarantine_code: peerStatus === 'agent_quarantined' ? 'test' : null,
        quarantine_message: null,
        last_seen_at: new Date(),
        macvlan_cidr: '10.44.0.0/29',
        macvlan_gateway: '10.44.0.1',
        macvlan_reserved_ips: JSON.stringify([]),
        revision: 1,
      }).execute();
      const { service } = containerService(
        database,
        seed,
        async () => currentGrant(),
      );
      await expect(service.create(seed.userId, {
        serverId: seed.serverId,
        imageId: seed.imageId,
        name: `blocked-${peerStatus}`,
      })).rejects.toMatchObject({
        response: { code: 'NETWORK_INVENTORY_UNTRUSTED' },
      });
      expect(await database.selectFrom('control.containers')
        .select('id').execute()).toEqual([]);
    });
  });
});

async function seedBase(database: Kysely<NyabaseDatabase>) {
  const userId = randomUUID();
  const serverId = randomUUID();
  const imageId = randomUUID();
  await database.insertInto('iam.users').values({
    id: userId,
    numeric_id: 1001,
    username: 'container-owner',
    password_hash: 'test-hash',
    display_name: 'Container Owner',
    status: UserStatus.Active,
    auth_version: 0,
    authz_version: 0,
  }).execute();
  await database.insertInto('iam.user_internal_ssh_keys').values({
    user_id: userId,
    encrypted_private_key: 'encrypted-private',
    public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest',
    fingerprint: 'SHA256:test',
    generation: 1,
    rotated_at: new Date(),
  }).execute();
  await database.insertInto('infra.servers').values({
    id: serverId,
    name: 'Container Node',
    slug: 'container-node',
    agent_token_hash: 'a'.repeat(64),
    host_fingerprint: 'host-a',
    agent_config_fingerprint: 'config-a',
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
    name: 'Container Image',
    docker_image: 'example/container:latest',
    runtime_overrides: runtimeOverrides,
    description: null,
    is_active: true,
    disable_ssh: true,
    deleting: false,
    cleanup_generation: 0,
    revision: 1,
  }).execute();
  return { userId, serverId, imageId };
}

function aggregate(
  id: string,
  name: string,
  seed: Awaited<ReturnType<typeof seedBase>>,
): NewContainerAggregate {
  return {
    id,
    serverId: seed.serverId,
    ownerId: seed.userId,
    imageId: seed.imageId,
    createdBy: seed.userId,
    name,
    imageRef: 'example/container:latest',
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
}

function createPayload(
  containerId: string,
  seed: Awaited<ReturnType<typeof seedBase>>,
) {
  return {
    containerId,
    specGeneration: 1,
    quotaGeneration: 1,
    dockerRoot: '/var/lib/docker',
    ownerId: seed.userId,
    numericOwnerId: 1001,
    imageDockerRef: 'example/container:latest',
    imageDockerId: 'sha256:image',
    imageId: seed.imageId,
    assignedIp: '10.44.0.2',
    runtimeOverrides,
    name: 'recover',
    cpuMillis: 1000,
    memBytes: 1024,
    diskBytes: 4096,
    gpuIndices: [],
    mounts: [],
    ssh: { enabled: false },
  };
}

function currentGrant() {
  return {
    cpuMillis: 1000,
    memBytes: 1024,
    diskBytes: 4096,
    gpuMode: GpuGrantMode.None,
    gpuIndices: [],
  };
}

async function seedQuota(
  database: Kysely<NyabaseDatabase>,
  seed: Awaited<ReturnType<typeof seedBase>>,
): Promise<void> {
  await database.insertInto('control.quota_desired').values({
    id: randomUUID(),
    server_id: seed.serverId,
    user_id: seed.userId,
    numeric_user_id: 1001,
    limit_bytes: 4096,
    source: 'grant',
    generation: 1,
    last_task_id: null,
  }).execute();
}

function containerService(
  database: Kysely<NyabaseDatabase>,
  seed: Awaited<ReturnType<typeof seedBase>>,
  createAccess: () => Promise<ReturnType<typeof currentGrant>>,
  audit: { append: ReturnType<typeof vi.fn> } | undefined = undefined,
  containerSnapshot?: ContainerSnapshot,
) {
  const transactions = new PgTransactionManager(database);
  const repository = new ContainerControlRepository(database);
  const workflowRepository = new WorkflowRepository(database, transactions);
  const enqueue = new WorkflowEnqueuePort(
    new ResourceKeyService(),
    new AgentTaskPayloadCodecService({
      decryptIfEncrypted: (value: string) => value,
    } as never),
  );
  const tasks = new ContainerTaskService(enqueue, workflowRepository);
  const grant = currentGrant();
  const access = {
    resolveServer: vi.fn().mockResolvedValue(grant),
    resolveAllowedImages: vi.fn().mockResolvedValue(new Set([seed.imageId])),
    hasMountSourceAccess: vi.fn().mockResolvedValue(true),
    resolveServerInTransaction: vi.fn().mockResolvedValue(grant),
    resolveContainerCreateAccessInTransaction: vi.fn(async () => ({
      grant: await createAccess(),
      mountSourcesAllowed: true,
    })),
  };
  const serverSnapshot = {
    gpus: [],
    disks: [],
    containers: new Map(),
    helloAt: Date.now(),
  };
  const stateCache = {
    getRuntimeBlockReason: vi.fn().mockReturnValue({ enabled: true }),
    isRuntimeReady: vi.fn().mockReturnValue(true),
    requireRuntimeReady: vi.fn().mockReturnValue({ dockerRoot: '/var/lib/docker' }),
    resolveImageDockerId: vi.fn().mockReturnValue('sha256:image'),
    get: vi.fn().mockReturnValue(serverSnapshot),
    getAll: vi.fn().mockReturnValue([serverSnapshot]),
    getContainer: vi.fn().mockReturnValue(containerSnapshot),
  };
  const service = new ContainerControlService(
    database,
    transactions,
    repository,
    access as never,
    new ContainerActionPolicyService(),
    tasks,
    new ResourceKeyService(),
    { stateCache } as never,
    { closeByRuntime: vi.fn() } as never,
    {} as never,
    { endpoint: vi.fn().mockReturnValue(null) } as never,
    { invalidate: vi.fn() } as never,
    (audit ?? { append: vi.fn().mockResolvedValue(undefined) }) as never,
    {
      createExecSessionIntentInTransaction: vi.fn(),
      closeExecSession: vi.fn(),
    } as never,
  );
  return { service, tasks };
}
