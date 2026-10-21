import { ContainerPhase, ContainerPowerIntent } from '@nyabase/common';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { ContainerControlTable } from '../platform/persistence-pg/container-control-database.types.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type {
  HttpDomainPoolTable,
  HttpProxyBindingTable,
} from '../platform/persistence-pg/http-proxy-database.types.js';
import type { PgTransactionManager } from '../platform/persistence-pg/transaction.js';

const HTTP_PROXY_ADVISORY_NAMESPACE = 1_856_214_887;

export const ROUTE_STALE_MS = 120_000;

export const DOMAIN_POOL_MUTATION_LOCK = 1;

export const BINDING_CAPACITY_LOCK = 2;

export const HOSTNAME_RESERVATION_LOCK = 3;

export type HttpExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export type DomainPoolRow = Selectable<HttpDomainPoolTable>;

export type BindingRow = Selectable<HttpProxyBindingTable>;

export type ContainerRow = Selectable<ContainerControlTable>;

/** Transaction-scoped advisory lock serialising one kind of HTTP proxy mutation. */
export async function lockHttpProxy(
  transaction: Transaction<NyabaseDatabase>,
  key: number,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    ${HTTP_PROXY_ADVISORY_NAMESPACE},
    ${key}
  )`.execute(transaction);
}

export function runSerializable<T>(
  transactions: PgTransactionManager,
  work: (transaction: Transaction<NyabaseDatabase>) => Promise<T>,
): Promise<T> {
  return transactions.run(work, {
    isolationLevel: 'serializable',
    maxAttempts: 5,
  });
}

/** A route only counts for a container that is active, wanted running, and carries the route's instance. */
export function routeMatchesContainer(
  route: { instance_name: string },
  container: ContainerRow,
): boolean {
  return container.lifecycle_phase === ContainerPhase.Active
    && container.instance_name === route.instance_name
    && container.power_intent === ContainerPowerIntent.Running;
}

export function isUniqueConstraintViolation(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === '23505') return true;
    current = record.cause;
  }
  return false;
}
