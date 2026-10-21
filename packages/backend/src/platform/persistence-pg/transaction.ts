import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  IsolationLevel,
  Kysely,
  Transaction,
} from 'kysely';
import type { NyabaseDatabase } from './database.types.js';
import { PG_DATABASE } from './tokens.js';

const RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01']);

export interface PgTransactionOptions {
  isolationLevel?: IsolationLevel;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  onRetry?: (event: PgTransactionRetryEvent) => void;
}

export interface PgTransactionRetryEvent {
  attempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  sqlstate: string;
}

function errorCode(error: unknown): string | null {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string') return record.code;
    current = record.cause;
  }
  return null;
}

export function isRetryablePgTransactionError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== null && RETRYABLE_TRANSACTION_CODES.has(code);
}

export async function retryPgTransaction<T>(
  execute: () => Promise<T>,
  options: PgTransactionOptions = {},
  sleep: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 10;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('maxAttempts must be an integer between 1 and 10');
  }
  if (
    !Number.isSafeInteger(retryBaseDelayMs)
    || retryBaseDelayMs < 0
    || retryBaseDelayMs > 10_000
  ) {
    throw new Error('retryBaseDelayMs must be an integer between 0 and 10000');
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await execute();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryablePgTransactionError(error)) throw error;
      const exponential = retryBaseDelayMs * (2 ** (attempt - 1));
      const jitter = retryBaseDelayMs === 0
        ? 0
        : Math.floor(Math.random() * retryBaseDelayMs);
      const delayMs = exponential + jitter;
      options.onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        sqlstate: errorCode(error) ?? 'unknown',
      });
      await sleep(delayMs);
    }
  }
}

@Injectable()
export class PgTransactionManager {
  private readonly logger = new Logger(PgTransactionManager.name);

  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  run<T>(
    work: (transaction: Transaction<NyabaseDatabase>) => Promise<T>,
    options: PgTransactionOptions = {},
  ): Promise<T> {
    const callerOnRetry = options.onRetry;
    return retryPgTransaction(
      () => this.database
        .transaction()
        .setIsolationLevel(options.isolationLevel ?? 'read committed')
        .execute(work),
      {
        ...options,
        onRetry: (event) => {
          this.logger.warn(
            `Retrying PostgreSQL transaction after sqlstate=${event.sqlstate} `
            + `(attempt=${event.attempt}/${event.maxAttempts}, delayMs=${event.delayMs})`,
          );
          callerOnRetry?.(event);
        },
      },
    );
  }
}
