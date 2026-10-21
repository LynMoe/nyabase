import { sql, type Kysely, type Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

/**
 * Readers for `iam.effective_server_access`, `iam.effective_pool_access` and
 * `iam.effective_shared_backend_access`. Those views merge direct and
 * group-inherited grants per (user, resource); every authorization decision
 * reads them through one of the resolvers below, one per resource kind.
 *
 * A resolver returns the *current* coverage only: the merged row exists and
 * `expires_at IS NULL OR expires_at > now()`. A user whose coverage is absent
 * or expired gets `null`. Expired rows stay visible in the views (the lapse
 * processor needs their past `expires_at`); only the processor and the
 * effective-access page read them.
 */
export type AccessExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export interface ServerAccess {
  /** null = unlimited */
  cpuMillis: number | null;
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

const notExpired = sql<boolean>`(expires_at IS NULL OR expires_at > now())`;

function serverAccess(row: {
  cpu_millis: number | null;
  mem_bytes: string | null;
  disk_bytes: string | null;
  gpu_pci_addresses: string[];
  expires_at: Date | null;
}): ServerAccess {
  return {
    cpuMillis: row.cpu_millis,
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
    .select(['cpu_millis', 'mem_bytes', 'disk_bytes', 'gpu_pci_addresses', 'expires_at'])
    .where('user_id', '=', userId)
    .where('server_id', '=', serverId)
    .where(notExpired)
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
    .where(notExpired)
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
    .where(notExpired)
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
      'server_id', 'cpu_millis', 'mem_bytes', 'disk_bytes', 'gpu_pci_addresses', 'expires_at',
    ])
    .where('user_id', '=', userId)
    .where(notExpired)
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
    .where(notExpired)
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
    .where(notExpired)
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
    .where(notExpired)
    .execute();
  return new Set(rows.map((row) => `${row.user_id}\0${row.server_id}`));
}
