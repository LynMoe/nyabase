import { describe, expect, it, vi } from 'vitest';
import type { PgPersistenceOptions } from './options.js';
import { createPgPool } from './pool.js';

function options(): PgPersistenceOptions {
  return {
    connectionString: 'postgresql://nyabase:secret@127.0.0.1:5432/nyabase',
    applicationName: 'nyabase-pool-test',
    poolMax: 7,
    connectionTimeoutMs: 1_234,
    idleTimeoutMs: 30_000,
    statementTimeoutMs: 4_321,
    lockTimeoutMs: 5_000,
    idleInTransactionTimeoutMs: 30_000,
    readinessTimeoutMs: 2_000,
    ssl: false,
    runMigrationsOnStart: false,
  };
}

describe('PostgreSQL pool runtime policy', () => {
  it('bounds acquisition and client-side query waits', async () => {
    const pool = createPgPool(options(), { error: vi.fn() });
    const internal = pool as typeof pool & {
      options: {
        connectionTimeoutMillis: number;
        query_timeout: number;
      };
    };

    expect(internal.options.connectionTimeoutMillis).toBe(1_234);
    expect(internal.options.query_timeout).toBe(4_321);
    await pool.end();
  });

  it('handles and reports an idle-client error without EventEmitter termination', async () => {
    const error = vi.fn();
    const pool = createPgPool(options(), { error });
    const failure = Object.assign(
      new Error('terminating connection due to administrator command'),
      { code: '57P01' },
    );

    expect(() => pool.emit('error', failure, undefined as never)).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sqlstate=57P01'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('total=0'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining(failure.message));
    await pool.end();
  });
});
