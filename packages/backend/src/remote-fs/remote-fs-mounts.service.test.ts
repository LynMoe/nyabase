import { randomUUID } from 'node:crypto';
import {
  AgentTaskKind,
  AgentTaskStatus,
  ContainerPhase,
  ContainerPowerIntent,
  MAX_PLATFORM_REMOTE_FS_MOUNTS,
  RemoteFsType,
  ServerStatus,
  UserStatus,
  type RemoteFsParams,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import type { AccessResolverService } from '../access/access-resolver.service.js';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { WorkflowFinalizerRegistry } from '../agent-tasks/workflow-finalizer.registry.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AgentGateway } from '../gateway/agent-gateway.js';
import type { MountSourcesService } from '../mount-sources/mount-sources.service.js';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import type {
  ProxySnapshotNotifierService,
} from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { StorageRepository } from '../storage/storage.repository.js';
import type { RemoteFsSecretCryptoService } from './remote-fs-secret-crypto.service.js';
import { RemoteFsMountsService } from './remote-fs-mounts.service.js';
import {
  RemoteFsWorkflowFinalizerService,
} from './remote-fs-workflow-finalizer.service.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describe('RemoteFsMountsService bulk list projection', () => {
  it.each([128, 2_048])('uses two fixed persistence calls for %i mounts', async (count) => {
    const mounts = Array.from({ length: count }, (_, index) => ({
      id: `mount-${index}`,
      params: {
        type: RemoteFsType.Nfs,
        nfsServer: 'nfs.internal',
        exportPath: `/${index}`,
        version: '4.2' as const,
      },
    }));
    const storage = {
      listRemoteFsMounts: vi.fn().mockResolvedValue(mounts),
      listAssignmentsForMountIds: vi.fn().mockResolvedValue(
        mounts.map((mount, index) => ({
          remoteFsMountId: mount.id,
          serverId: `server-${index % 2}`,
        })),
      ),
    };
    const service = new RemoteFsMountsService(
      storage as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.listWithServerIds();
    expect(result).toHaveLength(count);
    expect(storage.listRemoteFsMounts).toHaveBeenCalledOnce();
    expect(storage.listAssignmentsForMountIds).toHaveBeenCalledOnce();
    expect(storage.listAssignmentsForMountIds)
      .toHaveBeenCalledWith(mounts.map((mount) => mount.id));
  });
});

