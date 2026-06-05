import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { join } from 'path';
import { DB_ENTITIES } from './db-entities.js';

// Mirror the env-file loading order used by the application
config({ path: join(process.cwd(), '.env.local') });
config({ path: join(process.cwd(), '.env') });

const driver = process.env.DB_DRIVER ?? 'sqlite';

function migrationGlobs(): string[] {
  return __dirname.includes('/dist/')
    ? ['dist/database/migrations/*.js']
    : ['src/database/migrations/*.ts'];
}

const migrations = migrationGlobs();

export const AppDataSource =
  driver === 'postgres'
    ? new DataSource({
        type: 'postgres',
        host: process.env.DB_HOST ?? 'localhost',
        port: parseInt(process.env.DB_PORT ?? '5432', 10),
        database: process.env.DB_NAME ?? 'nyabase',
        username: process.env.DB_USER ?? 'nyabase',
        password: process.env.DB_PASSWORD ?? '',
        entities: DB_ENTITIES,
        migrations,
        synchronize: false,
      })
    : new DataSource({
        type: 'better-sqlite3',
        database: process.env.DB_PATH ?? './nyabase.db',
        entities: DB_ENTITIES,
        migrations,
        synchronize: false,
      });
