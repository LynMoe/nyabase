import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';

export type StorageExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export interface StoragePoolDiscovery {
  serverId: string;
  incusName: string;
  driver: 'dir' | 'btrfs' | 'zfs' | 'lvm' | 'lvmcluster' | 'ceph' | 'cephfs';
  resizeFamily: 'quota_online' | 'block_backed';
  rootDiskCapable: boolean;
  shareable: boolean;
  blockFilesystem: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
  quotaEffective: boolean | null;
  source: string | null;
  /**
   * Discovery can resolve an already registered CephFS identity.  It is
   * optional because a freshly discovered pool may still need registration.
   */
  sharedBackendId?: string | null;
}

@Injectable()
export class StoragePoolsRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  /**
   * Internal inventory of every storage_pools row, including shareable CephFS
   * executors. Product surfaces must filter via StoragePoolsService.
   */
  list(
    serverId?: string,
    includeUnregistered = false,
    executor: StorageExecutor = this.database,
  ) {
    let query = executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .orderBy('incus_name');
    if (serverId) query = query.where('server_id', '=', serverId);
    if (!includeUnregistered) query = query.where('registered', '=', true);
    return query.execute();
  }

  listExecutorsByBackendIds(
    backendIds: readonly string[],
    executor: StorageExecutor = this.database,
  ) {
    if (backendIds.length === 0) {
      return Promise.resolve([] as Array<{
        id: string;
        shared_backend_id: string | null;
        server_id: string;
        server_name: string;
        server_status: string;
        incus_name: string;
        registered: boolean;
        total_bytes: string | number | null;
        used_bytes: string | number | null;
        last_observed_at: Date | string | null;
        revision: string | number;
      }>);
    }
    return executor
      .selectFrom('infra.storage_pools as pool')
      .innerJoin('infra.servers as server', 'server.id', 'pool.server_id')
      .select([
        'pool.id',
        'pool.shared_backend_id',
        'pool.server_id',
        'server.name as server_name',
        'server.status as server_status',
        'pool.incus_name',
        'pool.registered',
        'pool.total_bytes',
        'pool.used_bytes',
        'pool.last_observed_at',
        'pool.revision',
      ])
      .where('pool.shareable', '=', true)
      .where('pool.driver', '=', 'cephfs')
      .where('pool.shared_backend_id', 'in', [...backendIds])
      .orderBy('server.name')
      .orderBy('pool.incus_name')
      .execute();
  }

  findById(id: string, executor: StorageExecutor = this.database) {
    return executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  listByIds(ids: readonly string[], executor: StorageExecutor = this.database) {
    if (ids.length === 0) return Promise.resolve([]);
    return executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .where('id', 'in', [...ids])
      .execute();
  }

  /**
   * Registered, shareable CephFS pools: the executors through which a shared
   * backend is reachable. Optionally narrowed to some backends and one server.
   */
  listRegisteredSharedPools(
    filter: { backendIds?: readonly string[]; serverId?: string } = {},
    executor: StorageExecutor = this.database,
  ) {
    let query = executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .where('driver', '=', 'cephfs')
      .where('shareable', '=', true)
      .where('registered', '=', true)
      .where('shared_backend_id', 'is not', null);
    if (filter.backendIds !== undefined) {
      query = query.where('shared_backend_id', 'in', [...filter.backendIds]);
    }
    if (filter.serverId !== undefined) query = query.where('server_id', '=', filter.serverId);
    return query.execute();
  }

  findByIdForUpdate(id: string, executor: StorageExecutor) {
    return executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  lockServer(serverId: string, executor: Transaction<NyabaseDatabase>) {
    return executor
      .selectFrom('infra.servers')
      .select('id')
      .where('id', '=', serverId)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  async lockSharedBackends(
    backendIds: readonly (string | null)[],
    executor: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    const ids = [...new Set(backendIds.filter((id): id is string => id !== null))].sort();
    if (ids.length === 0) return;
    const rows = await executor
      .selectFrom('infra.shared_backends')
      .select('id')
      .where('id', 'in', ids)
      .orderBy('id')
      .forUpdate()
      .execute();
    if (rows.length !== ids.length) {
      throw new NotFoundException('Shared backend not found');
    }
  }

  async lockCapacityScope(
    poolId: string,
    serverId: string | null,
    sharedBackendIds: readonly (string | null)[],
    executor: Transaction<NyabaseDatabase>,
  ) {
    // Capacity mutations always acquire server, shared backend, then pool locks.
    const pool = await executor
      .selectFrom('infra.storage_pools')
      .select(['server_id', 'shared_backend_id'])
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();
    await this.lockServer(serverId ?? pool.server_id, executor);
    await this.lockSharedBackends(
      [pool.shared_backend_id, ...sharedBackendIds],
      executor,
    );
    return executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .where('id', '=', poolId)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  findByServerAndName(
    serverId: string,
    incusName: string,
    executor: StorageExecutor = this.database,
  ) {
    return executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('incus_name', '=', incusName)
      .executeTakeFirst();
  }

  async upsertDiscovery(
    id: string,
    discovery: StoragePoolDiscovery,
    executor: StorageExecutor = this.database,
  ) {
    const existing = await this.findByServerAndName(
      discovery.serverId,
      discovery.incusName,
      executor,
    );
    if (existing) {
      return executor
        .updateTable('infra.storage_pools')
        .set({
          driver: discovery.driver,
          resize_family: discovery.resizeFamily,
          root_disk_capable: discovery.rootDiskCapable,
          shareable: discovery.shareable,
          block_filesystem: discovery.blockFilesystem,
          ...(existing.shared_backend_id === null && discovery.sharedBackendId !== undefined
            ? { shared_backend_id: discovery.sharedBackendId }
            : {}),
          total_bytes: discovery.totalBytes,
          used_bytes: discovery.usedBytes,
          quota_effective: discovery.quotaEffective,
          source: discovery.source,
          last_observed_at: new Date(),
          revision: Number(existing.revision) + 1,
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return executor
      .insertInto('infra.storage_pools')
      .values({
        id,
        server_id: discovery.serverId,
        incus_name: discovery.incusName,
        driver: discovery.driver,
        resize_family: discovery.resizeFamily,
        root_disk_capable: discovery.rootDiskCapable,
        shareable: discovery.shareable,
        block_filesystem: discovery.blockFilesystem,
        shared_backend_id: discovery.sharedBackendId ?? null,
        total_bytes: discovery.totalBytes,
        used_bytes: discovery.usedBytes,
        quota_effective: discovery.quotaEffective,
        source: discovery.source,
        display_name: null,
        registered: false,
        last_observed_at: new Date(),
        revision: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  patch(
    id: string,
    expectedRevision: number,
    values: {
      registered?: boolean;
      display_name?: string | null;
      shared_backend_id?: string | null;
      shareable?: boolean;
    },
    executor: StorageExecutor = this.database,
  ) {
    return executor
      .updateTable('infra.storage_pools')
      .set({
        ...values,
        revision: expectedRevision + 1,
      })
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
  }

  /** Record the used/total bytes Incus reports for a pool. */
  async recordObservedSpace(
    id: string,
    space: { usedBytes: string | null; totalBytes: string | null },
    executor: StorageExecutor = this.database,
  ): Promise<void> {
    await executor
      .updateTable('infra.storage_pools')
      .set({
        used_bytes: space.usedBytes,
        total_bytes: space.totalBytes,
        last_observed_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async serverExists(id: string, executor: StorageExecutor = this.database): Promise<boolean> {
    const row = await executor
      .selectFrom('infra.servers')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    return Boolean(row);
  }

  async listOnlineServerIds(executor: StorageExecutor = this.database): Promise<string[]> {
    const rows = await executor
      .selectFrom('infra.servers')
      .select('id')
      .where('status', '=', 'online')
      .execute();
    return rows.map((row) => row.id);
  }

  async sharedBackendExists(id: string, executor: StorageExecutor = this.database): Promise<boolean> {
    const row = await executor
      .selectFrom('infra.shared_backends')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    return Boolean(row);
  }

  findSharedBackendByIdentity(identityKey: string, executor: StorageExecutor) {
    return executor
      .selectFrom('infra.shared_backends')
      .select(['id', 'identity_key', 'ceph_fsid'])
      .where('identity_key', '=', identityKey)
      .executeTakeFirst();
  }

  findSharedBackendById(id: string, executor: StorageExecutor) {
    return executor
      .selectFrom('infra.shared_backends')
      .select(['identity_key', 'ceph_fsid'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  findSharedBackendByFsid(fsid: string, executor: StorageExecutor) {
    return executor
      .selectFrom('infra.shared_backends')
      .select(['id', 'identity_key', 'ceph_fsid'])
      .where(sql<boolean>`lower(ceph_fsid) = ${fsid}`)
      .executeTakeFirst();
  }

  /** The shareable pool already mapping this backend on the server, other than `excludePoolId`. */
  findShareableMapping(
    sharedBackendId: string,
    serverId: string,
    excludePoolId: string | undefined,
    executor: StorageExecutor,
  ) {
    let query = executor
      .selectFrom('infra.storage_pools')
      .select('id')
      .where('shared_backend_id', '=', sharedBackendId)
      .where('server_id', '=', serverId)
      .where('shareable', '=', true);
    if (excludePoolId) query = query.where('id', '!=', excludePoolId);
    return query.orderBy('id').forUpdate().executeTakeFirst();
  }

  /** A shared backend's capacity is the largest figure any of its executors reports. */
  async refreshSharedBackendCapacity(
    sharedBackendId: string,
    executor: StorageExecutor = this.database,
  ): Promise<void> {
    const capacity = await executor
      .selectFrom('infra.storage_pools')
      .select([
        executor.fn.max('total_bytes').as('total_bytes'),
        executor.fn.max('used_bytes').as('used_bytes'),
      ])
      .where('shared_backend_id', '=', sharedBackendId)
      .where('shareable', '=', true)
      .executeTakeFirstOrThrow();
    await executor
      .updateTable('infra.shared_backends')
      .set({
        total_bytes: capacity.total_bytes,
        used_bytes: capacity.used_bytes,
      })
      .where('id', '=', sharedBackendId)
      .execute();
  }

  async hasDependencies(id: string, executor: StorageExecutor = this.database): Promise<boolean> {
    const [containers, volumes, systemPool, grants] = await Promise.all([
      executor
        .selectFrom('control.containers')
        .select('id')
        .where('root_pool_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
      executor
        .selectFrom('control.volumes')
        .select('id')
        .where('pool_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
      executor
        .selectFrom('infra.servers')
        .select('id')
        .where('system_pool_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
      executor
        .selectFrom('iam.storage_pool_grants')
        .select('id')
        .where('pool_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
    ]);
    return Boolean(containers || volumes || systemPool || grants);
  }
}
