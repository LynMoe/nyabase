import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IncusError } from '../incus/index.js';
import {
  PgResourceStatusRepository,
  ReconcileWorkerService,
} from './reconcile-worker.service.js';

const serverId = '00000000-0000-4000-8000-000000000001';
const resourceId = '00000000-0000-4000-8000-000000000002';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function intent() {
  return {
    id: '00000000-0000-4000-8000-000000000003',
    kind: 'container.update',
    resourceType: 'container',
    resourceId,
    serverId,
    targetGeneration: 1,
    status: 'pending',
    attemptCount: 0,
    readyAt: new Date(),
    request: {},
    baseline: null,
  };
}

function claim() {
  return {
    resourceType: 'container',
    resourceId,
    serverId,
    workerId: 'worker-test',
    leaseExpiresAt: new Date(Date.now() + 60_000),
    claimedAt: new Date(),
  } as never;
}

type ScanServer = {
  id: string;
  status: 'online' | 'unreachable' | 'unknown';
};

type StoragePoolRow = {
  id: string;
  server_id: string;
  incus_name: string;
  registered: boolean;
  used_bytes: string | number | null;
  total_bytes: string | number | null;
};

type BusyStrike = {
  resource_type: string;
  resource_id: string;
  observed_at: Date;
};

function stubIncusClient(extra: Record<string, unknown> = {}) {
  return {
    getResources: vi.fn().mockResolvedValue({ metadata: {} }),
    getStoragePoolResources: vi.fn().mockResolvedValue({ metadata: { space: {} } }),
    ...extra,
  };
}

function database(
  serverIds: string[] | ScanServer[] = [],
  extras: {
    pools?: StoragePoolRow[];
    strikes?: BusyStrike[];
  } = {},
) {
  const rows: ScanServer[] = serverIds.map((server) => (
    typeof server === 'string' ? { id: server, status: 'online' } : server
  ));
  const pools = extras.pools ?? [];
  const strikes = extras.strikes ?? [];
  const tableUpdates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const containerSets: Record<string, unknown>[] = [];

  const filterRows = <T extends Record<string, unknown>>(
    source: T[],
    filters: Array<{ column: string; operator: string; value: unknown }>,
  ): T[] => source.filter((row) => filters.every((filter) => {
    const actual = row[filter.column];
    if (filter.operator === '>=' && actual instanceof Date && filter.value instanceof Date) {
      return actual.getTime() >= filter.value.getTime();
    }
    return actual === filter.value;
  }));

  const selectBuilder = (table: string) => {
    const filters: Array<{ column: string; operator: string; value: unknown }> = [];
    const builder = {
      select: vi.fn(() => builder),
      selectAll: vi.fn(() => builder),
      where: vi.fn((column: string, operator: string, value: unknown) => {
        filters.push({ column, operator, value });
        return builder;
      }),
      execute: vi.fn(async () => {
        if (table === 'infra.storage_pools') return filterRows(pools as unknown as Array<Record<string, unknown>>, filters);
        if (table === 'control.reconcile_busy_strikes') {
          return filterRows(strikes as unknown as Array<Record<string, unknown>>, filters);
        }
        return filterRows(rows as unknown as Array<Record<string, unknown>>, filters);
      }),
      executeTakeFirst: vi.fn(async () => {
        const selected = table === 'infra.storage_pools'
          ? filterRows(pools as unknown as Array<Record<string, unknown>>, filters)
          : table === 'control.reconcile_busy_strikes'
            ? filterRows(strikes as unknown as Array<Record<string, unknown>>, filters)
            : filterRows(rows as unknown as Array<Record<string, unknown>>, filters);
        const first = selected[0];
        return first ? { ...first, revision: 1 } : undefined;
      }),
    };
    return builder;
  };

  return {
    rows,
    pools,
    strikes,
    tableUpdates,
    containerSets,
    insertInto: vi.fn((table: string) => ({
      values: vi.fn((value: BusyStrike | BusyStrike[]) => ({
        execute: vi.fn(async () => {
          if (table !== 'control.reconcile_busy_strikes') return;
          const items = Array.isArray(value) ? value : [value];
          for (const item of items) {
            strikes.push({
              resource_type: item.resource_type,
              resource_id: item.resource_id,
              observed_at: item.observed_at instanceof Date
                ? item.observed_at
                : new Date(item.observed_at),
            });
          }
        }),
      })),
    })),
    deleteFrom: vi.fn((table: string) => {
      const filters: Array<{ column: string; value: unknown }> = [];
      const builder = {
        where: vi.fn((column: string, _operator: string, value: unknown) => {
          filters.push({ column, value });
          return builder;
        }),
        execute: vi.fn(async () => {
          if (table !== 'control.reconcile_busy_strikes') return;
          const remaining = strikes.filter((row) => !filters.every((filter) => (
            String(row[filter.column as keyof BusyStrike]) === String(filter.value)
          )));
          strikes.splice(0, strikes.length, ...remaining);
        }),
      };
      return builder;
    }),
    updateTable: vi.fn((table: string) => ({
      set: vi.fn((values: Record<string, unknown>) => {
        tableUpdates.push({ table, values });
        if (table === 'control.containers') containerSets.push(values);
        const builder = {
          where: vi.fn((column: unknown, _operator?: string, value?: unknown) => {
            if (table === 'infra.servers' && column === 'id' && typeof value === 'string') {
              const row = rows.find((item) => item.id === value);
            }
            if (table === 'infra.storage_pools' && column === 'id' && typeof value === 'string') {
              const pool = pools.find((item) => item.id === value);
              if (pool) {
                if (values.used_bytes !== undefined) {
                  pool.used_bytes = values.used_bytes as StoragePoolRow['used_bytes'];
                }
                if (values.total_bytes !== undefined) {
                  pool.total_bytes = values.total_bytes as StoragePoolRow['total_bytes'];
                }
              }
            }
            return builder;
          }),
          execute: vi.fn().mockResolvedValue(undefined),
        };
        return builder;
      }),
    })),
    selectFrom: vi.fn((table: string) => selectBuilder(table)),
  };
}

