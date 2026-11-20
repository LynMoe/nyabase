import { NotFoundException } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import { FailureCode, type GrantDataDisk } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { isLocalPoolRow } from '../storage-pools/storage-pool-capability.js';

/**
 * Data-disk lists (AGENTS.md, 授权模型): a bundle's in
 * `iam.grant_bundle_disks`, a grant's own (while it overrides `data_disks`)
 * in `iam.storage_pool_grants`. Every write replaces the whole list; the
 * effective view picks one of the two per grant.
 */

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;
type Tx = Transaction<NyabaseDatabase>;

function capValue(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function byPool(left: GrantDataDisk, right: GrantDataDisk): number {
  return left.poolId < right.poolId ? -1 : left.poolId > right.poolId ? 1 : 0;
}

/** Each bundle's data disks, by bundle id (bundles without any map to nothing). */
export async function loadBundleDataDisks(
  executor: Executor,
  bundleIds: readonly string[],
): Promise<Map<string, GrantDataDisk[]>> {
  const result = new Map<string, GrantDataDisk[]>();
  if (bundleIds.length === 0) return result;
  const rows = await executor.selectFrom('iam.grant_bundle_disks')
    .select(['bundle_id', 'pool_id', 'cap_bytes'])
    .where('bundle_id', 'in', [...new Set(bundleIds)])
    .orderBy('bundle_id')
    .orderBy('pool_id')
    .execute();
  for (const row of rows) {
    const list = result.get(row.bundle_id) ?? [];
    list.push({ poolId: row.pool_id, capBytes: capValue(row.cap_bytes) });
    result.set(row.bundle_id, list);
  }
  return result;
}

/** Each grant's own data disks (rows exist only while it overrides `data_disks`), by server grant id. */
export async function loadGrantDataDisks(
  executor: Executor,
  serverGrantIds: readonly string[],
): Promise<Map<string, GrantDataDisk[]>> {
  const result = new Map<string, GrantDataDisk[]>();
  if (serverGrantIds.length === 0) return result;
  const rows = await executor.selectFrom('iam.storage_pool_grants')
    .select(['server_grant_id', 'pool_id', 'cap_bytes'])
    .where('server_grant_id', 'in', [...new Set(serverGrantIds)])
    .orderBy('server_grant_id')
    .orderBy('pool_id')
    .execute();
  for (const row of rows) {
    const list = result.get(row.server_grant_id) ?? [];
    list.push({ poolId: row.pool_id, capBytes: capValue(row.cap_bytes) });
    result.set(row.server_grant_id, list);
  }
  return result;
}

/**
 * Every listed disk must be a local pool of the server; the pools are held
 * FOR SHARE so a concurrent unregister or remap waits for this write.
 */
export async function assertDataDisksOnServer(
  transaction: Tx,
  serverId: string,
  disks: readonly GrantDataDisk[],
): Promise<void> {
  if (disks.length === 0) return;
  const poolIds = disks.map((disk) => disk.poolId);
  const pools = await transaction.selectFrom('infra.storage_pools')
    .select(['id', 'server_id', 'shareable', 'driver', 'shared_backend_id'])
    .where('id', 'in', poolIds)
    .forShare()
    .execute();
  const valid = new Set(pools
    .filter((pool) => pool.server_id === serverId && isLocalPoolRow(pool))
    .map((pool) => pool.id));
  const missing = poolIds.filter((poolId) => !valid.has(poolId));
  if (missing.length > 0) {
    throw new NotFoundException({
      code: FailureCode.InvalidInput,
      message: 'Storage pool not found on the server',
      details: { serverId, poolIds: missing },
    });
  }
}

export async function writeBundleDataDisks(
  transaction: Tx,
  bundle: { id: string; serverId: string },
  disks: readonly GrantDataDisk[],
): Promise<void> {
  await transaction.deleteFrom('iam.grant_bundle_disks').where('bundle_id', '=', bundle.id).execute();
  if (disks.length === 0) return;
  await transaction.insertInto('iam.grant_bundle_disks')
    .values([...disks].sort(byPool).map((disk) => ({
      bundle_id: bundle.id,
      server_id: bundle.serverId,
      pool_id: disk.poolId,
      cap_bytes: disk.capBytes,
    })))
    .execute();
}

/** A grant's own list: `null` (it follows the bundle's) deletes it. */
export async function writeGrantDataDisks(
  transaction: Tx,
  grant: { id: string; userId: string; serverId: string },
  disks: readonly GrantDataDisk[] | null,
): Promise<void> {
  await transaction.deleteFrom('iam.storage_pool_grants').where('server_grant_id', '=', grant.id).execute();
  if (disks === null || disks.length === 0) return;
  await transaction.insertInto('iam.storage_pool_grants')
    .values([...disks].sort(byPool).map((disk) => ({
      id: randomUUID(),
      server_grant_id: grant.id,
      user_id: grant.userId,
      server_id: grant.serverId,
      pool_id: disk.poolId,
      cap_bytes: disk.capBytes,
    })))
    .execute();
}
