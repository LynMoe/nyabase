import { DataSource, EntityManager } from 'typeorm';

type TransactionWork<T> = (manager: EntityManager) => Promise<T>;

let sqliteTransactionQueue: Promise<void> = Promise.resolve();

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

  const current = sqliteTransactionQueue
    .catch(() => undefined)
    .then(() => dataSource.transaction(work));
  sqliteTransactionQueue = current.then(() => undefined, () => undefined);
  return current;
}
