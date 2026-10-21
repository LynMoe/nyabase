import { ConflictException } from '@nestjs/common';
import { FailureCode } from '@nyabase/common';
import { sql, type Transaction } from 'kysely';
import { numberValue } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { ContainerControlRepository } from './container-control.repository.js';

/**
 * Admission check for growing root-disk commitments: the owner's server
 * storage grant, then the pool's overcommitted capacity. Locks the server and
 * pool rows so concurrent admissions serialise.
 */
export async function assertRootCapacity(
  repository: ContainerControlRepository,
  transaction: Transaction<NyabaseDatabase>,
  ownerId: string,
  serverId: string,
  poolId: string,
  delta: number,
  grantLimit: number | null,
): Promise<void> {
  if (delta <= 0) return;
  await transaction.selectFrom('infra.servers')
    .select('id')
    .where('id', '=', serverId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  // Custom volumes belong to the volumes module; only their committed size is read here.
  const sumVolumes = async (filter: { ownerId?: string; serverId?: string; poolId?: string }) => {
    let query = transaction.selectFrom('control.volumes')
      .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('bytes'))
      .where('lifecycle_phase', 'not in', ['failed', 'deleting']);
    if (filter.ownerId !== undefined) query = query.where('owner_id', '=', filter.ownerId);
    if (filter.serverId !== undefined) {
      query = query.where('server_id', '=', filter.serverId).where('shared_backend_id', 'is', null);
    }
    if (filter.poolId !== undefined) query = query.where('pool_id', '=', filter.poolId);
    return numberValue((await query.executeTakeFirstOrThrow()).bytes);
  };
  const used = await repository.sumLiveRootBytes({ ownerId, serverId }, transaction)
    + await sumVolumes({ ownerId, serverId });
  if (grantLimit !== null && grantLimit > 0 && used + delta > grantLimit) {
    throw new ConflictException({
      code: FailureCode.StorageGrantExceeded,
      message: 'Server storage grant exceeded',
      details: {
        requestedBytes: delta,
        availableBytes: Math.max(0, grantLimit - used),
        grantLimitBytes: grantLimit,
      },
    });
  }
  const pool = await transaction.selectFrom('infra.storage_pools')
    .select(['total_bytes'])
    .where('id', '=', poolId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (pool.total_bytes === null) return;
  const committed = await repository.sumLiveRootBytes({ poolId }, transaction)
    + await sumVolumes({ poolId });
  const server = await transaction.selectFrom('infra.servers')
    .select('storage_overcommit_ratio')
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
  const capacity = numberValue(pool.total_bytes) * numberValue(server.storage_overcommit_ratio);
  if (committed + delta > capacity) {
    throw new ConflictException({
      code: FailureCode.StoragePoolExhausted,
      message: 'Storage pool capacity exceeded',
      details: {
        poolId,
        requestedBytes: delta,
        availableBytes: Math.max(0, capacity - committed),
        overcommitRatio: numberValue(server.storage_overcommit_ratio),
      },
    });
  }
}
