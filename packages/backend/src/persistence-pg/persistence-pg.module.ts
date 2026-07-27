import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import type { NyabaseDatabase } from './database.types.js';
import {
  assertFreshInitialMigrationManifest,
  assertSqlMigrationManifestCompatibility,
  discoverSqlMigrations,
  runSqlMigrations,
} from './migrator.js';
import {
  pgPersistenceOptionsFromConfig,
  redactDatabaseUrl,
  type PgPersistenceOptions,
} from './options.js';
import { createPgPool } from './pool.js';
import { PG_DATABASE, PG_OPTIONS, PG_POOL } from './tokens.js';
import { PgTransactionManager } from './transaction.js';

export function pgMigrationsDirectory(moduleDirectory = __dirname): string {
  return `${moduleDirectory}/migrations`;
}

@Injectable()
export class PgSchemaReadiness {
  private readonly manifest = discoverSqlMigrations(pgMigrationsDirectory())
    .then((migrations) => {
      assertFreshInitialMigrationManifest(migrations);
      return migrations;
    });

  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
    @Inject(PG_OPTIONS)
    private readonly options: PgPersistenceOptions,
  ) {}

  async check(): Promise<void> {
    await assertSqlMigrationManifestCompatibility(
      this.pool,
      await this.manifest,
      { queryTimeoutMs: this.options.readinessTimeoutMs },
    );
  }
}

@Injectable()
class PgPersistenceLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.destroy();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_OPTIONS,
      inject: [NyabaseConfigService],
      useFactory: (config: NyabaseConfigService): PgPersistenceOptions =>
        pgPersistenceOptionsFromConfig(config),
    },
    {
      provide: PG_POOL,
      inject: [PG_OPTIONS],
      useFactory: (options: PgPersistenceOptions): Pool => createPgPool(options),
    },
    {
      provide: PG_DATABASE,
      inject: [PG_OPTIONS, PG_POOL],
      useFactory: async (
        options: PgPersistenceOptions,
        pool: Pool,
      ): Promise<Kysely<NyabaseDatabase>> => {
        const logger = new Logger('PgPersistenceBootstrap');
        try {
          const migrations = await discoverSqlMigrations(pgMigrationsDirectory());
          assertFreshInitialMigrationManifest(migrations);
          if (options.runMigrationsOnStart) {
            const completed = await runSqlMigrations(
              pool,
              pgMigrationsDirectory(),
              { lockTimeoutMs: options.lockTimeoutMs },
            );
            logger.log(`Applied ${completed.length} PostgreSQL migration(s)`);
          }
          const status = await assertSqlMigrationManifestCompatibility(
            pool,
            migrations,
            { queryTimeoutMs: options.readinessTimeoutMs },
          );
          logger.log(
            `Verified exact PostgreSQL migration manifest `
            + `(${status.applied.length} migration(s))`,
          );
          logger.log(`Connected to ${redactDatabaseUrl(options.connectionString)}`);
          return new Kysely<NyabaseDatabase>({
            dialect: new PostgresDialect({ pool }),
          });
        } catch (error) {
          await pool.end().catch(() => undefined);
          throw error;
        }
      },
    },
    PgSchemaReadiness,
    PgTransactionManager,
    PgPersistenceLifecycle,
  ],
  exports: [
    PG_OPTIONS,
    PG_POOL,
    PG_DATABASE,
    PgSchemaReadiness,
    PgTransactionManager,
  ],
})
export class PgPersistenceModule {}
