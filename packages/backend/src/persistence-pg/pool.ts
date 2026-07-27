import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import type { PgPersistenceOptions } from './options.js';

export interface PgPoolLogger {
  error(message: string): void;
  warn?(message: string): void;
}

function errorCode(error: Error): string {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : 'unknown';
}

export function attachPgPoolErrorPolicy(
  pool: Pool,
  logger: PgPoolLogger,
): void {
  let lastSaturationWarningAt = 0;
  pool.on('error', (error) => {
    // pg-pool has already evicted the broken idle client when this event is
    // emitted. Handling it here prevents EventEmitter's default process
    // termination while subsequent checkouts/readiness probes can reconnect.
    logger.error(
      `Idle PostgreSQL client failed (sqlstate=${errorCode(error)}, `
      + `total=${pool.totalCount}, idle=${pool.idleCount}, waiting=${pool.waitingCount}): `
      + error.message,
    );
  });
  pool.on('acquire', () => {
    const now = Date.now();
    if (
      pool.waitingCount > 0
      && now - lastSaturationWarningAt >= 30_000
    ) {
      lastSaturationWarningAt = now;
      logger.warn?.(
        `PostgreSQL pool is saturated `
        + `(total=${pool.totalCount}, idle=${pool.idleCount}, waiting=${pool.waitingCount}, `
        + `acquisitionTimeoutMs is configured)`,
      );
    }
  });
}

export function createPgPool(
  options: PgPersistenceOptions,
  logger: PgPoolLogger = new Logger('PgPool'),
): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.poolMax,
    // pg-pool applies this deadline both while establishing a socket and while
    // a checkout waits behind a saturated pool.
    connectionTimeoutMillis: options.connectionTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs,
    // statement_timeout is server-side; query_timeout also bounds a query if
    // the network stops delivering a server response.
    query_timeout: options.statementTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    lock_timeout: options.lockTimeoutMs,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs,
    ssl: options.ssl,
    allowExitOnIdle: false,
  });
  attachPgPoolErrorPolicy(pool, logger);
  return pool;
}
