import { sql, type Kysely, type Transaction } from 'kysely';
import { StoragePoolDriver } from '@nyabase/common';
import { numberValue } from '../platform/domain-utils.js';
import {
  committedRootBytesSql,
  committedVolumeBytesSql,
} from '../platform/persistence-pg/committed-bytes.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { quotaBelowUsage } from './volume-rules.js';
import {
  backendGrantKey,
  type PlanDisk,
  type PlanGrant,
  type PlanSnapshot,
  type PlanVolume,
} from './volume-provisioning.js';

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

/** Where a local volume's usage is read: its pool on its server. */
export interface UsageSource {
  volumeId: string;
  serverId: string;
  incusName: string;
  pool: { incus_name: string; driver: string; resize_family: string };
}

export interface LoadedSnapshot {
  snapshot: PlanSnapshot;
  /** Local volumes by id, for reading usage. */
  usageSources: Map<string, UsageSource>;
}

/** Disks with their capacity (sums only when `capacity`), and each owner's system-disk bytes per pool. */
async function loadDisks(executor: Executor, capacity: boolean) {
  const [pools, backends, poolCommits, rootCommits, backendCommits] = await Promise.all([
    executor.selectFrom('infra.storage_pools as pool')
      .innerJoin('infra.servers as server', 'server.id', 'pool.server_id')
      .select([
        'pool.id', 'pool.server_id', 'pool.incus_name', 'pool.mount_path', 'pool.maintenance', 'pool.driver',
        'pool.resize_family', 'pool.quota_effective', 'pool.total_bytes', 'server.storage_overcommit_ratio',
      ])
      .where('pool.registered', '=', true)
      .where('pool.shareable', '=', false)
      .where('pool.shared_backend_id', 'is', null)
      .where('pool.driver', '<>', StoragePoolDriver.CephFs)
      .execute(),
    executor.selectFrom('infra.shared_backends')
      .select(['id', 'mount_path', 'maintenance', 'total_bytes', 'overcommit_ratio'])
      .execute(),
    !capacity ? [] : executor.selectFrom('control.volumes')
      .select(['pool_id', sql<string>`sum(${committedVolumeBytesSql()})`.as('bytes')])
      .where('pool_id', 'is not', null)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .groupBy('pool_id')
      .execute(),
    !capacity ? [] : executor.selectFrom('control.containers')
      .select(['root_pool_id', 'owner_id', sql<string>`sum(${committedRootBytesSql()})`.as('bytes')])
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .groupBy(['root_pool_id', 'owner_id'])
      .execute(),
    !capacity ? [] : executor.selectFrom('control.volumes')
      .select(['shared_backend_id', sql<string>`sum(${committedVolumeBytesSql()})`.as('bytes')])
      .where('shared_backend_id', 'is not', null)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .groupBy('shared_backend_id')
      .execute(),
  ]);
  const rootByPool = new Map<string, number>();
  const rootByOwnerPool = new Map<string, number>();
  for (const row of rootCommits) {
    if (!row.root_pool_id) continue;
    const bytes = numberValue(row.bytes);
    rootByPool.set(row.root_pool_id, (rootByPool.get(row.root_pool_id) ?? 0) + bytes);
    rootByOwnerPool.set(`${row.owner_id}\0${row.root_pool_id}`, bytes);
  }
  const volumeByPool = new Map(poolCommits.map((row) => [row.pool_id!, numberValue(row.bytes)]));
  const volumeByBackend = new Map(backendCommits.map((row) => [row.shared_backend_id!, numberValue(row.bytes)]));
  const disks: PlanDisk[] = [
    ...pools.map((pool): PlanDisk => ({
      kind: 'pool',
      id: pool.id,
      serverId: pool.server_id,
      mountPath: pool.mount_path,
      maintenance: pool.maintenance,
      belowUsage: quotaBelowUsage(pool.driver, pool.quota_effective),
      totalBytes: pool.total_bytes === null ? null : numberValue(pool.total_bytes),
      overcommitRatio: numberValue(pool.storage_overcommit_ratio),
      committedBytes: (volumeByPool.get(pool.id) ?? 0) + (rootByPool.get(pool.id) ?? 0),
    })),
    ...backends.map((backend): PlanDisk => ({
      kind: 'backend',
      id: backend.id,
      serverId: null,
      mountPath: backend.mount_path,
      maintenance: backend.maintenance,
      belowUsage: true,
      totalBytes: backend.total_bytes === null ? null : numberValue(backend.total_bytes),
      overcommitRatio: numberValue(backend.overcommit_ratio),
      committedBytes: volumeByBackend.get(backend.id) ?? 0,
    })),
  ];
  return { disks, pools: new Map(pools.map((pool) => [pool.id, pool])), rootByOwnerPool };
}

