import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  ContainerPhase,
  ContainerPowerIntent,
  HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  ServerStatus,
  normalizeHttpProxyHostname,
  normalizeHttpProxyWildcardDomain,
} from '@nyabase/common';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { ContainerControlTable } from '../platform/persistence-pg/container-control-database.types.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type {
  HttpDomainPoolTable,
  HttpProxyBindingTable,
} from '../platform/persistence-pg/http-proxy-database.types.js';
import type { InfrastructureServerTable } from '../platform/persistence-pg/infrastructure-database.types.js';
import type { PgTransactionManager } from '../platform/persistence-pg/transaction.js';

export const ROUTE_STALE_MS = 120_000;
const HTTP_PROXY_ADVISORY_NAMESPACE = 1_856_214_887;
export const DOMAIN_POOL_MUTATION_LOCK = 1;
export const BINDING_CAPACITY_LOCK = 2;
export const HOSTNAME_RESERVATION_LOCK = 3;

export type HttpExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;
export type DomainPoolRow = Selectable<HttpDomainPoolTable>;
export type BindingRow = Selectable<HttpProxyBindingTable>;
export type ContainerRow = Selectable<ContainerControlTable>;
export type ServerRow = Selectable<InfrastructureServerTable>;

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

export async function databaseNow(executor: HttpExecutor): Promise<Date> {
  const result = await sql<{ now: Date }>`
    select clock_timestamp() as now
  `.execute(executor);
  return result.rows[0]!.now;
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

export function serverCanProxy(server: ServerRow): boolean {
  return server.status === ServerStatus.Online
    && Boolean(server.parent_interface);
}

/** TLS material that stays valid for longer than a snapshot lease can be in flight. */
export function poolHasSafeTlsLease(pool: DomainPoolRow, now: number): boolean {
  return Boolean(
    pool.certificate_pem
    && pool.encrypted_private_key_pem
    && pool.certificate_not_after
    && pool.certificate_not_after.getTime() > now
      + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS
      + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  );
}

export function parseHttpProxyHostname(value: string): string {
  try {
    return normalizeHttpProxyHostname(value);
  } catch {
    throw new BadRequestException({
      code: 'INVALID_HTTP_PROXY_HOSTNAME',
      message: 'hostname must be a valid ASCII DNS hostname without a wildcard',
    });
  }
}

export function parseHttpProxyWildcardDomain(value: string): string {
  try {
    return normalizeHttpProxyWildcardDomain(value);
  } catch {
    throw new BadRequestException({
      code: 'INVALID_HTTP_PROXY_WILDCARD_DOMAIN',
      message: 'wildcardDomain must be a valid ASCII DNS wildcard domain',
    });
  }
}

export function duplicateDomainPoolConflict(): ConflictException {
  return new ConflictException({
    code: 'HTTP_PROXY_DOMAIN_POOL_EXISTS',
    message: 'A domain pool already owns this wildcard domain',
  });
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

export function safeGeneration(value: string | number | bigint): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('HTTP proxy snapshot generation exceeds the safe application range');
  }
  return generation;
}
