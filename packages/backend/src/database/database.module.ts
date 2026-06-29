import { Module, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_ENTITIES } from './db-entities.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

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

function migrationGlobs(): string[] {
  return __dirname.includes('/dist/')
    ? ['dist/database/migrations/*.js']
    : ['src/database/migrations/*.ts'];
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [NyabaseConfigService],
      useFactory: (config: NyabaseConfigService) => {
        const logger = new Logger('DatabaseModule');
        const driver = config.get<string>('database.driver');
        const synchronize = resolveSynchronize(config, logger);

        const migrations = migrationGlobs();
        const migrationsRun = config.get<boolean>('database.migrationsRun');

        if (driver === 'postgres') {
          return {
            type: 'postgres',
            host: config.get<string>('database.host'),
            port: config.get<number>('database.port'),
            database: config.get<string>('database.name'),
            username: config.get<string>('database.user'),
            password: config.get<string>('database.password'),
            entities: DB_ENTITIES,
            migrations,
            migrationsRun,
            synchronize,
          };
        }
        return {
          type: 'better-sqlite3',
          database: config.get<string>('database.path'),
          entities: DB_ENTITIES,
          migrations,
          migrationsRun,
          synchronize,
        };
      },
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
