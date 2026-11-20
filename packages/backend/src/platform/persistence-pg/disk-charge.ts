import { sql, type Kysely, type Transaction } from 'kysely';
import { numberValue } from '../domain-utils.js';
import { committedRootBytesSql } from './committed-bytes.js';
import type { NyabaseDatabase } from './database.types.js';

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

/**
 * What a server grant's disk total is charged with (AGENTS.md, 授权模型): the
 * owner's live system disks on the server by committed size (they are fixed,
 * the user sized them), and the data on the owner's volumes on the data disks
 * the grant covers (those volumes are sized by the platform around their
 * data). Read the same way by admission, the access DTOs and the bundle
 * preview; the quota balancer reads the same sums for every user at once.
 */
export interface ServerDiskCharge {
  rootCommittedBytes: number;
  dataUsedBytes: number;
  /** Data by covered pool holding a live volume of the owner (unknown usage counts 0). */
  dataByPool: Map<string, number>;
}

export async function loadServerDiskCharge(
  executor: Executor,
  ownerId: string,
  serverId: string,
): Promise<ServerDiskCharge> {
  const [roots, volumes] = await Promise.all([
    executor.selectFrom('control.containers')
      .select(sql<string>`coalesce(sum(${committedRootBytesSql()}), 0)`.as('bytes'))
      .where('owner_id', '=', ownerId)
      .where('server_id', '=', serverId)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .executeTakeFirstOrThrow(),
    executor.selectFrom('control.volumes as volume')
      .innerJoin('iam.effective_pool_access as access', (join) => join
        .onRef('access.pool_id', '=', 'volume.pool_id')
        .onRef('access.user_id', '=', 'volume.owner_id'))
      .select(['volume.pool_id', sql<string>`coalesce(sum(coalesce(volume.used_bytes, 0)), 0)`.as('bytes')])
      .where('volume.owner_id', '=', ownerId)
      .where('access.server_id', '=', serverId)
      .where('volume.shared_backend_id', 'is', null)
      .where('volume.lifecycle_phase', 'not in', ['failed', 'deleting'])
      .groupBy('volume.pool_id')
      .execute(),
  ]);
  const dataByPool = new Map(volumes.map((row) => [row.pool_id!, numberValue(row.bytes)]));
  return {
    rootCommittedBytes: numberValue(roots.bytes),
    dataUsedBytes: [...dataByPool.values()].reduce((sum, bytes) => sum + bytes, 0),
    dataByPool,
  };
}
