import { Module, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { DB_ENTITIES } from './db-entities.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { configureExclusiveSqliteConnection } from './exclusive-sqlite.js';
import { installDatabaseCoordinator } from './database-coordinator.js';
import { migrationGlobs } from './migration-paths.js';

/**
 * `synchronize` decision matrix:
 *   - production:                always false (DB_SYNC env is ignored).
 *   - test / development:        true unless DB_SYNC is explicitly set to 'false'.
 *
 * Production schema changes MUST go through TypeORM migrations
 * (`packages/backend/src/database/migrations/*.ts`); the AppDataSource in
 * `datasource.ts` exposes the CLI entrypoint.
 */
function resolveSynchronize(config: NyabaseConfigService, logger: Logger): boolean {
  const isProduction = config.get<string>('runtime.nodeEnv') === 'production';
  if (isProduction) {
    if (config.get<boolean>('database.synchronize')) {
      logger.warn(
        'DB_SYNC=true is ignored in production. Use migrations instead.',
      );
    }
    return false;
  }
  return config.get<boolean>('database.synchronize');
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [NyabaseConfigService],
      useFactory: (config: NyabaseConfigService) => {
        const logger = new Logger('DatabaseModule');
        const driver = config.get<string>('database.driver');
        const synchronize = resolveSynchronize(config, logger);

        const migrations = migrationGlobs(__dirname);
        const migrationsRun = config.get<boolean>('database.migrationsRun');

        if (driver !== 'sqlite') {
          throw new Error(`Unsupported database.driver "${driver}". Only "sqlite" is supported.`);
        }

        return {
          type: 'better-sqlite3',
          database: config.get<string>('database.path'),
          timeout: 0,
          prepareDatabase: configureExclusiveSqliteConnection,
          entities: DB_ENTITIES,
          migrations,
          migrationsRun,
          synchronize,
        };
      },
      dataSourceFactory: async (options?: DataSourceOptions) => {
        if (!options) throw new Error('TypeORM did not provide DataSource options');
        const dataSource = await new DataSource(options).initialize();
        return installDatabaseCoordinator(dataSource);
      },
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
