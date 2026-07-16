import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { installDatabaseCoordinator } from './database-coordinator.js';
import { runSerializedTransaction } from './serialized-transaction.js';

@Entity('database_coordinator_probes')
class DatabaseCoordinatorProbe {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  value: string;
}

describe('single-connection SQLite database coordinator', () => {
  let dataSource: DataSource;

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('supports installation before TypeORM initialize and schema transactions', async () => {
    dataSource = installDatabaseCoordinator(new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [DatabaseCoordinatorProbe],
    }));

    await expect(dataSource.initialize()).resolves.toBe(dataSource);
    await expect(dataSource.getRepository(DatabaseCoordinatorProbe).insert({
      id: 'initialized',
      value: 'ready',
    })).resolves.toBeDefined();
  });

  it('never lets a successful ordinary write leak into and vanish with another transaction rollback', async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [DatabaseCoordinatorProbe],
    });
    await dataSource.initialize();
    installDatabaseCoordinator(dataSource);
    const repo = dataSource.getRepository(DatabaseCoordinatorProbe);
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let allowRollback!: () => void;
    const rollback = new Promise<void>((resolve) => { allowRollback = resolve; });

    const transaction = runSerializedTransaction(dataSource, async (manager) => {
      await manager.insert(DatabaseCoordinatorProbe, { id: 'inside', value: 'rollback' });
      signalStarted();
      await rollback;
      throw new Error('intentional rollback');
    });
    await started;

    let outsideSettled = false;
    const outside = repo.insert({ id: 'outside', value: 'committed' }).then(() => {
      outsideSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(outsideSettled).toBe(false);

    allowRollback();
    await expect(transaction).rejects.toThrow('intentional rollback');
    await outside;
    expect(await repo.find({ order: { id: 'ASC' } })).toEqual([
      expect.objectContaining({ id: 'outside', value: 'committed' }),
    ]);
  });

  it('also coordinates callers that use DataSource.transaction directly', async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [DatabaseCoordinatorProbe],
    });
    await dataSource.initialize();
    installDatabaseCoordinator(dataSource);
    const repo = dataSource.getRepository(DatabaseCoordinatorProbe);
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });

    const transaction = dataSource.transaction(async (manager) => {
      await manager.insert(DatabaseCoordinatorProbe, { id: 'inside', value: 'rollback' });
      signalStarted();
      await wait;
      throw new Error('rollback direct transaction');
    });
    await started;
    const outside = repo.insert({ id: 'outside', value: 'committed' });
    finish();

    await expect(transaction).rejects.toThrow('rollback direct transaction');
    await outside;
    expect(await repo.find()).toEqual([
      expect.objectContaining({ id: 'outside', value: 'committed' }),
    ]);
  });

  it('coordinates EntityManager.transaction despite better-sqlite3 reusing one QueryRunner', async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [DatabaseCoordinatorProbe],
    });
    await dataSource.initialize();
    installDatabaseCoordinator(dataSource);
    const repo = dataSource.getRepository(DatabaseCoordinatorProbe);
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });

    const transaction = dataSource.manager.transaction(async (manager) => {
      await manager.insert(DatabaseCoordinatorProbe, { id: 'inside', value: 'rollback' });
      signalStarted();
      await wait;
      throw new Error('rollback manager transaction');
    });
    await started;
    let outsideSettled = false;
    const outside = repo.insert({ id: 'outside', value: 'committed' }).then(() => {
      outsideSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(outsideSettled).toBe(false);
    finish();

    await expect(transaction).rejects.toThrow('rollback manager transaction');
    await outside;
    expect(await repo.find()).toEqual([
      expect.objectContaining({ id: 'outside', value: 'committed' }),
    ]);
  });

  it('fails closed on raw QueryRunner transactions that cannot carry caller identity', async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [DatabaseCoordinatorProbe],
    });
    await dataSource.initialize();
    installDatabaseCoordinator(dataSource);
    const runner = dataSource.createQueryRunner();

    await expect(runner.startTransaction())
      .rejects.toThrow('Uncoordinated SQLite QueryRunner transaction is forbidden');
    await runner.release();
  });
});
