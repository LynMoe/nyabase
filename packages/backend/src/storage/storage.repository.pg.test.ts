import { randomUUID } from 'node:crypto';
import {
  ContainerPhase,
  ContainerPowerIntent,
  RemoteFsType,
  UserStatus,
  type RemoteFsParams,
} from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { StorageRepository } from './storage.repository.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('StorageRepository PostgreSQL constraints and transactions', () => {
  it('enforces RemoteFS, assignment, DataDir, quota, and IAM source constraints', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await seed(fixture);
      const invalidMountId = randomUUID();
      await expect(fixture.database.insertInto('infra.remote_fs_mounts').values({
        id: invalidMountId,
        name: 'invalid path',
        display_name: null,
        description: null,
        type: RemoteFsType.Nfs,
        host_mount_point: '/tmp/not-canonical',
        options: '',
        params: nfsParams(),
        desired_state: 'active',
        generation: 1,
        last_task_id: null,
      }).execute()).rejects.toMatchObject({ code: '23514' });

      const mount = await insertMount(context.storage);
      await context.storage.insertAssignment({
        id: randomUUID(),
        mountId: mount.id,
        serverId: context.serverId,
        desiredState: 'ensuring',
        generation: 1,
        lastTaskId: null,
      });
      await expect(context.storage.insertAssignment({
        id: randomUUID(),
        mountId: mount.id,
        serverId: context.serverId,
        desiredState: 'ensuring',
        generation: 1,
        lastTaskId: null,
      })).rejects.toMatchObject({ code: '23505' });

      await expect(fixture.database.insertInto('control.data_directories').values({
        id: randomUUID(),
        user_id: context.userId,
        source_kind: 'local',
        source_id: 'disk-a',
        name: 'invalid-local',
        source_identity: 'physical-a',
        server_id: null,
        uid: 1000,
        desired_state: 'creating',
        generation: 1,
        last_task_id: null,
      }).execute()).rejects.toMatchObject({ code: '23514' });
      await expect(fixture.database.insertInto('control.data_directories').values({
        id: randomUUID(),
        user_id: context.userId,
        source_kind: 'remote',
        source_id: randomUUID(),
        name: 'missing-remote',
        source_identity: 'remote:nfs:missing',
        server_id: null,
        uid: 1000,
        desired_state: 'creating',
        generation: 1,
        last_task_id: null,
      }).execute()).rejects.toMatchObject({ code: '23503' });

      await expect(context.storage.upsertQuotaDesired({
        id: randomUUID(),
        serverId: context.serverId,
        userId: context.userId,
        numericUserId: 1,
        limitBytes: -1,
        generation: 1,
        lastTaskId: null,
      }, null)).rejects.toMatchObject({ code: '23514' });
      await expect(fixture.database.insertInto('iam.mount_source_grants').values({
        id: randomUUID(),
        user_id: context.userId,
        group_id: null,
        source_kind: 'remote',
        source_id: randomUUID(),
        server_id: null,
        source_identity: null,
      }).execute()).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('allows exactly one assignment and DataDir CAS winner', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await seed(fixture);
      const mount = await insertMount(context.storage);
      const assignment = await context.storage.insertAssignment({
        id: randomUUID(),
        mountId: mount.id,
        serverId: context.serverId,
        desiredState: 'ensuring',
        generation: 1,
        lastTaskId: null,
      });
      const assignmentResults = await Promise.all([
        context.storage.transitionAssignment(
          assignment.id,
          1,
          ['ensuring'],
          { desiredState: 'active', generation: 2, lastTaskId: null },
        ),
        context.storage.transitionAssignment(
          assignment.id,
          1,
          ['ensuring'],
          { desiredState: 'failed', generation: 2, lastTaskId: null },
        ),
      ]);
      expect(assignmentResults.filter(Boolean)).toHaveLength(1);

      const dataDirId = randomUUID();
      await context.transactions.run((transaction) =>
        context.storage.insertDataDirectory({
          id: dataDirId,
          userId: context.userId,
          sourceKind: 'local',
          sourceId: 'disk-a',
          name: 'data-a',
          sourceIdentity: 'physical-a',
          serverId: context.serverId,
          uid: 1000,
          desiredState: 'creating',
          generation: 1,
          lastTaskId: null,
        }, context.serverId, transaction));
      const directoryResults = await Promise.all([
        context.storage.transitionDataDirectory(
          dataDirId,
          1,
          ['creating'],
          { desiredState: 'active', generation: 1, lastTaskId: null },
        ),
        context.storage.transitionDataDirectory(
          dataDirId,
          1,
          ['creating'],
          { desiredState: 'failed', generation: 1, lastTaskId: null },
        ),
      ]);
      expect(directoryResults.filter(Boolean)).toHaveLength(1);
    });
  });

  it('serializes capacity admission under concurrency', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await seed(fixture);
      const mounts = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        insertMount(context.storage, `mount-${index}`)));
      const admitted = await Promise.all(mounts.map((mount) =>
        context.transactions.run(async (transaction) => {
          await context.storage.lockRemoteAssignmentCapacity(
            context.serverId,
            transaction,
          );
          if (await context.storage.countAssignmentsForServer(
            context.serverId,
            transaction,
          ) >= 4) return false;
          await context.storage.insertAssignment({
            id: randomUUID(),
            mountId: mount.id,
            serverId: context.serverId,
            desiredState: 'ensuring',
            generation: 1,
            lastTaskId: null,
          }, transaction);
          return true;
        })));
      expect(admitted.filter(Boolean)).toHaveLength(4);
      expect(await context.storage.countAssignmentsForServer(context.serverId)).toBe(4);
    });
  });

  it('keeps DataDir and IAM authorization dependency atomic and CAS-safe', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await seed(fixture);
      const directoryId = randomUUID();
      await context.transactions.run((transaction) =>
        context.storage.insertDataDirectory({
          id: directoryId,
          userId: context.userId,
          sourceKind: 'local',
          sourceId: 'disk-a',
          name: 'data-a',
          sourceIdentity: 'physical-a',
          serverId: context.serverId,
          uid: 1000,
          desiredState: 'active',
          generation: 3,
          lastTaskId: null,
        }, context.serverId, transaction));

      expect(await fixture.database.selectFrom('control.authorization_dependencies')
        .selectAll()
        .where('dependency_kind', '=', 'data_directory')
        .where('dependency_id', '=', directoryId)
        .executeTakeFirst()).toMatchObject({
        user_id: context.userId,
        server_id: context.serverId,
        source_kind: 'local',
        source_id: 'disk-a',
        source_identity: 'physical-a',
      });

      expect(await context.transactions.run((transaction) =>
        context.storage.deleteDataDirectory(directoryId, 2, transaction))).toBe(false);
      expect(await fixture.database.selectFrom('control.authorization_dependencies')
        .select('id')
        .where('dependency_id', '=', directoryId)
        .executeTakeFirst()).toBeTruthy();

      expect(await context.transactions.run((transaction) =>
        context.storage.deleteDataDirectory(directoryId, 3, transaction))).toBe(true);
      expect(await fixture.database.selectFrom('control.authorization_dependencies')
        .select('id')
        .where('dependency_id', '=', directoryId)
        .executeTakeFirst()).toBeUndefined();
    });
  });

  it('scopes remote container references to the exact consuming Server', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await seed(fixture);
      const otherServerId = randomUUID();
      await new InfrastructureRepository(fixture.database).insertServer({
        id: otherServerId,
        name: 'storage-server-other',
        slug: 'storage-server-other',
        agentTokenHash: 'd'.repeat(64),
      });
      const mount = await insertMount(context.storage);
      const dataDirId = randomUUID();
      await context.transactions.run((transaction) =>
        context.storage.insertDataDirectory({
          id: dataDirId,
          userId: context.userId,
          sourceKind: 'remote',
          sourceId: mount.id,
          name: 'remote-data',
          sourceIdentity: 'remote:nfs:nfs.example:%2Fexports%2Fdata',
          serverId: null,
          uid: 1000,
          desiredState: 'active',
          generation: 1,
          lastTaskId: null,
        }, otherServerId, transaction));
      const imageId = randomUUID();
      await fixture.database.insertInto('infra.images').values({
        id: imageId,
        name: 'storage-reference-image',
        docker_image: 'registry.example/storage-reference:1',
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
        server_id: otherServerId,
        owner_id: context.userId,
        image_id: imageId,
        created_by: context.userId,
        name: 'remote-consumer',
        revision: 1,
        desired_generation: 1,
        image_ref: 'registry.example/storage-reference:1',
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
        server_id: otherServerId,
        resource_id: dataDirId,
        source_kind: 'remote',
        source_id: mount.id,
        source_identity: 'remote:nfs:nfs.example:%2Fexports%2Fdata',
        user_id: context.userId,
        dir_name: 'remote-data',
        container_path: '/data',
      }).execute();

      expect(await context.storage.hasContainerMountReference({
        serverId: otherServerId,
        sourceKind: 'remote',
        sourceId: mount.id,
      })).toBe(true);
      expect(await context.storage.hasContainerMountReference({
        serverId: context.serverId,
        sourceKind: 'remote',
        sourceId: mount.id,
      })).toBe(false);
      expect(await context.storage.hasContainerMountReference({
        sourceKind: 'remote',
        sourceId: mount.id,
      })).toBe(true);
    });
  });

  it('rolls back the whole Storage aggregate in the caller transaction', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await seed(fixture);
      const mountId = randomUUID();
      const directoryId = randomUUID();
      await expect(context.transactions.run(async (transaction) => {
        await context.storage.insertRemoteFsMount({
          id: mountId,
          name: 'rollback',
          displayName: null,
          description: null,
          type: RemoteFsType.Nfs,
          hostMountPoint: `/mnt/remote-fs/${mountId}`,
          options: '',
          params: nfsParams(),
        }, transaction);
        await context.storage.insertAssignment({
          id: randomUUID(),
          mountId,
          serverId: context.serverId,
          desiredState: 'ensuring',
          generation: 1,
          lastTaskId: null,
        }, transaction);
        await context.storage.insertDataDirectory({
          id: directoryId,
          userId: context.userId,
          sourceKind: 'remote',
          sourceId: mountId,
          name: 'data',
          sourceIdentity: 'remote:nfs:nfs.example:%2Fexports%2Fdata',
          serverId: null,
          uid: 1000,
          desiredState: 'creating',
          generation: 1,
          lastTaskId: null,
        }, context.serverId, transaction);
        await context.storage.upsertQuotaDesired({
          id: randomUUID(),
          serverId: context.serverId,
          userId: context.userId,
          numericUserId: 1,
          limitBytes: 1024,
          generation: 1,
          lastTaskId: null,
        }, null, transaction);
        throw new Error('rollback requested');
      })).rejects.toThrow('rollback requested');

      expect(await context.storage.findRemoteFsMount(mountId)).toBeNull();
      expect(await context.storage.findDataDirectoryById(directoryId)).toBeNull();
      expect(await context.storage.findQuotaDesired(
        context.serverId,
        context.userId,
      )).toBeNull();
      expect(await fixture.database.selectFrom('control.authorization_dependencies')
        .select('id')
        .where('dependency_id', '=', directoryId)
        .executeTakeFirst()).toBeUndefined();
    });
  });
});