/**
 * Current coverage: one group per server grant (its data disks share its disk
 * total less the owner's system disks on the server), one per shared backend
 * grant.
 */
async function loadGrants(executor: Executor, owner: string | undefined): Promise<PlanGrant[]> {
  const [poolAccess, serverAccess, roots, backendAccess] = await Promise.all([
    executor.selectFrom('iam.effective_pool_access')
      .select(['user_id', 'pool_id', 'cap_bytes', 'server_id', 'server_grant_id'])
      .$if(owner !== undefined, (query) => query.where('user_id', '=', owner!))
      .orderBy('server_grant_id')
      .orderBy('pool_id')
      .execute(),
    executor.selectFrom('iam.effective_server_access')
      .select(['user_id', 'server_id', 'disk_bytes'])
      .$if(owner !== undefined, (query) => query.where('user_id', '=', owner!))
      .execute(),
    executor.selectFrom('control.containers')
      .select(['owner_id', 'server_id', sql<string>`sum(${committedRootBytesSql()})`.as('bytes')])
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .$if(owner !== undefined, (query) => query.where('owner_id', '=', owner!))
      .groupBy(['owner_id', 'server_id'])
      .execute(),
    executor.selectFrom('iam.effective_shared_backend_access')
      .select(['user_id', 'shared_backend_id', 'limit_bytes'])
      .$if(owner !== undefined, (query) => query.where('user_id', '=', owner!))
      .execute(),
  ]);
  const totals = new Map(serverAccess.map((row) => [`${row.user_id}\0${row.server_id}`, numberValue(row.disk_bytes)]));
  const rootBytes = new Map(roots.map((row) => [`${row.owner_id}\0${row.server_id}`, numberValue(row.bytes)]));
  const grants = new Map<string, PlanGrant & { ceilings: Map<string, number | null> }>();
  for (const row of poolAccess) {
    const scope = `${row.user_id}\0${row.server_id}`;
    const total = totals.get(scope);
    if (total === undefined) continue;
    let grant = grants.get(row.server_grant_id);
    if (!grant) {
      const root = rootBytes.get(scope) ?? 0;
      grant = {
        key: row.server_grant_id,
        userId: row.user_id,
        limitBytes: Math.max(0, total - root),
        kind: 'pool',
        diskIds: [],
        ceilings: new Map(),
        quota: { serverId: row.server_id, rootBytes: root },
      };
      grants.set(row.server_grant_id, grant);
    }
    grant.diskIds.push(row.pool_id);
    grant.ceilings.set(row.pool_id, row.cap_bytes === null ? null : numberValue(row.cap_bytes));
  }
  const result: PlanGrant[] = [...grants.values()];
  for (const row of backendAccess) {
    result.push({
      key: backendGrantKey(row.user_id, row.shared_backend_id),
      userId: row.user_id,
      limitBytes: numberValue(row.limit_bytes),
      kind: 'backend',
      diskIds: [row.shared_backend_id],
    });
  }
  return result;
}

/** `${backendId}\0${serverId}` → the backend's executor pool on the server, where it has exactly one. */
async function loadBackendPools(executor: Executor): Promise<Map<string, string>> {
  const executorPools = await executor.selectFrom('infra.storage_pools')
    .select(['id', 'server_id', 'shared_backend_id'])
    .where('registered', '=', true)
    .where('shareable', '=', true)
    .where('shared_backend_id', 'is not', null)
    .execute();
  const byKey = new Map<string, string[]>();
  for (const pool of executorPools) {
    const key = `${pool.shared_backend_id}\0${pool.server_id}`;
    byKey.set(key, [...(byKey.get(key) ?? []), pool.id]);
  }
  return new Map([...byKey.entries()].filter(([, ids]) => ids.length === 1).map(([key, ids]) => [key, ids[0]!]));
}

