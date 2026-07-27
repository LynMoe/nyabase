import {
  Inject,
  Injectable,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { FailStopService } from '../common/fail-stop.service.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import type { PgPersistenceOptions } from '../persistence-pg/options.js';
import { PG_OPTIONS } from '../persistence-pg/tokens.js';

/**
 * Dedicated connection budget for connection-scoped Agent authority locks.
 * Main business transactions must remain usable even when several Servers are
 * waiting for takeover fences.
 */
@Injectable()
export class AgentSessionLockDatabase implements OnApplicationShutdown {
  readonly database: Kysely<NyabaseDatabase>;
  private readonly pool: Pool;

  constructor(
    @Inject(PG_OPTIONS) options: PgPersistenceOptions,
    private readonly failStop: FailStopService,
  ) {
    const pool = new Pool({
      connectionString: options.connectionString,
      application_name: `${options.applicationName}-agent-session-lock`,
      max: 4,
      idleTimeoutMillis: options.idleTimeoutMs,
      connectionTimeoutMillis: options.connectionTimeoutMs,
      query_timeout: options.statementTimeoutMs,
      statement_timeout: options.statementTimeoutMs,
      lock_timeout: options.lockTimeoutMs,
      idle_in_transaction_session_timeout:
        options.idleInTransactionTimeoutMs,
      ssl: options.ssl,
      allowExitOnIdle: false,
    });
    this.pool = pool;
    pool.on('error', (error) => {
      // pg-pool re-emits failures from idle clients on the Pool itself. A
      // client listener alone does not consume that EventEmitter "error"
      // event, so retain an explicit fail-stop boundary here as well.
      this.failStop.terminate(new Error(
        'Agent session lock database pool lost a connection',
        { cause: error },
      ));
    });
    // A connection-scoped advisory lock is live authority. node-postgres emits
    // socket failures independently of the query promise; retain an explicit
    // listener so they cannot become an unhandled exception before the
    // repository watchdog observes the same loss.
    pool.on('connect', (client) => {
      client.on('error', (error) => {
        this.failStop.terminate(new Error(
          'Agent session lock database connection lost',
          { cause: error },
        ));
      });
    });
    this.database = new Kysely<NyabaseDatabase>({
      dialect: new PostgresDialect({
        pool,
      }),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.database.destroy();
  }
}
