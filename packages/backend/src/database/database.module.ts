import { Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_ENTITIES } from './db-entities.js';

/**
 * `synchronize` decision matrix:
 *   - production:                always false (DB_SYNC env is ignored).
 *   - test / development:        true unless DB_SYNC is explicitly set to 'false'.
 *
 * Production schema changes MUST go through TypeORM migrations
 * (`packages/backend/src/database/migrations/*.ts`); the AppDataSource in
 * `datasource.ts` exposes the CLI entrypoint.
 */
function resolveSynchronize(logger: Logger): boolean {
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    if (process.env.DB_SYNC === 'true') {
      logger.warn(
        'DB_SYNC=true is ignored in production. Use migrations instead.',
      );
    }
    return false;
  }
  return process.env.DB_SYNC !== 'false';
}

function migrationGlobs(): string[] {
  return __dirname.includes('/dist/')
    ? ['dist/database/migrations/*.js']
    : ['src/database/migrations/*.ts'];
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('DatabaseModule');
        const driver = config.get<string>('app.dbDriver', 'sqlite');
        const synchronize = resolveSynchronize(logger);

        const migrations = migrationGlobs();
        const migrationsRun = process.env.DB_MIGRATIONS_RUN === 'true';

        if (driver === 'postgres') {
          return {
            type: 'postgres',
            host: config.get('app.dbHost'),
            port: config.get('app.dbPort'),
            database: config.get('app.dbName'),
            username: config.get('app.dbUser'),
            password: config.get('app.dbPassword'),
            entities: DB_ENTITIES,
            migrations,
            migrationsRun,
            synchronize,
          };
        }
        return {
          type: 'better-sqlite3',
          database: config.get<string>('app.dbPath', './nyabase.db'),
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