function makeWorker(overrides: {
  reconcile?: () => Promise<unknown>;
  scan?: () => Promise<void>;
  wake?: { onWake: (listener: (payload: { reason: string }) => void) => () => void; wake: () => void };
  database?: ReturnType<typeof database>;
  clients?: { get: ReturnType<typeof vi.fn>; listServerIds: ReturnType<typeof vi.fn> };
  resourceStatus?: {
    markNeedsAttention: ReturnType<typeof vi.fn>;
    markFailure?: ReturnType<typeof vi.fn>;
    markSucceeded?: ReturnType<typeof vi.fn>;
    needsAttention?: ReturnType<typeof vi.fn>;
  };
} = {}) {
  const listPending = vi.fn().mockResolvedValue({
    items: [intent()],
    nextCursor: null,
  });
  const intents = {
    listPending,
    scheduleRetry: vi.fn().mockResolvedValue(undefined),
    settleForObservedGeneration: vi.fn().mockResolvedValue(undefined),
    settleOne: vi.fn().mockResolvedValue(true),
  };
  const withLease = vi.fn(async (
    _claim: unknown,
    operation: (lease: {
      readonly claim: unknown;
      readonly lost: boolean;
      renew: () => Promise<boolean>;
      assertOwned: () => void;
      stop: () => void;
    }) => Promise<void>,
  ) => operation({
    claim: claim(),
    lost: false,
    renew: vi.fn().mockResolvedValue(true),
    assertOwned: vi.fn(),
    stop: vi.fn(),
  }));
  const claims = {
    reapExpired: vi.fn().mockResolvedValue(0),
    claim: vi.fn().mockResolvedValue(claim()),
    withLease,
  };
  const role = { runsWorker: () => true } as never;
  const reconciler = {
    supports: () => true,
    reconcile: overrides.reconcile ?? vi.fn().mockResolvedValue({
      outcome: 'succeeded',
      observedGeneration: 1,
    }),
    ...(overrides.scan ? { scan: overrides.scan } : {}),
  };
  const wakeListeners: Array<(payload: { reason: string }) => void> = [];
  const wake = overrides.wake ?? {
    onWake: (listener: (payload: { reason: string }) => void) => {
      wakeListeners.push(listener);
      return () => undefined;
    },
    wake: () => undefined,
  };
  const clients = overrides.clients ?? {
    get: vi.fn().mockResolvedValue(stubIncusClient()),
    listServerIds: vi.fn().mockResolvedValue([]),
  };
  const resourceStatus = overrides.resourceStatus ?? {
    markNeedsAttention: vi.fn().mockResolvedValue(undefined),
    markFailure: vi.fn().mockResolvedValue(undefined),
    markSucceeded: vi.fn().mockResolvedValue(undefined),
  };
  const worker = new ReconcileWorkerService(
    role,
    intents as never,
    claims as never,
    [reconciler] as never,
    clients as never,
    resourceStatus as never,
    wake as never,
    overrides.database as never,
  );
  return {
    worker,
    intents,
    claims,
    reconciler,
    wakeListeners,
    clients,
    listPending,
    resourceStatus,
  };
}