/**
 * Everything `planProvisioning` reads, in a few queries over the whole
 * installation. Read-only over pools, backends, grants, volumes, containers
 * and attachments. `usage` holds the readings of this pass (unknown when
 * absent).
 */
export async function loadPlanSnapshot(
  executor: Executor,
  options: {
    usage?: ReadonlyMap<string, number | null>;
    /**
     * Only this owner's grants, volumes and containers, and no capacity sums:
     * enough to plan the owner's mounts inside a narrow transaction.
     */
    ownerId?: string;
  } = {},
): Promise<LoadedSnapshot> {
  const usage = options.usage ?? new Map<string, number | null>();
  const owner = options.ownerId;
  const { disks, pools, rootByOwnerPool } = await loadDisks(executor, owner === undefined);
  const [grants, volumes, containers, attachments, backendPools] = await Promise.all([
    loadGrants(executor, owner),
    executor.selectFrom('control.volumes')
      .select([
        'id', 'owner_id', 'pool_id', 'server_id', 'shared_backend_id', 'incus_name', 'lifecycle_phase',
        'revision', 'size_bytes', 'shrink_reserved_bytes',
      ])
      .where('lifecycle_phase', '<>', 'deleting')
      .$if(owner !== undefined, (query) => query.where('owner_id', '=', owner!))
      .orderBy('id')
      .execute(),
    executor.selectFrom('control.containers')
      .select(['id', 'owner_id', 'server_id', 'name'])
      .where('lifecycle_phase', '=', 'active')
      .$if(owner !== undefined, (query) => query.where('owner_id', '=', owner!))
      .orderBy('id')
      .execute(),
    executor.selectFrom('control.volume_attachments as attachment')
      .innerJoin('control.containers as container', 'container.id', 'attachment.container_id')
      .select(['attachment.container_id', 'attachment.volume_id', 'attachment.container_path'])
      .$if(owner !== undefined, (query) => query.where('container.owner_id', '=', owner!))
      .execute(),
    loadBackendPools(executor),
  ]);

  const usageSources = new Map<string, UsageSource>();
  const planVolumes: PlanVolume[] = volumes.map((row) => {
    const local = row.shared_backend_id === null;
    const pool = row.pool_id ? pools.get(row.pool_id) : undefined;
    if (local && pool && row.server_id) {
      usageSources.set(row.id, {
        volumeId: row.id,
        serverId: row.server_id,
        incusName: row.incus_name,
        pool: { incus_name: pool.incus_name, driver: pool.driver, resize_family: pool.resize_family },
      });
    }
    return {
      id: row.id,
      ownerId: row.owner_id,
      kind: local ? 'pool' : 'backend',
      diskId: (local ? row.pool_id : row.shared_backend_id)!,
      serverId: row.server_id,
      phase: row.lifecycle_phase as PlanVolume['phase'],
      revision: row.revision,
      sizeBytes: numberValue(row.size_bytes),
      reservedBytes: row.shrink_reserved_bytes === null ? null : numberValue(row.shrink_reserved_bytes),
      usedBytes: usage.get(row.id) ?? null,
      ownerOtherBytes: local && row.pool_id ? rootByOwnerPool.get(`${row.owner_id}\0${row.pool_id}`) ?? 0 : 0,
    };
  });

  return {
    snapshot: {
      disks,
      grants,
      volumes: planVolumes,
      containers: containers.map((row) => ({ id: row.id, ownerId: row.owner_id, serverId: row.server_id, name: row.name })),
      attachments: attachments.map((row) => ({
        containerId: row.container_id,
        volumeId: row.volume_id,
        containerPath: row.container_path,
      })),
      backendPools,
    },
    usageSources,
  };
}
