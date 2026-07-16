import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { DB_ENTITIES } from './db-entities.js';
import { loadNyabaseConfig } from '../config/nyabase-config-loader.js';
import { configureExclusiveSqliteConnection } from './exclusive-sqlite.js';

const config = loadNyabaseConfig();
const driver = config.fields['database.driver'].effectiveValue;

function migrationGlobs(): string[] {
  return __dirname.includes('/dist/')
    ? ['dist/database/migrations/*.js']
    : ['src/database/migrations/*.ts'];
}

const migrations = migrationGlobs();

if (driver !== 'sqlite') {
  throw new Error(`Unsupported database.driver "${driver}". Only "sqlite" is supported.`);
}

export const AppDataSource = new DataSource({
  type: 'better-sqlite3',
  database: config.fields['database.path'].effectiveValue as string,
  timeout: 0,
  prepareDatabase: configureExclusiveSqliteConnection,
  entities: DB_ENTITIES,
  migrations,
  synchronize: false,
});