describePostgres('RemoteFsMountsService PostgreSQL workflow invariants', () => {
  it('rolls back mount and workflow task when required audit append fails', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      context.audit.append.mockRejectedValueOnce(new Error('audit unavailable'));
      await expect(context.service.create(context.actorId, mountInput()))
        .rejects.toThrow('audit unavailable');
      expect(await context.storage.listRemoteFsMounts()).toEqual([]);
      expect(await fixture.database.selectFrom('workflow.tasks').select('id').execute())
        .toEqual([]);
    });
  });

  it('serializes concurrent unassigned-mount admission at the global cap', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await fixture.database.insertInto('infra.remote_fs_mounts').values(
        Array.from(
          { length: MAX_PLATFORM_REMOTE_FS_MOUNTS - 1 },
          (_, index) => {
            const id = randomUUID();
            return {
              id,
              name: `capacity-${index}`,
              display_name: null,
              description: null,
              type: RemoteFsType.Nfs,
              host_mount_point: `/mnt/remote-fs/${id}`,
              options: '',
              params: {
                type: RemoteFsType.Nfs,
                nfsServer: 'nfs.example',
                exportPath: `/${index}`,
                version: '4.2' as const,
              },
              desired_state: 'active' as const,
              generation: 1,
              last_task_id: null,
            };
          },
        ),
      ).execute();

      const attempts = await Promise.allSettled([
        context.service.create(context.actorId, {
          ...mountInput(),
          name: 'capacity-winner-a',
          serverIds: [],
        }),
        context.service.create(context.actorId, {
          ...mountInput(),
          name: 'capacity-winner-b',
          serverIds: [],
        }),
      ]);
      expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      const rejected = attempts.find(({ status }) => status === 'rejected');
      expect(rejected).toMatchObject({
        reason: {
          response: expect.objectContaining({ code: 'REMOTE_FS_CAPACITY_REACHED' }),
        },
      });
      expect(await context.service.list())
        .toHaveLength(MAX_PLATFORM_REMOTE_FS_MOUNTS);
    });
  });

  it('rolls back both mount and workflow task when authorization is revoked', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture, {
        authorize: vi.fn().mockRejectedValue(new Error('authority revoked')),
      });
      await expect(context.service.create(context.actorId, mountInput()))
        .rejects.toThrow('authority revoked');
      expect(await context.storage.listRemoteFsMounts()).toEqual([]);
      expect(await fixture.database.selectFrom('workflow.tasks').select('id').execute())
        .toEqual([]);
    });
  });

  it('isolates assignment claims per Server and permits metadata-only edits', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const mount = await context.service.create(context.actorId, mountInput());
      const [first, second] = await Promise.all([
        context.service.assignServer(context.actorId, mount.id, context.serverIds[0]!),
        context.service.assignServer(context.actorId, mount.id, context.serverIds[1]!),
      ]);
      expect(first.taskId).toEqual(expect.any(String));
      expect(second.taskId).toEqual(expect.any(String));
      expect(await context.storage.listAssignmentsForMount(mount.id)).toHaveLength(2);
      const claims = await fixture.database.selectFrom('workflow.resource_claims')
        .select(['resource_key', 'task_id'])
        .orderBy('resource_key')
        .execute();
      expect(claims.map((claim) => claim.task_id).sort()).toEqual(
        [first.taskId!, first.taskId!, second.taskId!, second.taskId!].sort(),
      );

      const renamed = await context.service.update(
        context.actorId,
        mount.id,
        { displayName: 'Renamed' },
      );
      expect(renamed).toMatchObject({
        displayName: 'Renamed',
        hostMountPoint: `/mnt/remote-fs/${mount.id}`,
        generation: 1,
        taskIds: [],
      });
      expect(await fixture.database.selectFrom('workflow.tasks')
        .select('id')
        .execute()).toHaveLength(2);
    });
  });

  it('allows unassigning a non-consuming Server while fencing the consumer Server', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const mount = await context.service.create(context.actorId, mountInput());
      const assignments = await Promise.all(context.serverIds.map((serverId) =>
        context.service.assignServer(context.actorId, mount.id, serverId)));
      for (const assignment of assignments) {
        await context.finalize(assignment.taskId!, {
          status: 'succeeded',
          result: { id: mount.id, hostMountPoint: mount.hostMountPoint },
        });
      }

      const dataDirId = randomUUID();
      await fixture.database.insertInto('control.data_directories').values({
        id: dataDirId,
        user_id: context.actorId,
        source_kind: 'remote',
        source_id: mount.id,
        name: 'remote-data',
        source_identity: 'remote:nfs:nfs.example:%2Fexports%2Fdata',
        server_id: null,
        uid: 1000,
        desired_state: 'active',
        generation: 1,
        last_task_id: null,
      }).execute();
      const imageId = randomUUID();
      await fixture.database.insertInto('infra.images').values({
        id: imageId,
        name: 'remote-consumer-image',
        docker_image: 'registry.example/remote-consumer:1',
        runtime_overrides: {
          uid: 0, entrypoint: null, cmd: null, init: false,
        },
        description: null,
        is_active: true,
        disable_ssh: false,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      const containerId = randomUUID();
      await fixture.database.insertInto('control.containers').values({
        id: containerId,
        server_id: context.serverIds[1]!,
        owner_id: context.actorId,
        image_id: imageId,
        created_by: context.actorId,
        name: 'remote-consumer',
        revision: 1,
        desired_generation: 1,
        image_ref: 'registry.example/remote-consumer:1',
        image_default_uid: 0,
        image_runtime_overrides: {
          uid: 0, entrypoint: null, cmd: null, init: false,
        },
        cpu_millis: 100,
        mem_bytes: 1_024,
        disk_bytes: 1_024,
        gpu_mode: 'none',
        gpu_indices: [],
        mounts_json: '[]',
        power_intent: ContainerPowerIntent.Running,
        lifecycle_phase: ContainerPhase.Active,
        observed_generation: null,
        bound_runtime_id: null,
        quota_paths: [],
        runtime_spec_hash: null,
        active_task_id: null,
        last_transition_at: new Date(),
        failure_reason: null,
        failure_code: null,
      }).execute();
      await fixture.database.insertInto('control.container_mounts').values({
        id: randomUUID(),
        container_id: containerId,
        server_id: context.serverIds[1]!,
        resource_id: dataDirId,
        source_kind: 'remote',
        source_id: mount.id,
        source_identity: 'remote:nfs:nfs.example:%2Fexports%2Fdata',
        user_id: context.actorId,
        dir_name: 'remote-data',
        container_path: '/data',
      }).execute();

      await expect(context.service.unassignServer(
        context.actorId,
        mount.id,
        context.serverIds[0]!,
      )).resolves.toEqual({ ok: true, taskIds: [expect.any(String)] });
      await expect(context.service.unassignServer(
        context.actorId,
        mount.id,
        context.serverIds[1]!,
      )).rejects.toThrow(/referenced by a container/);
    });
  });

  it('finalizes ensure and absent in the same PostgreSQL projection state machine', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const mount = await context.service.create(context.actorId, mountInput());
      const assigned = await context.service.assignServer(
        context.actorId,
        mount.id,
        context.serverIds[0]!,
      );
      await context.finalize(assigned.taskId!, {
        status: 'succeeded',
        result: {
          id: mount.id,
          hostMountPoint: mount.hostMountPoint,
        },
      });
      expect(await context.storage.findAssignment(
        mount.id,
        context.serverIds[0]!,
      )).toMatchObject({ desiredState: 'active', lastTaskId: assigned.taskId });

      const removal = await context.service.unassignServer(
        context.actorId,
        mount.id,
        context.serverIds[0]!,
      );
      await context.finalize(removal.taskIds[0]!, {
        status: 'succeeded',
        result: { id: mount.id },
      });
      expect(await context.storage.findAssignment(
        mount.id,
        context.serverIds[0]!,
      )).toBeNull();
      expect(await context.storage.findRemoteFsMount(mount.id))
        .toMatchObject({ id: mount.id, desiredState: 'active' });
    });
  });

  it('keeps failed unmount removing and allows an explicit repair intent', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const mount = await context.service.create(context.actorId, mountInput());
      const assigned = await context.service.assignServer(
        context.actorId,
        mount.id,
        context.serverIds[0]!,
      );
      await context.finalize(assigned.taskId!, {
        status: 'succeeded',
        result: { id: mount.id, hostMountPoint: mount.hostMountPoint },
      });
      const removal = await context.service.unassignServer(
        context.actorId,
        mount.id,
        context.serverIds[0]!,
      );
      await context.finalize(removal.taskIds[0]!, {
        status: 'failed',
        error: { code: 'UNMOUNT_FAILED', message: 'busy' },
        observed: { applied: true },
      });
      expect(await context.storage.findAssignment(
        mount.id,
        context.serverIds[0]!,
      )).toMatchObject({ desiredState: 'removing' });

      const repair = await context.service.assignServer(
        context.actorId,
        mount.id,
        context.serverIds[0]!,
      );
      expect(repair).toMatchObject({
        desiredState: 'ensuring',
        generation: 3,
        taskId: expect.any(String),
      });
    });
  });

  it('requires successful unassignment before deleting the global mount', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const mount = await context.service.create(context.actorId, mountInput());
      const assigned = await context.service.assignServer(
        context.actorId,
        mount.id,
        context.serverIds[0]!,
      );
      await expect(context.service.remove(context.actorId, mount.id))
        .rejects.toThrow(/Unassign every server successfully/);
      await context.finalize(assigned.taskId!, {
        status: 'succeeded',
        result: { id: mount.id, hostMountPoint: mount.hostMountPoint },
      });
      const removal = await context.service.unassignServer(
        context.actorId,
        mount.id,
        context.serverIds[0]!,
      );
      await context.finalize(removal.taskIds[0]!, {
        status: 'succeeded',
        result: { id: mount.id },
      });
      await expect(context.service.remove(context.actorId, mount.id))
        .resolves.toEqual({ ok: true, taskIds: [] });
      expect(await context.storage.findRemoteFsMount(mount.id)).toBeNull();
    });
  });
});

