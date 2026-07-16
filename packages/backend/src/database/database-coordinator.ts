import { AsyncLocalStorage } from 'node:async_hooks';
import { ServiceUnavailableException } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

type Release = () => void;

class FifoMutex {
  private locked = false;
  private readonly waiters: Array<{
    resolve: (release: Release) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  async acquire(): Promise<Release> {
    if (!this.locked) {
      this.locked = true;
      return this.releaseHandle();
    }
    if (this.waiters.length >= DATABASE_COORDINATOR_MAX_WAITERS) {
      throw this.overloaded('queue capacity is exhausted');
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(this.overloaded('acquire deadline exceeded'));
        }, DATABASE_COORDINATOR_ACQUIRE_TIMEOUT_MS),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  get pending(): number {
    return this.waiters.length;
  }

  private releaseHandle(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (!next) {
        this.locked = false;
        return;
      }
      clearTimeout(next.timer);
      next.resolve(this.releaseHandle());
    };
  }

  private overloaded(reason: string): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'DATABASE_COORDINATOR_OVERLOADED',
      message: `Database coordinator ${reason}`,
    });
  }
}

export const DATABASE_COORDINATOR_MAX_WAITERS = 256;
export const DATABASE_COORDINATOR_ACQUIRE_TIMEOUT_MS = 30_000;

interface CoordinatorState {
  mutex: FifoMutex;
}

interface LeaseContext {
  state: CoordinatorState;
  active: boolean;
}

const states = new WeakMap<DataSource, CoordinatorState>();
const installed = new WeakSet<DataSource>();
const wrappedRunners = new WeakSet<QueryRunner>();
const wrappedManagers = new WeakSet<EntityManager>();
const leaseStorage = new AsyncLocalStorage<LeaseContext>();

function isSingleConnectionSqlite(dataSource: DataSource): boolean {
  return dataSource.options.type === 'sqlite' || dataSource.options.type === 'better-sqlite3';
}

function stateFor(dataSource: DataSource): CoordinatorState {
  let state = states.get(dataSource);
  if (!state) {
    state = { mutex: new FifoMutex() };
    states.set(dataSource, state);
  }
  return state;
}

async function runWithState<T>(state: CoordinatorState, work: () => Promise<T>): Promise<T> {
  const inherited = leaseStorage.getStore();
  if (inherited?.state === state && inherited.active) return work();

  const release = await state.mutex.acquire();
  const context: LeaseContext = { state, active: true };
  return leaseStorage.run(context, async () => {
    try {
      return await work();
    } finally {
      // AsyncLocalStorage is inherited by child promises. Marking the token
      // inactive ensures any accidentally delayed child reacquires the mutex
      // instead of writing through a lease whose transaction already ended.
      context.active = false;
      release();
    }
  });
}

function wrapQueryRunner(dataSource: DataSource, queryRunner: QueryRunner): QueryRunner {
  if (wrappedRunners.has(queryRunner)) return queryRunner;
  wrappedRunners.add(queryRunner);

  const state = stateFor(dataSource);
  wrapEntityManager(dataSource, queryRunner.manager);
  const originalQuery = queryRunner.query.bind(queryRunner);
  const originalStart = queryRunner.startTransaction.bind(queryRunner);

  queryRunner.query = (async (...args: Parameters<QueryRunner['query']>) => {
    return runWithState(state, () => originalQuery(...args));
  }) as QueryRunner['query'];

  queryRunner.startTransaction = async (...args: Parameters<QueryRunner['startTransaction']>) => {
    const inherited = leaseStorage.getStore();
    if (inherited?.state !== state || !inherited.active) {
      // better-sqlite3 exposes one QueryRunner object for the connection. A
      // lease stored on that object cannot distinguish transaction work from
      // an unrelated repository query, so raw transactions are forbidden.
      // Use DataSource/EntityManager.transaction, both wrapped below.
      throw new Error('Uncoordinated SQLite QueryRunner transaction is forbidden');
    }
    await originalStart(...args);
  };
  return queryRunner;
}

function wrapEntityManager(dataSource: DataSource, manager: EntityManager): EntityManager {
  if (wrappedManagers.has(manager)) return manager;
  wrappedManagers.add(manager);

  const originalTransaction = manager.transaction.bind(manager);
  manager.transaction = ((...args: unknown[]) =>
    runWithDatabaseCoordinator(
      dataSource,
      () => (originalTransaction as (...transactionArgs: unknown[]) => Promise<unknown>)(...args),
    )) as EntityManager['transaction'];

  // EntityManager.save/remove families may create an internal QueryRunner
  // transaction. Hold the coordinator lease around the whole high-level call,
  // so its startTransaction is authorized and no ordinary query can join it.
  for (const methodName of ['save', 'remove', 'softRemove', 'recover'] as const) {
    const original = manager[methodName].bind(manager) as (...args: unknown[]) => Promise<unknown>;
    manager[methodName] = ((...args: unknown[]) =>
      runWithDatabaseCoordinator(dataSource, () => original(...args))) as never;
  }
  return manager;
}

/**
 * Install the process-local single-connection SQLite fence before the
 * DataSource is exposed to repositories. Transactions hold one reentrant
 * lease for their whole callback; ordinary queries take the same lease.
 */
export function installDatabaseCoordinator(dataSource: DataSource): DataSource {
  if (!isSingleConnectionSqlite(dataSource) || installed.has(dataSource)) return dataSource;
  installed.add(dataSource);
  wrapEntityManager(dataSource, dataSource.manager);
  const originalCreateEntityManager = dataSource.createEntityManager.bind(dataSource);
  dataSource.createEntityManager = ((...args: Parameters<DataSource['createEntityManager']>) =>
    wrapEntityManager(dataSource, originalCreateEntityManager(...args))) as DataSource['createEntityManager'];
  const originalCreateQueryRunner = dataSource.createQueryRunner.bind(dataSource);
  dataSource.createQueryRunner = ((mode?: 'master' | 'slave') =>
    wrapQueryRunner(dataSource, originalCreateQueryRunner(mode))) as DataSource['createQueryRunner'];

  const originalTransaction = dataSource.transaction.bind(dataSource);
  dataSource.transaction = ((...args: unknown[]) =>
    runWithDatabaseCoordinator(
      dataSource,
      () => (originalTransaction as (...transactionArgs: unknown[]) => Promise<unknown>)(...args),
    )) as DataSource['transaction'];

  // Schema and migration APIs create raw QueryRunner transactions internally.
  // Fence the complete high-level operation so their startTransaction calls
  // carry an authorized lease as well (including install-before-initialize).
  for (const methodName of [
    'initialize',
    'synchronize',
    'runMigrations',
    'undoLastMigration',
    'dropDatabase',
  ] as const) {
    const original = dataSource[methodName].bind(dataSource) as (...args: unknown[]) => Promise<unknown>;
    dataSource[methodName] = ((...args: unknown[]) =>
      runWithDatabaseCoordinator(dataSource, () => original(...args))) as never;
  }
  return dataSource;
}

export async function runWithDatabaseCoordinator<T>(
  dataSource: DataSource,
  work: () => Promise<T>,
): Promise<T> {
  if (!isSingleConnectionSqlite(dataSource)) return work();
  installDatabaseCoordinator(dataSource);
  return runWithState(stateFor(dataSource), work);
}
