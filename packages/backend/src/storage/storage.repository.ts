import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Selectable, Transaction, Updateable } from 'kysely';
import { sql } from 'kysely';
import type {
  DataDirectoryRecord,
  MountSourceGrantRecord,
  QuotaDesiredRecord,
  RemoteFsMountRecord,
  RemoteFsServerAssignmentRecord,
} from '../domain/domain-records.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import type {
  DataDirectoryTable,
  QuotaDesiredTable,
  RemoteFsMountTable,
  RemoteFsServerAssignmentTable,
} from './storage-database.types.js';

export type StorageExecutor =
  | Kysely<NyabaseDatabase>
  | Transaction<NyabaseDatabase>;

export const STORAGE_ADVISORY_NAMESPACE = 1_856_214_886;
export const REMOTE_ASSIGNMENT_CAPACITY_KEY = 1;
export const DATA_DIRECTORY_CAPACITY_KEY = 2;
export const QUOTA_MUTATION_KEY = 3;

export type MountSourceGrantScope = 'user' | 'group';
export type MountSourceGrantTarget =
  | { sourceKind: 'local'; sourceId: string; serverId: string; sourceIdentity: string }
  | { sourceKind: 'remote'; sourceId: string };
export type MountSourceTarget =
  | { sourceKind: 'local'; sourceId: string; serverId: string }
  | { sourceKind: 'remote'; sourceId: string };

export interface RemoteFsMountInsert {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  type: string;
  hostMountPoint: string;
  options: string;
  params: RemoteFsMountRecord['params'];
}

export interface DataDirectoryInsert {
  id: string;
  userId: string;
  sourceKind: 'local' | 'remote';
  sourceId: string;
  name: string;
  sourceIdentity: string;
  serverId: string | null;
  uid: number;
  desiredState: DataDirectoryRecord['desiredState'];
  generation: number;
  lastTaskId: string | null;
}

export interface QuotaDesiredUpsert {
  id: string;
  serverId: string;
  userId: string;
  numericUserId: number;
  limitBytes: number;
  generation: number;
  lastTaskId: string | null;
}

