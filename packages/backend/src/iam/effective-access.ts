import type { Kysely, Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

/**
 * Readers for `iam.effective_server_access`, `iam.effective_pool_access` and
 * `iam.effective_shared_backend_access`. Those views merge the *current* direct
 * and group-inherited grants per (user, resource) for active users; an absent
 * row means no coverage. Every authorization decision reads them through one of
 * the resolvers below, one per resource kind. Expired grants are not in the
 * views and are never merged by hand.
 */
export type AccessExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export interface ServerAccess {
  /** null = unlimited */
  cpuCores: number | null;
  /** null = unlimited */
  memBytes: number | null;
  /** null = unlimited */
  diskBytes: number | null;
  gpuPciAddresses: string[];
  /** null = never expires */
  expiresAt: Date | null;
}

export interface PoolAccess {
  expiresAt: Date | null;
}

export interface SharedBackendAccess {
  /** null = unlimited */
  limitBytes: number | null;
  expiresAt: Date | null;
}

function bytes(value: string | number | null): number | null {
  if (value === null) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('Authorization grant exceeds the safe integer range');
  }
  return result;
}

function serverAccess(row: {
  cpu_cores: number | null;
  mem_bytes: string | null;
  disk_bytes: string | null;
  gpu_pci_addresses: string[];
  expires_at: Date | null;
}): ServerAccess {
  return {
    cpuCores: row.cpu_cores,
    memBytes: bytes(row.mem_bytes),
    diskBytes: bytes(row.disk_bytes),
    gpuPciAddresses: [...row.gpu_pci_addresses],
    expiresAt: row.expires_at,
  };
}

export async function resolveServerAccess(
  executor: AccessExecutor,
  userId: string,
  serverId: string,
): Promise<ServerAccess | null> {
  const row = await executor.selectFrom('iam.effective_server_access')
    .select(['cpu_cores', 'mem_bytes', 'disk_bytes', 'gpu_pci_addresses', 'expires_at'])
    .where('user_id', '=', userId)
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  return row ? serverAccess(row) : null;
}

export async function resolvePoolAccess(
  executor: AccessExecutor,
  userId: string,
  poolId: string,
): Promise<PoolAccess | null> {
  const row = await executor.selectFrom('iam.effective_pool_access')
    .select('expires_at')
    .where('user_id', '=', userId)
    .where('pool_id', '=', poolId)
    .executeTakeFirst();
  return row ? { expiresAt: row.expires_at } : null;
}

export async function resolveSharedBackendAccess(
  executor: AccessExecutor,
  userId: string,
  sharedBackendId: string,
): Promise<SharedBackendAccess | null> {
  const row = await executor.selectFrom('iam.effective_shared_backend_access')
    .select(['limit_bytes', 'expires_at'])
    .where('user_id', '=', userId)
    .where('shared_backend_id', '=', sharedBackendId)
    .executeTakeFirst();
  return row ? { limitBytes: bytes(row.limit_bytes), expiresAt: row.expires_at } : null;
}

/** Servers on which the user currently has coverage. */
export async function listServerAccess(
  executor: AccessExecutor,
  userId: string,
): Promise<Array<ServerAccess & { serverId: string }>> {
  const rows = await executor.selectFrom('iam.effective_server_access')
    .select([
      'server_id', 'cpu_cores', 'mem_bytes', 'disk_bytes', 'gpu_pci_addresses', 'expires_at',
    ])
    .where('user_id', '=', userId)
    .orderBy('server_id')
    .execute();
  return rows.map((row) => ({ serverId: row.server_id, ...serverAccess(row) }));
}

export async function listPoolAccess(
  executor: AccessExecutor,
  userId: string,
): Promise<Array<PoolAccess & { poolId: string }>> {
  const rows = await executor.selectFrom('iam.effective_pool_access')
    .select(['pool_id', 'expires_at'])
    .where('user_id', '=', userId)
    .orderBy('pool_id')
    .execute();
  return rows.map((row) => ({ poolId: row.pool_id, expiresAt: row.expires_at }));
}

export async function listSharedBackendAccess(
  executor: AccessExecutor,
  userId: string,
): Promise<Array<SharedBackendAccess & { sharedBackendId: string }>> {
  const rows = await executor.selectFrom('iam.effective_shared_backend_access')
    .select(['shared_backend_id', 'limit_bytes', 'expires_at'])
    .where('user_id', '=', userId)
    .orderBy('shared_backend_id')
    .execute();
  return rows.map((row) => ({
    sharedBackendId: row.shared_backend_id,
    limitBytes: bytes(row.limit_bytes),
    expiresAt: row.expires_at,
  }));
}

/**
 * `${userId}\0${serverId}` keys of every pair with current server coverage.
 * The SSH proxy snapshot admits only these pairs.
 */
export async function loadServerAccessKeys(executor: AccessExecutor): Promise<Set<string>> {
  const rows = await executor.selectFrom('iam.effective_server_access')
    .select(['user_id', 'server_id'])
    .execute();
  return new Set(rows.map((row) => `${row.user_id}\0${row.server_id}`));
}
