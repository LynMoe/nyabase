import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';

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

  findById(id: string, executor: StorageExecutor = this.database) {
    return executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
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
    await executor
      .selectFrom('infra.shared_backends')
      .select('id')
      .where('id', 'in', ids)
      .orderBy('id')
      .forUpdate()
      .execute();
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
