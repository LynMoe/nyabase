import type { Kysely, Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

/**
 * Readers for `iam.effective_server_access`, `iam.effective_pool_access` and
 * `iam.effective_shared_backend_access`. Those views hold the *current* grants
 * of active users, with a server grant's overrides applied over its bundle; an
 * absent row means no coverage. Every authorization decision reads them through
 * one of the resolvers below, one per resource kind. Expired grants are not in
 * the views and are never resolved by hand.
 */
export type AccessExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export interface ServerAccess {
  /** null = unlimited */
  cpuCores: number | null;
  /** null = unlimited */
  memBytes: number | null;
  /** System disks (committed size) and data disks (their data) together; never unlimited. */
  diskBytes: number;
  /** Ceiling of the system disks alone; null = only `diskBytes`. */
  rootDiskBytes: number | null;
  /** null = every observed card */
  gpuCount: number | null;
  /** The cards picked for the user from the server's observed GPUs. */
  gpuPciAddresses: string[];
  /** null = never expires */
  expiresAt: Date | null;
}

/**
 * Coverage of a pool as a data disk of a server grant (the bundle's list or
 * the grant's own); it expires with the grant. The disk shares the grant's
 * `diskBytes` with the user's other disks on the server.
 */
export interface PoolAccess {
  /** The disk's own ceiling; null = only the grant's total. */
  capBytes: number | null;
  expiresAt: Date | null;
  serverId: string;
  serverGrantId: string;
}

export interface SharedBackendAccess {
  limitBytes: number;
  expiresAt: Date | null;
}

function bytes(value: string | number): number;
function bytes(value: string | number | null): number | null;
function bytes(value: string | number | null): number | null {
  if (value === null) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('Authorization grant exceeds the safe integer range');
  }
  return result;
}

const SERVER_ACCESS_COLUMNS = [
  'cpu_cores', 'mem_bytes', 'disk_bytes', 'root_disk_bytes', 'gpu_count', 'gpu_pci_addresses', 'expires_at',
] as const;

function serverAccess(row: {
  cpu_cores: number | null;
  mem_bytes: string | null;
  disk_bytes: string;
  root_disk_bytes: string | null;
  gpu_count: number | null;
  gpu_pci_addresses: string[];
  expires_at: Date | null;
}): ServerAccess {
  return {
    cpuCores: row.cpu_cores,
    memBytes: bytes(row.mem_bytes),
    diskBytes: bytes(row.disk_bytes),
    rootDiskBytes: bytes(row.root_disk_bytes),
    gpuCount: row.gpu_count,
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
    .select(SERVER_ACCESS_COLUMNS)
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
    .select(POOL_ACCESS_COLUMNS)
    .where('user_id', '=', userId)
    .where('pool_id', '=', poolId)
    .executeTakeFirst();
  return row ? poolAccess(row) : null;
}

const POOL_ACCESS_COLUMNS = ['cap_bytes', 'expires_at', 'server_id', 'server_grant_id'] as const;

function poolAccess(row: {
  cap_bytes: string | null;
  expires_at: Date | null;
  server_id: string;
  server_grant_id: string;
}): PoolAccess {
  return {
    capBytes: bytes(row.cap_bytes),
    expiresAt: row.expires_at,
    serverId: row.server_id,
    serverGrantId: row.server_grant_id,
  };
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
    .select(['server_id', ...SERVER_ACCESS_COLUMNS])
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
    .select(['pool_id', ...POOL_ACCESS_COLUMNS])
    .where('user_id', '=', userId)
    .orderBy('pool_id')
    .execute();
  return rows.map((row) => ({ poolId: row.pool_id, ...poolAccess(row) }));
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