describe('ReconcileWorkerService', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('persists five busy strikes and trips the breaker on a fresh worker', async () => {
    const db = database();
    const resourceStatus = {
      markNeedsAttention: vi.fn().mockResolvedValue(undefined),
      markFailure: vi.fn().mockResolvedValue(undefined),
      markSucceeded: vi.fn().mockResolvedValue(undefined),
    };
    const retry = vi.fn().mockRejectedValue(new IncusError('INSTANCE_BUSY', 'retry', { action: 'start' }));
    const first = makeWorker({ reconcile: retry, database: db, resourceStatus });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await first.worker.runOnce();
    }
    expect(resourceStatus.markNeedsAttention).not.toHaveBeenCalled();
    expect(db.strikes).toHaveLength(4);

    const second = makeWorker({ reconcile: retry, database: db, resourceStatus });
    await second.worker.runOnce();

    expect(db.strikes).toHaveLength(5);
    expect(resourceStatus.markNeedsAttention).toHaveBeenCalledOnce();
    expect(second.intents.settleForObservedGeneration).toHaveBeenCalledWith(
      'container',
      resourceId,
      1,
      expect.objectContaining({
        outcome: 'failed',
        failure: expect.objectContaining({ code: 'RESOURCE_NEEDS_ATTENTION' }),
      }),
    );
    expect(first.intents.scheduleRetry).toHaveBeenCalledTimes(4);
    expect(second.intents.scheduleRetry).not.toHaveBeenCalled();
  });

  it('does not claim or hit Incus when the resource needs attention', async () => {
    const setup = makeWorker({
      resourceStatus: {
        markNeedsAttention: vi.fn().mockResolvedValue(undefined),
        markFailure: vi.fn().mockResolvedValue(undefined),
        markSucceeded: vi.fn().mockResolvedValue(undefined),
        needsAttention: vi.fn().mockResolvedValue(true),
      },
    });
    await setup.worker.runOnce();
    expect(setup.claims.claim).not.toHaveBeenCalled();
    expect(setup.reconciler.reconcile).not.toHaveBeenCalled();
    expect(setup.clients.get).not.toHaveBeenCalled();
  });

  it.each(['SSH_DAEMON_PENDING', 'GUEST_NOT_READY'] as const)(
    'does not count %s as Incus lock busy strikes',
    async (code) => {
      const db = database();
      const resourceStatus = {
        markNeedsAttention: vi.fn().mockResolvedValue(undefined),
        markFailure: vi.fn().mockResolvedValue(undefined),
        markSucceeded: vi.fn().mockResolvedValue(undefined),
      };
      const setup = makeWorker({
        reconcile: vi.fn().mockRejectedValue(new IncusError(code, 'retry', {})),
        database: db,
        resourceStatus,
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await setup.worker.runOnce();
      }
      expect(resourceStatus.markNeedsAttention).not.toHaveBeenCalled();
      expect(db.strikes).toHaveLength(0);
      expect(setup.intents.scheduleRetry).toHaveBeenCalledTimes(5);
    },
  );

  it('does not force lifecycle_phase=failed when marking container attention', async () => {
    const containerSets: Record<string, unknown>[] = [];
    const repo = new PgResourceStatusRepository({
      updateTable: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          containerSets.push(values);
          return {
            where: vi.fn(() => ({
              execute: vi.fn().mockResolvedValue(undefined),
            })),
          };
        }),
      })),
    } as never);

    await repo.markNeedsAttention('container', resourceId, {
      code: 'RESOURCE_NEEDS_ATTENTION',
      message: 'Instance remained busy for five attempts within five minutes',
      details: {},
    });

    expect(containerSets).toHaveLength(1);
    expect(containerSets[0]).toMatchObject({
      needs_attention: true,
      failure_code: 'RESOURCE_NEEDS_ATTENTION',
    });
    expect(containerSets[0]).not.toHaveProperty('lifecycle_phase');
  });

  it('does not rewrite a deleting volume to failed', async () => {
    const volumeSets: Record<string, unknown>[] = [];
    const repo = new PgResourceStatusRepository({
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({
            executeTakeFirst: vi.fn().mockResolvedValue({ lifecycle_phase: 'deleting' }),
          })),
        })),
      })),
      updateTable: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          volumeSets.push(values);
          return {
            where: vi.fn(() => ({
              where: vi.fn(() => ({
                execute: vi.fn().mockResolvedValue(undefined),
              })),
              execute: vi.fn().mockResolvedValue(undefined),
            })),
          };
        }),
      })),
    } as never);

    await repo.markFailure('volume', resourceId, {
      code: 'VOLUME_REQUIRES_DETACH',
      message: 'still attached',
      details: {},
    });

    expect(volumeSets).toEqual([{ failure_code: 'VOLUME_REQUIRES_DETACH' }]);
  });

  it('does not skip deleting volumes that still have needs_attention', async () => {
    const repo = new PgResourceStatusRepository({
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({
            executeTakeFirst: vi.fn().mockResolvedValue({
              needs_attention: true,
              lifecycle_phase: 'deleting',
            }),
          })),
        })),
      })),
    } as never);
    await expect(repo.needsAttention('volume', resourceId)).resolves.toBe(false);
  });

  it('still processes a deleting volume even when needs_attention is set', async () => {
    const setup = makeWorker({
      resourceStatus: {
        markNeedsAttention: vi.fn().mockResolvedValue(undefined),
        markFailure: vi.fn().mockResolvedValue(undefined),
        markSucceeded: vi.fn().mockResolvedValue(undefined),
        needsAttention: vi.fn().mockResolvedValue(false),
      },
    });
    setup.listPending.mockResolvedValue({
      items: [{
        ...intent(),
        kind: 'volume.ensure',
        resourceType: 'volume',
        request: { operation: 'delete' },
      }],
      nextCursor: null,
    });
    await setup.worker.runOnce();
    expect(setup.claims.claim).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'volume',
      placementServerId: serverId,
      serverId,
    }));
    expect(setup.reconciler.reconcile).toHaveBeenCalled();
  });

  it('does not settle restart intents by id on a desired-state success', async () => {
    const setup = makeWorker();
    await setup.worker.runOnce();
    expect(setup.intents.settleForObservedGeneration).toHaveBeenCalledOnce();
    expect(setup.intents.settleOne).not.toHaveBeenCalled();
  });

  it('settles a restart intent by id and then coalesces desired-state intents', async () => {
    const restart = {
      ...intent(),
      kind: 'container.power',
      request: { action: 'restart' },
      baseline: { startedAt: '2026-01-01T00:00:00.000Z' },
    };
    const setup = makeWorker();
    setup.listPending.mockResolvedValue({ items: [restart], nextCursor: null });
    await setup.worker.runOnce();
    expect(setup.intents.settleOne).toHaveBeenCalledWith(restart.id, { outcome: 'succeeded' });
    expect(setup.intents.settleForObservedGeneration).toHaveBeenCalledWith(
      'container',
      resourceId,
      1,
      { outcome: 'succeeded', placementServerId: serverId },
    );
  });

  it.each([
    ['SERVER_UNREACHABLE', 'unreachable'],
    ['INCUS_TIMEOUT', 'unreachable'],
  ] as const)('keeps %s retryable and marks the server %s', async (code, status) => {
    const setup = makeWorker({
      reconcile: vi.fn().mockRejectedValue(new IncusError(code, 'retry', {})),
      database: database(),
    });

    await setup.worker.runOnce();

    expect(setup.intents.scheduleRetry).toHaveBeenCalledOnce();
    const update = setup.worker as unknown as { database: ReturnType<typeof database> };
    expect(update.database.updateTable).toHaveBeenCalledWith('infra.servers');
    expect(status).toBe('unreachable');
  });

  it('passes each connect intent fingerprint to its own client lookup', async () => {
    const firstFingerprint = 'a'.repeat(64);
    const secondFingerprint = 'b'.repeat(64);
    const first = {
      ...intent(),
      id: '00000000-0000-4000-8000-000000000011',
      kind: 'server.connect',
      resourceType: 'server',
      resourceId: serverId,
      serverId,
      request: {
        trustTokenRef: '00000000-0000-4000-8000-000000000021',
        expectedServerCertFingerprint: firstFingerprint,
      },
    };
    const second = {
      ...first,
      id: '00000000-0000-4000-8000-000000000012',
      request: {
        trustTokenRef: '00000000-0000-4000-8000-000000000022',
        expectedServerCertFingerprint: secondFingerprint,
      },
    };
    const setup = makeWorker();
    setup.listPending.mockResolvedValue({
      items: [first, second],
      nextCursor: null,
    });

    await setup.worker.runOnce();

    expect(setup.clients.get).toHaveBeenNthCalledWith(
      1,
      serverId,
      { expectedFingerprint: firstFingerprint },
    );
    expect(setup.clients.get).toHaveBeenNthCalledWith(
      2,
      serverId,
      { expectedFingerprint: secondFingerprint },
    );
  });

  it('wakes immediately for Incus events and still runs a periodic full scan', async () => {
    vi.useFakeTimers();
    const scan = vi.fn().mockResolvedValue(undefined);
    const db = database([serverId]);
    const clients = {
      get: vi.fn().mockResolvedValue(stubIncusClient()),
      listServerIds: vi.fn().mockResolvedValue([]),
    };
    const setup = makeWorker({ scan, database: db, clients });
    setup.worker.onModuleInit();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());

    setup.wakeListeners[0]?.({ reason: 'event' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(setup.listPending).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    await setup.worker.onModuleDestroy();
  });

  it('scans only online servers and never opens a client for pre-connect servers', async () => {
    const unknownServerId = '00000000-0000-4000-8000-000000000010';
    const onlineServerId = '00000000-0000-4000-8000-000000000011';
    const scan = vi.fn().mockResolvedValue(undefined);
    const clients = {
      get: vi.fn().mockResolvedValue(stubIncusClient()),
      listServerIds: vi.fn().mockResolvedValue([]),
    };
    const setup = makeWorker({
      scan,
      database: database([
        { id: unknownServerId, status: 'unknown' },
        { id: onlineServerId, status: 'online' },
      ]),
      clients,
    });
    setup.listPending.mockResolvedValue({ items: [], nextCursor: null });

    await (setup.worker as unknown as { fullScan: () => Promise<void> }).fullScan();

    expect(clients.get).toHaveBeenCalledOnce();
    expect(clients.get).toHaveBeenCalledWith(onlineServerId);
    expect(clients.get).not.toHaveBeenCalledWith(unknownServerId);
    expect(scan).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledWith(
      onlineServerId,
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('processes a pending connect intent before excluding its unknown server from scans', async () => {
    const unknownServerId = '00000000-0000-4000-8000-000000000013';
    const expectedFingerprint = 'c'.repeat(64);
    const clients = {
      get: vi.fn().mockResolvedValue(stubIncusClient()),
      listServerIds: vi.fn().mockResolvedValue([]),
    };
    const setup = makeWorker({
      database: database([{ id: unknownServerId, status: 'unknown' }]),
      clients,
    });
    setup.listPending.mockResolvedValue({
      items: [{
        ...intent(),
        kind: 'server.connect',
        resourceType: 'server',
        resourceId: unknownServerId,
        serverId: unknownServerId,
        request: {
          trustTokenRef: '00000000-0000-4000-8000-000000000014',
          expectedServerCertFingerprint: expectedFingerprint,
        },
      }],
      nextCursor: null,
    });

    await (setup.worker as unknown as { fullScan: () => Promise<void> }).fullScan();

    expect(clients.get).toHaveBeenCalledWith(
      unknownServerId,
      { expectedFingerprint },
    );
  });

  it('waits for a server to become online before opening its event watcher', async () => {
    const unknownServerId = '00000000-0000-4000-8000-000000000012';
    const clients = {
      get: vi.fn().mockResolvedValue(stubIncusClient()),
      listServerIds: vi.fn().mockResolvedValue([]),
    };
    const setup = makeWorker({
      database: database([{ id: unknownServerId, status: 'unknown' }]),
      clients,
    });
    const watcher = (setup.worker as unknown as {
      watchServer: (id: string) => Promise<void>;
    }).watchServer(unknownServerId);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(clients.get).not.toHaveBeenCalled();

    const shutdown = setup.worker.onModuleDestroy();
    await expect(shutdown).resolves.toBeUndefined();
    await expect(watcher).resolves.toBeUndefined();
    expect(clients.get).not.toHaveBeenCalled();
  });

  it('waits for an in-flight full scan before shutdown can close the database', async () => {
    const scanStarted = deferred<void>();
    const releaseScan = deferred<void>();
    const scan = vi.fn(async () => {
      scanStarted.resolve();
      await releaseScan.promise;
    });
    const db = database([serverId]);
    const setup = makeWorker({ scan, database: db, clients: {
      get: vi.fn().mockResolvedValue(stubIncusClient()),
      listServerIds: vi.fn().mockResolvedValue([]),
    } });

    setup.worker.onModuleInit();
    await scanStarted.promise;

    const shutdown = setup.worker.onModuleDestroy();
    let shutdownFinished = false;
    void shutdown.then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();

    expect(shutdownFinished).toBe(false);
    expect((setup.worker as unknown as {
      controller: AbortController;
    }).controller.signal.aborted).toBe(true);
    expect(scan).toHaveBeenCalledOnce();

    releaseScan.resolve();
    await shutdown;

    expect(shutdownFinished).toBe(true);
    expect((setup.worker as unknown as { scanning: boolean }).scanning).toBe(false);
  });

  it('handles a driver-close rejection from a background full scan during shutdown', async () => {
    const queryStarted = deferred<void>();
    const serverRows = deferred<Array<{ id: string }>>();
    const scanQuery = {
      select: vi.fn(() => scanQuery),
      where: vi.fn(() => scanQuery),
      execute: vi.fn(async () => {
        queryStarted.resolve();
        return serverRows.promise;
      }),
    };
    const db = {
      ...database(),
      selectFrom: vi.fn(() => scanQuery),
    };
    const setup = makeWorker({
      database: db as unknown as ReturnType<typeof database>,
      clients: {
        get: vi.fn().mockResolvedValue(stubIncusClient()),
        listServerIds: vi.fn().mockResolvedValue([]),
      },
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      setup.worker.onModuleInit();
      await queryStarted.promise;
      const shutdown = setup.worker.onModuleDestroy();
      serverRows.reject(new Error('driver has already been destroyed'));

      await expect(shutdown).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('driver has already been destroyed'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('refreshes pool used/total during a full scan', async () => {
    const poolId = '00000000-0000-4000-8000-000000000021';
    const db = database([serverId], {
      pools: [{
        id: poolId,
        server_id: serverId,
        incus_name: 'default',
        registered: true,
        used_bytes: null,
        total_bytes: null,
      }],
    });
    const getResources = vi.fn().mockResolvedValue({ metadata: {} });
    const getStoragePoolResources = vi.fn().mockResolvedValue({
      metadata: { space: { used: 100, total: 1000 } },
    });
    const setup = makeWorker({
      database: db,
      clients: {
        get: vi.fn().mockResolvedValue({ getResources, getStoragePoolResources }),
        listServerIds: vi.fn().mockResolvedValue([]),
      },
    });
    setup.listPending.mockResolvedValue({ items: [], nextCursor: null });

    await (setup.worker as unknown as { fullScan: () => Promise<void> }).fullScan();

    expect(getResources).toHaveBeenCalledOnce();
    expect(getStoragePoolResources).toHaveBeenCalledWith('default', {
      signal: expect.any(AbortSignal),
    });
    expect(db.pools[0]?.used_bytes).toBe('100');
    expect(db.pools[0]?.total_bytes).toBe('1000');
    expect(db.tableUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'infra.storage_pools',
        values: expect.objectContaining({
          used_bytes: '100',
          total_bytes: '1000',
        }),
      }),
    ]));
  });
});
