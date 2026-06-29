import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { DB_ENTITIES } from './db-entities.js';
import { loadNyabaseConfig } from '../config/nyabase-config-loader.js';

const config = loadNyabaseConfig();
const driver = config.fields['database.driver'].effectiveValue;

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
        host: config.fields['database.host'].effectiveValue as string,
        port: config.fields['database.port'].effectiveValue as number,
        database: config.fields['database.name'].effectiveValue as string,
        username: config.fields['database.user'].effectiveValue as string,
        password: config.fields['database.password'].effectiveValue as string,
        entities: DB_ENTITIES,
        migrations,
        synchronize: false,
      })
    : new DataSource({
        type: 'better-sqlite3',
        database: config.fields['database.path'].effectiveValue as string,
        entities: DB_ENTITIES,
        migrations,
        synchronize: false,
      });