@Injectable()
export class StorageRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  executor(executor?: StorageExecutor): StorageExecutor {
    return executor ?? this.database;
  }

  async lockRemoteAssignmentCapacity(
    serverId: string,
    executor: StorageExecutor,
  ): Promise<void> {
    await sql`select pg_advisory_xact_lock(
      ${STORAGE_ADVISORY_NAMESPACE},
      hashtext(${`remote-assignment:${serverId}`})
    )`.execute(executor);
  }

  async lockRemoteFsMountCapacity(
    executor: StorageExecutor,
  ): Promise<void> {
    await sql`select pg_advisory_xact_lock(
      ${STORAGE_ADVISORY_NAMESPACE},
      hashtext('remote-fs-mount-capacity')
    )`.execute(executor);
  }

  async countRemoteFsMounts(
    executor: StorageExecutor = this.database,
  ): Promise<number> {
    const row = await executor.selectFrom('infra.remote_fs_mounts')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async lockDataDirectoryCapacity(
    serverId: string,
    executor: StorageExecutor,
  ): Promise<void> {
    await sql`select pg_advisory_xact_lock(
      ${STORAGE_ADVISORY_NAMESPACE},
      hashtext(${`data-directory:${serverId}`})
    )`.execute(executor);
  }

  async lockQuotaMutation(
    serverId: string,
    userId: string,
    executor: StorageExecutor,
  ): Promise<void> {
    await sql`select pg_advisory_xact_lock(
      ${STORAGE_ADVISORY_NAMESPACE},
      hashtext(${`quota:${serverId}:${userId}`})
    )`.execute(executor);
  }

  async listRemoteFsMounts(
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsMountRecord[]> {
    return (await executor.selectFrom('infra.remote_fs_mounts')
      .selectAll()
      .orderBy('name')
      .orderBy('id')
      .execute()).map(toRemoteFsMount);
  }

  async listRemoteFsMountsByServer(
    serverId: string,
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsMountRecord[]> {
    return (await executor.selectFrom('infra.remote_fs_mounts as mount')
      .innerJoin(
        'infra.remote_fs_server_assignments as assignment',
        'assignment.remote_fs_mount_id',
        'mount.id',
      )
      .selectAll('mount')
      .where('assignment.server_id', '=', serverId)
      .orderBy('mount.name')
      .orderBy('mount.id')
      .execute()).map(toRemoteFsMount);
  }

  async listRemoteFsMountsByIds(
    ids: readonly string[],
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsMountRecord[]> {
    if (ids.length === 0) return [];
    return (await executor.selectFrom('infra.remote_fs_mounts')
      .selectAll()
      .where('id', 'in', [...new Set(ids)])
      .orderBy('id')
      .execute()).map(toRemoteFsMount);
  }

  async findRemoteFsMount(
    id: string,
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsMountRecord | null> {
    const row = await executor.selectFrom('infra.remote_fs_mounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toRemoteFsMount(row) : null;
  }

  async findActiveRemoteFsMount(
    id: string,
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsMountRecord | null> {
    const row = await executor.selectFrom('infra.remote_fs_mounts')
      .selectAll()
      .where('id', '=', id)
      .where('desired_state', '=', 'active')
      .executeTakeFirst();
    return row ? toRemoteFsMount(row) : null;
  }

  async lockActiveRemoteFsMount(
    id: string,
    executor: StorageExecutor,
  ): Promise<RemoteFsMountRecord | null> {
    const row = await executor.selectFrom('infra.remote_fs_mounts')
      .selectAll()
      .where('id', '=', id)
      .where('desired_state', '=', 'active')
      .forKeyShare()
      .executeTakeFirst();
    return row ? toRemoteFsMount(row) : null;
  }

  async insertRemoteFsMount(
    input: RemoteFsMountInsert,
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsMountRecord> {
    const row = await executor.insertInto('infra.remote_fs_mounts')
      .values({
        id: input.id,
        name: input.name,
        display_name: input.displayName,
        description: input.description,
        type: input.type,
        host_mount_point: input.hostMountPoint,
        options: input.options,
        params: input.params,
        desired_state: 'active',
        generation: 1,
        last_task_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRemoteFsMount(row);
  }

  async updateActiveRemoteFsMountMetadata(
    id: string,
    patch: {
      name?: string;
      displayName?: string | null;
      description?: string | null;
    },
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsMountRecord | null> {
    const values: Updateable<RemoteFsMountTable> = {};
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.displayName !== undefined) values.display_name = patch.displayName;
    if (patch.description !== undefined) values.description = patch.description;
    const row = await executor.updateTable('infra.remote_fs_mounts')
      .set(values)
      .where('id', '=', id)
      .where('desired_state', '=', 'active')
      .returningAll()
      .executeTakeFirst();
    return row ? toRemoteFsMount(row) : null;
  }

  async deleteRemoteFsMount(
    id: string,
    executor: StorageExecutor = this.database,
  ): Promise<boolean> {
    const result = await executor.deleteFrom('infra.remote_fs_mounts')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  async listAssignmentsForMount(
    mountId: string,
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsServerAssignmentRecord[]> {
    return (await executor.selectFrom('infra.remote_fs_server_assignments')
      .selectAll()
      .where('remote_fs_mount_id', '=', mountId)
      .orderBy('server_id')
      .execute()).map(toRemoteFsAssignment);
  }

  async listAssignmentsForMountIds(
    mountIds: readonly string[],
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsServerAssignmentRecord[]> {
    const uniqueIds = [...new Set(mountIds)];
    if (uniqueIds.length === 0) return [];
    return (await executor.selectFrom('infra.remote_fs_server_assignments')
      .selectAll()
      .where('remote_fs_mount_id', 'in', uniqueIds)
      .orderBy('remote_fs_mount_id')
      .orderBy('server_id')
      .execute()).map(toRemoteFsAssignment);
  }

  async listAssignmentsForServer(
    serverId: string,
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsServerAssignmentRecord[]> {
    return (await executor.selectFrom('infra.remote_fs_server_assignments')
      .selectAll()
      .where('server_id', '=', serverId)
      .orderBy('remote_fs_mount_id')
      .execute()).map(toRemoteFsAssignment);
  }

  async findAssignment(
    mountId: string,
    serverId: string,
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsServerAssignmentRecord | null> {
    const row = await executor.selectFrom('infra.remote_fs_server_assignments')
      .selectAll()
      .where('remote_fs_mount_id', '=', mountId)
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    return row ? toRemoteFsAssignment(row) : null;
  }

  async countAssignmentsForServer(
    serverId: string,
    executor: StorageExecutor = this.database,
  ): Promise<number> {
    const row = await executor.selectFrom('infra.remote_fs_server_assignments')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countActiveReplacementAssignments(
    mountId: string,
    removingServerId: string,
    executor: StorageExecutor = this.database,
  ): Promise<number> {
    const row = await executor.selectFrom('infra.remote_fs_server_assignments')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .where('remote_fs_mount_id', '=', mountId)
      .where('server_id', '!=', removingServerId)
      .where('desired_state', '=', 'active')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async insertAssignment(
    input: {
      id: string;
      mountId: string;
      serverId: string;
      desiredState: RemoteFsServerAssignmentRecord['desiredState'];
      generation: number;
      lastTaskId: string | null;
    },
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsServerAssignmentRecord> {
    const row = await executor.insertInto('infra.remote_fs_server_assignments')
      .values({
        id: input.id,
        remote_fs_mount_id: input.mountId,
        server_id: input.serverId,
        desired_state: input.desiredState,
        generation: input.generation,
        last_task_id: input.lastTaskId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRemoteFsAssignment(row);
  }

  async transitionAssignment(
    id: string,
    expectedGeneration: number,
    expectedStates: readonly RemoteFsServerAssignmentRecord['desiredState'][],
    next: {
      desiredState: RemoteFsServerAssignmentRecord['desiredState'];
      generation: number;
      lastTaskId: string | null;
    },
    executor: StorageExecutor = this.database,
  ): Promise<RemoteFsServerAssignmentRecord | null> {
    const row = await executor.updateTable('infra.remote_fs_server_assignments')
      .set({
        desired_state: next.desiredState,
        generation: next.generation,
        last_task_id: next.lastTaskId,
      })
      .where('id', '=', id)
      .where('generation', '=', expectedGeneration)
      .where('desired_state', 'in', [...expectedStates])
      .returningAll()
      .executeTakeFirst();
    return row ? toRemoteFsAssignment(row) : null;
  }

  async deleteAssignment(
    id: string,
    expectedGeneration: number,
    executor: StorageExecutor = this.database,
  ): Promise<boolean> {
    const result = await executor.deleteFrom('infra.remote_fs_server_assignments')
      .where('id', '=', id)
      .where('generation', '=', expectedGeneration)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  async listDataDirectoriesForUser(
    userId: string,
    serverId: string,
    localSourceIds: readonly string[],
    remoteSourceIds: readonly string[],
    executor: StorageExecutor = this.database,
  ): Promise<DataDirectoryRecord[]> {
    if (localSourceIds.length === 0 && remoteSourceIds.length === 0) return [];
    const rows = await executor.selectFrom('control.data_directories')
      .selectAll()
      .where('user_id', '=', userId)
      .where((expression) => expression.or([
        ...(localSourceIds.length === 0 ? [] : [
          expression.and([
            expression('source_kind', '=', 'local'),
            expression('server_id', '=', serverId),
            expression('source_id', 'in', [...localSourceIds]),
          ]),
        ]),
        ...(remoteSourceIds.length === 0 ? [] : [
          expression.and([
            expression('source_kind', '=', 'remote'),
            expression('source_id', 'in', [...remoteSourceIds]),
          ]),
        ]),
      ]))
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toDataDirectory);
  }

  async listDataDirectoriesForSource(
    sourceKind: 'local' | 'remote',
    sourceId: string,
    serverId?: string,
    executor: StorageExecutor = this.database,
  ): Promise<DataDirectoryRecord[]> {
    let query = executor.selectFrom('control.data_directories')
      .selectAll()
      .where('source_kind', '=', sourceKind)
      .where('source_id', '=', sourceId);
    if (sourceKind === 'local' && serverId) query = query.where('server_id', '=', serverId);
    return (await query.orderBy('id').execute()).map(toDataDirectory);
  }

  async listDataDirectoriesForServerInventory(
    serverId: string,
    remoteMountIds: readonly string[],
    executor: StorageExecutor = this.database,
  ): Promise<DataDirectoryRecord[]> {
    const rows = await executor.selectFrom('control.data_directories')
      .selectAll()
      .where((expression) => expression.or([
        expression.and([
          expression('source_kind', '=', 'local'),
          expression('server_id', '=', serverId),
        ]),
        ...(remoteMountIds.length === 0 ? [] : [
          expression.and([
            expression('source_kind', '=', 'remote'),
            expression('source_id', 'in', [...remoteMountIds]),
          ]),
        ]),
      ]))
      .orderBy('id')
      .execute();
    return rows.map(toDataDirectory);
  }

  async findDataDirectoryById(
    id: string,
    executor: StorageExecutor = this.database,
  ): Promise<DataDirectoryRecord | null> {
    const row = await executor.selectFrom('control.data_directories')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toDataDirectory(row) : null;
  }

  async findDataDirectoryByPhysicalName(
    input: {
      userId?: string;
      sourceKind: 'local' | 'remote';
      sourceId: string;
      serverId?: string;
      name: string;
    },
    executor: StorageExecutor = this.database,
  ): Promise<DataDirectoryRecord | null> {
    let query = executor.selectFrom('control.data_directories')
      .selectAll()
      .where('source_kind', '=', input.sourceKind)
      .where('source_id', '=', input.sourceId)
      .where('name', '=', input.name);
    if (input.userId) query = query.where('user_id', '=', input.userId);
    if (input.sourceKind === 'local') query = query.where('server_id', '=', input.serverId!);
    const row = await query.executeTakeFirst();
    return row ? toDataDirectory(row) : null;
  }

  async countDataDirectoriesForServer(
    serverId: string,
    executor: StorageExecutor = this.database,
  ): Promise<number> {
    const row = await executor.selectFrom('control.data_directories as directory')
      .leftJoin(
        'infra.remote_fs_server_assignments as assignment',
        (join) => join
          .onRef('assignment.remote_fs_mount_id', '=', sql`directory.source_id::uuid`)
          .on('directory.source_kind', '=', 'remote')
          .on('assignment.server_id', '=', serverId),
      )
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .where((expression) => expression.or([
        expression.and([
          expression('directory.source_kind', '=', 'local'),
          expression('directory.server_id', '=', serverId),
        ]),
        expression('assignment.id', 'is not', null),
      ]))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countDataDirectoryProjection(
    serverId: string,
    includeRemoteMountId: string | undefined,
    executor: StorageExecutor = this.database,
  ): Promise<number> {
    const assignments = await this.listAssignmentsForServer(serverId, executor);
    const remoteIds = new Set(assignments.map((assignment) => assignment.remoteFsMountId));
    if (includeRemoteMountId) remoteIds.add(includeRemoteMountId);
    const [local, remote] = await Promise.all([
      executor.selectFrom('control.data_directories')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .where('source_kind', '=', 'local')
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow(),
      remoteIds.size === 0
        ? Promise.resolve({ count: '0' })
        : executor.selectFrom('control.data_directories')
          .select((expression) => expression.fn.countAll<string>().as('count'))
          .where('source_kind', '=', 'remote')
          .where('source_id', 'in', [...remoteIds])
          .executeTakeFirstOrThrow(),
    ]);
    return Number(local.count) + Number(remote.count);
  }

  async hasContainerMountReference(
    input: {
      serverId?: string;
      sourceKind: 'local' | 'remote';
      sourceId: string;
      userId?: string;
      dirName?: string;
    },
    executor: StorageExecutor = this.database,
  ): Promise<boolean> {
    let query = executor.selectFrom('control.container_mounts')
      .select('id')
      .where('source_kind', '=', input.sourceKind)
      .where('source_id', '=', input.sourceId);
    if (input.serverId !== undefined) {
      query = query.where('server_id', '=', input.serverId);
    }
    if (input.userId !== undefined) query = query.where('user_id', '=', input.userId);
    if (input.dirName !== undefined) query = query.where('dir_name', '=', input.dirName);
    return Boolean(await query.executeTakeFirst());
  }

  async insertDataDirectory(
    input: DataDirectoryInsert,
    dependencyServerId: string,
    executor: Transaction<NyabaseDatabase>,
  ): Promise<DataDirectoryRecord> {
    const row = await executor.insertInto('control.data_directories')
      .values({
        id: input.id,
        user_id: input.userId,
        source_kind: input.sourceKind,
        source_id: input.sourceId,
        name: input.name,
        source_identity: input.sourceIdentity,
        server_id: input.serverId,
        uid: input.uid,
        desired_state: input.desiredState,
        generation: input.generation,
        last_task_id: input.lastTaskId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await executor.insertInto('control.authorization_dependencies')
      .values({
        id: input.id,
        dependency_kind: 'data_directory',
        dependency_id: input.id,
        user_id: input.userId,
        server_id: dependencyServerId,
        source_kind: input.sourceKind,
        source_id: input.sourceId,
        source_identity: input.sourceKind === 'local' ? input.sourceIdentity : null,
      })
      .execute();
    return toDataDirectory(row);
  }

  async transitionDataDirectory(
    id: string,
    expectedGeneration: number,
    expectedStates: readonly DataDirectoryRecord['desiredState'][],
    next: {
      desiredState: DataDirectoryRecord['desiredState'];
      generation: number;
      lastTaskId: string | null;
    },
    executor: StorageExecutor = this.database,
  ): Promise<DataDirectoryRecord | null> {
    const row = await executor.updateTable('control.data_directories')
      .set({
        desired_state: next.desiredState,
        generation: next.generation,
        last_task_id: next.lastTaskId,
      })
      .where('id', '=', id)
      .where('generation', '=', expectedGeneration)
      .where('desired_state', 'in', [...expectedStates])
      .returningAll()
      .executeTakeFirst();
    return row ? toDataDirectory(row) : null;
  }

  async deleteDataDirectory(
    id: string,
    expectedGeneration: number,
    executor: Transaction<NyabaseDatabase>,
  ): Promise<boolean> {
    const result = await executor.deleteFrom('control.data_directories')
      .where('id', '=', id)
      .where('generation', '=', expectedGeneration)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) !== 1) return false;
    await executor.deleteFrom('control.authorization_dependencies')
      .where('dependency_kind', '=', 'data_directory')
      .where('dependency_id', '=', id)
      .execute();
    return true;
  }

  async findQuotaDesired(
    serverId: string,
    userId: string,
    executor: StorageExecutor = this.database,
  ): Promise<QuotaDesiredRecord | null> {
    const row = await executor.selectFrom('control.quota_desired')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? toQuotaDesired(row) : null;
  }

  async upsertQuotaDesired(
    input: QuotaDesiredUpsert,
    expectedGeneration: number | null,
    executor: StorageExecutor = this.database,
  ): Promise<QuotaDesiredRecord | null> {
    if (expectedGeneration === null) {
      const row = await executor.insertInto('control.quota_desired')
        .values({
          id: input.id,
          server_id: input.serverId,
          user_id: input.userId,
          numeric_user_id: input.numericUserId,
          limit_bytes: input.limitBytes,
          source: 'grant',
          generation: input.generation,
          last_task_id: input.lastTaskId,
        })
        .onConflict((conflict) => conflict.columns(['server_id', 'user_id']).doNothing())
        .returningAll()
        .executeTakeFirst();
      return row ? toQuotaDesired(row) : null;
    }
    const row = await executor.updateTable('control.quota_desired')
      .set({
        numeric_user_id: input.numericUserId,
        limit_bytes: input.limitBytes,
        source: 'grant',
        generation: input.generation,
        last_task_id: input.lastTaskId,
      })
      .where('server_id', '=', input.serverId)
      .where('user_id', '=', input.userId)
      .where('generation', '=', expectedGeneration)
      .returningAll()
      .executeTakeFirst();
    return row ? toQuotaDesired(row) : null;
  }

  async setQuotaLastTask(
    id: string,
    generation: number,
    taskId: string,
    executor: StorageExecutor = this.database,
  ): Promise<boolean> {
    const result = await executor.updateTable('control.quota_desired')
      .set({ last_task_id: taskId })
      .where('id', '=', id)
      .where('generation', '=', generation)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async listMountSourceGrantsForScope(
    scope: MountSourceGrantScope,
    scopeId: string,
    executor: StorageExecutor = this.database,
  ): Promise<MountSourceGrantRecord[]> {
    const rows = await (scope === 'user'
      ? executor.selectFrom('iam.mount_source_grants')
        .selectAll().where('user_id', '=', scopeId)
      : executor.selectFrom('iam.mount_source_grants')
        .selectAll().where('group_id', '=', scopeId))
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toMountSourceGrant);
  }

  async listMountSourceGrantsForTarget(
    target: MountSourceTarget,
    executor: StorageExecutor = this.database,
  ): Promise<MountSourceGrantRecord[]> {
    let query = executor.selectFrom('iam.mount_source_grants')
      .selectAll()
      .where('source_kind', '=', target.sourceKind)
      .where('source_id', '=', target.sourceId);
    if (target.sourceKind === 'local') query = query.where('server_id', '=', target.serverId);
    return (await query.orderBy('created_at').orderBy('id').execute())
      .map(toMountSourceGrant);
  }

  async findExactMountSourceGrant(
    scope: MountSourceGrantScope,
    scopeId: string,
    target: MountSourceGrantTarget,
    executor: StorageExecutor = this.database,
  ): Promise<MountSourceGrantRecord | null> {
    let query = executor.selectFrom('iam.mount_source_grants')
      .selectAll()
      .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
      .where('source_kind', '=', target.sourceKind)
      .where('source_id', '=', target.sourceId);
    query = target.sourceKind === 'local'
      ? query.where('server_id', '=', target.serverId)
        .where('source_identity', '=', target.sourceIdentity)
      : query.where('server_id', 'is', null)
        .where('source_identity', 'is', null);
    const row = await query.executeTakeFirst();
    return row ? toMountSourceGrant(row) : null;
  }

  async insertMountSourceGrant(
    id: string,
    scope: MountSourceGrantScope,
    scopeId: string,
    target: MountSourceGrantTarget,
    executor: StorageExecutor = this.database,
  ): Promise<MountSourceGrantRecord | null> {
    const row = await executor.insertInto('iam.mount_source_grants')
      .values({
        id,
        user_id: scope === 'user' ? scopeId : null,
        group_id: scope === 'group' ? scopeId : null,
        source_kind: target.sourceKind,
        source_id: target.sourceId,
        server_id: target.sourceKind === 'local' ? target.serverId : null,
        source_identity: target.sourceKind === 'local' ? target.sourceIdentity : null,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .executeTakeFirst();
    return row ? toMountSourceGrant(row) : null;
  }

  async deleteMountSourceGrantsForTarget(
    target: MountSourceTarget,
    executor: StorageExecutor = this.database,
  ): Promise<MountSourceGrantRecord[]> {
    let query = executor.deleteFrom('iam.mount_source_grants')
      .where('source_kind', '=', target.sourceKind)
      .where('source_id', '=', target.sourceId);
    if (target.sourceKind === 'local') query = query.where('server_id', '=', target.serverId);
    const rows = await query.returningAll().execute();
    return rows.map(toMountSourceGrant);
  }

  async deleteMountSourceGrantsForScope(
    scope: MountSourceGrantScope,
    scopeId: string,
    executor: StorageExecutor = this.database,
  ): Promise<MountSourceGrantRecord[]> {
    const query = executor.deleteFrom('iam.mount_source_grants')
      .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId);
    return (await query.returningAll().execute()).map(toMountSourceGrant);
  }

  async deleteExactMountSourceGrants(
    scope: MountSourceGrantScope,
    scopeId: string,
    target: MountSourceTarget,
    executor: StorageExecutor = this.database,
  ): Promise<MountSourceGrantRecord[]> {
    let query = executor.deleteFrom('iam.mount_source_grants')
      .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
      .where('source_kind', '=', target.sourceKind)
      .where('source_id', '=', target.sourceId);
    if (target.sourceKind === 'local') query = query.where('server_id', '=', target.serverId);
    return (await query.returningAll().execute()).map(toMountSourceGrant);
  }
}

function jsonValue<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

function toRemoteFsMount(row: Selectable<RemoteFsMountTable>): RemoteFsMountRecord {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    type: row.type,
    hostMountPoint: row.host_mount_point,
    options: row.options,
    params: jsonValue(row.params),
    desiredState: row.desired_state,
    generation: row.generation,
    lastTaskId: row.last_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRemoteFsAssignment(
  row: Selectable<RemoteFsServerAssignmentTable>,
): RemoteFsServerAssignmentRecord {
  return {
    id: row.id,
    remoteFsMountId: row.remote_fs_mount_id,
    serverId: row.server_id,
    desiredState: row.desired_state,
    generation: row.generation,
    lastTaskId: row.last_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDataDirectory(row: Selectable<DataDirectoryTable>): DataDirectoryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    name: row.name,
    sourceIdentity: row.source_identity,
    serverId: row.server_id,
    uid: row.uid,
    desiredState: row.desired_state,
    generation: row.generation,
    lastTaskId: row.last_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toQuotaDesired(row: Selectable<QuotaDesiredTable>): QuotaDesiredRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    userId: row.user_id,
    numericUserId: row.numeric_user_id,
    limitBytes: Number(row.limit_bytes),
    source: row.source,
    generation: row.generation,
    lastTaskId: row.last_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMountSourceGrant(
  row: Selectable<NyabaseDatabase['iam.mount_source_grants']>,
): MountSourceGrantRecord {
  return {
    id: row.id,
    scope: row.user_id ? 'user' : 'group',
    scopeId: row.user_id ?? row.group_id!,
    sourceKind: row.source_kind as 'local' | 'remote',
    sourceId: row.source_id,
    serverId: row.server_id,
    sourceIdentity: row.source_identity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