async function seed(fixture: PostgresTestDatabase) {
  const infrastructure = new InfrastructureRepository(fixture.database);
  const storage = new StorageRepository(fixture.database);
  const transactions = new PgTransactionManager(fixture.database);
  const serverId = randomUUID();
  const userId = randomUUID();
  await infrastructure.insertServer({
    id: serverId,
    name: 'storage-server',
    slug: 'storage-server',
    agentTokenHash: 'c'.repeat(64),
  });
  await fixture.database.insertInto('iam.users').values({
    id: userId,
    numeric_id: 1,
    username: 'storage-user',
    password_hash: 'hash',
    display_name: 'Storage User',
    status: UserStatus.Active,
    auth_version: 1,
    authz_version: 1,
  }).execute();
  return { storage, transactions, serverId, userId };
}

async function insertMount(
  storage: StorageRepository,
  name = 'remote-a',
) {
  const id = randomUUID();
  return storage.insertRemoteFsMount({
    id,
    name,
    displayName: null,
    description: null,
    type: RemoteFsType.Nfs,
    hostMountPoint: `/mnt/remote-fs/${id}`,
    options: '',
    params: nfsParams(),
  });
}

function nfsParams(): RemoteFsParams {
  return {
    type: RemoteFsType.Nfs,
    nfsServer: 'nfs.example',
    exportPath: '/exports/data',
    version: '4.2' as const,
  };
}