async function setup(
  fixture: PostgresTestDatabase,
  options: { authorize?: ReturnType<typeof vi.fn> } = {},
) {
  const transactions = new PgTransactionManager(fixture.database);
  const storage = new StorageRepository(fixture.database);
  const keys = new ResourceKeyService();
  const codec = new AgentTaskPayloadCodecService({
    decryptIfEncrypted: (value: string) => value,
  } as never);
  const workflow = new WorkflowEnqueuePort(keys, codec);
  const workflowRepository = new WorkflowRepository(
    fixture.database,
    transactions,
    codec,
  );
  const actorId = randomUUID();
  const serverIds = [randomUUID(), randomUUID()];
  await fixture.database.insertInto('iam.users').values({
    id: actorId,
    numeric_id: 1001,
    username: `rfs-${actorId.slice(0, 8)}`,
    password_hash: 'hash',
    display_name: 'RemoteFS Admin',
    status: UserStatus.Active,
    auth_version: 1,
    authz_version: 1,
  }).execute();
  await fixture.database.insertInto('infra.servers').values(serverIds.map((id, index) => ({
    id,
    name: `RemoteFS Node ${index}`,
    slug: `rfs-${id.slice(0, 8)}`,
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
  }))).execute();
  const access = {
    assertActorCapabilitiesInTransaction:
      options.authorize ?? vi.fn().mockResolvedValue(new Set()),
    authorizationCommitted: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccessResolverService;
  const gateway = {
    isOnline: vi.fn().mockReturnValue(true),
    stateCache: {
      get: vi.fn().mockReturnValue({
        runtimeReady: true,
        containers: new Map(),
      }),
      getRemoteFsMountStatus: vi.fn(),
    },
  } as unknown as AgentGateway;
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new RemoteFsMountsService(
    storage,
    transactions,
    audit as unknown as AuditService,
    access,
    workflow,
    keys,
    gateway,
    {
      encrypt: (value: string) => value,
      isEncrypted: () => false,
    } as unknown as RemoteFsSecretCryptoService,
    {
      deleteSourceInTransaction: vi.fn(async () => undefined),
    } as unknown as MountSourcesService,
    { invalidate: vi.fn() } as unknown as ProxySnapshotNotifierService,
  );
  const registry = new WorkflowFinalizerRegistry();
  const registrar = new RemoteFsWorkflowFinalizerService(registry, storage);
  registrar.onModuleInit();
  return {
    actorId,
    serverIds,
    storage,
    service,
    audit,
    finalize: async (
      taskId: string,
      terminal: {
        status: 'succeeded';
        result: Record<string, unknown> | null;
      } | {
        status: 'failed';
        error: { code: string; message: string };
        observed: Record<string, unknown> | null;
      },
    ) => {
      const task = await workflowRepository.findTask(taskId);
      if (!task) throw new Error(`missing task ${taskId}`);
      const handler = registry.get(task.kind as AgentTaskKind);
      if (!handler) throw new Error(`missing finalizer ${task.kind}`);
      await transactions.run((transaction) =>
        handler(transaction, task, {
          taskId,
          payloadHash: task.payloadHash,
          ...terminal,
        } as never));
      await fixture.database.updateTable('workflow.tasks')
        .set({
          status: terminal.status === 'succeeded'
            ? AgentTaskStatus.Succeeded
            : AgentTaskStatus.Failed,
          completed_at: new Date(),
        })
        .where('id', '=', taskId)
        .executeTakeFirstOrThrow();
      await fixture.database.deleteFrom('workflow.resource_claims')
        .where('task_id', '=', taskId)
        .execute();
    },
  };
}

function mountInput() {
  return {
    name: 'remote-a',
    type: RemoteFsType.Nfs,
    params: nfsParams(),
  };
}

function nfsParams(): RemoteFsParams {
  return {
    type: RemoteFsType.Nfs,
    nfsServer: 'nfs.example',
    exportPath: '/exports/data',
    version: '4.2' as const,
  };
}
