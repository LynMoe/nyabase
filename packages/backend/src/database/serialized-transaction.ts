import { DataSource, EntityManager } from 'typeorm';
import {
  installDatabaseCoordinator,
  runWithDatabaseCoordinator,
} from './database-coordinator.js';

type TransactionWork<T> = (manager: EntityManager) => Promise<T>;

function usesSingleConnectionSqlite(dataSource: DataSource): boolean {
  return dataSource.options.type === 'sqlite' || dataSource.options.type === 'better-sqlite3';
}

export async function runSerializedTransaction<T>(
  dataSource: DataSource,
  work: TransactionWork<T>,
): Promise<T> {
  if (!usesSingleConnectionSqlite(dataSource)) {
    return dataSource.transaction('SERIALIZABLE', work);
  }
  installDatabaseCoordinator(dataSource);
  return runWithDatabaseCoordinator(dataSource, () => dataSource.transaction(work));
}
