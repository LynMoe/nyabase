import type { Kysely, Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';

export type EligibleDestroyExecutor = {
  server_id: string;
  server_name: string;
  pool_id: string;
  pool_name: string;
};

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export async function listEligibleDestroyExecutors(
  executor: Executor,
  sharedBackendId: string,
  options: { excludeServerId?: string } = {},
): Promise<EligibleDestroyExecutor[]> {
  let query = executor
    .selectFrom('infra.servers as s')
    .innerJoin('infra.storage_pools as p', 'p.server_id', 's.id')
    .select([
      's.id as server_id',
      's.name as server_name',
      'p.id as pool_id',
      'p.incus_name as pool_name',
    ])
    .where('s.status', '=', 'online')
    .where('p.registered', '=', true)
    .where('p.shareable', '=', true)
    .where('p.driver', '=', 'cephfs')
    .where('p.shared_backend_id', '=', sharedBackendId)
    .orderBy('s.id', 'asc')
    .orderBy('p.id', 'asc');
  if (options.excludeServerId) {
    query = query.where('s.id', '!=', options.excludeServerId);
  }
  const rows = await query.execute();
  const firstPoolByServer = new Map<string, EligibleDestroyExecutor>();
  for (const row of rows) {
    if (!firstPoolByServer.has(row.server_id)) {
      firstPoolByServer.set(row.server_id, row);
    }
  }
  return [...firstPoolByServer.values()];
}
