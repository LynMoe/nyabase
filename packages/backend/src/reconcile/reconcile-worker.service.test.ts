import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IncusError } from '../incus/index.js';
import { ReconcileWorkerService } from './reconcile-worker.service.js';

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

type BusyStrike = {
  resource_type: string;
  resource_id: string;
  observed_at: Date;
};

function stubIncusClient(extra: Record<string, unknown> = {}) {
  return {
    getResources: vi.fn().mockResolvedValue({ metadata: {} }),
    ...extra,
  };
}

/** Only the busy-strike table is the engine's own; everything else is a domain port. */
function database() {
  const strikes: BusyStrike[] = [];
  const selectBuilder = () => {
    const filters: Array<{ column: string; operator: string; value: unknown }> = [];
    const builder = {
      select: vi.fn(() => builder),
      where: vi.fn((column: string, operator: string, value: unknown) => {
        filters.push({ column, operator, value });
        return builder;
      }),
      execute: vi.fn(async () => strikes.filter((row) => filters.every((filter) => {
        const actual = row[filter.column as keyof BusyStrike];
        if (filter.operator === '>=' && actual instanceof Date && filter.value instanceof Date) {
          return actual.getTime() >= filter.value.getTime();
        }
        return actual === filter.value;
      }))),
    };
    return builder;
  };
  return {
    strikes,
    insertInto: vi.fn(() => ({
      values: vi.fn((value: BusyStrike) => ({
        execute: vi.fn(async () => {
          strikes.push({
            resource_type: value.resource_type,
            resource_id: value.resource_id,
            observed_at: value.observed_at instanceof Date
              ? value.observed_at
              : new Date(value.observed_at),
          });
        }),
      })),
    })),
    deleteFrom: vi.fn(() => {
      const filters: Array<{ column: string; value: unknown }> = [];
      const builder = {
        where: vi.fn((column: string, _operator: string, value: unknown) => {
          filters.push({ column, value });
          return builder;
        }),
        execute: vi.fn(async () => {
          const remaining = strikes.filter((row) => !filters.every((filter) => (
            String(row[filter.column as keyof BusyStrike]) === String(filter.value)
          )));
          strikes.splice(0, strikes.length, ...remaining);
        }),
      };
      return builder;
    }),
    selectFrom: vi.fn(() => selectBuilder()),
  };
}

function reconcilerFake(overrides: {
  reconcile?: () => Promise<unknown>;
  scan?: () => Promise<void>;
  needsAttention?: boolean;
} = {}) {
  return {
    resourceType: 'container',
    supports: () => true,
    reconcile: overrides.reconcile ?? vi.fn().mockResolvedValue({
      outcome: 'succeeded',
      observedGeneration: 1,
    }),
    ...(overrides.scan ? { scan: overrides.scan } : {}),
    needsAttention: vi.fn().mockResolvedValue(overrides.needsAttention ?? false),
    markSucceeded: vi.fn().mockResolvedValue(undefined),
    markFailure: vi.fn().mockResolvedValue(undefined),
  };
}

function serverHealthFake(overrides: {
  onlineServerIds?: string[];
  isServerOnline?: boolean;
  listOnlineServerIds?: () => Promise<string[]>;
} = {}) {
  return {
    isCurrentServerIntent: vi.fn().mockResolvedValue(true),
    markServer: vi.fn().mockResolvedValue(undefined),
    isServerOnline: vi.fn().mockResolvedValue(overrides.isServerOnline ?? true),
    listOnlineServerIds: overrides.listOnlineServerIds
      ?? vi.fn().mockResolvedValue(overrides.onlineServerIds ?? []),
    refreshInventory: vi.fn().mockResolvedValue(undefined),
  };
}

function makeWorker(overrides: {
  reconcile?: () => Promise<unknown>;
  scan?: () => Promise<void>;
  wake?: { onWake: (listener: (payload: { reason: string }) => void) => () => void; wake: () => void };
  database?: ReturnType<typeof database>;
  clients?: { get: ReturnType<typeof vi.fn>; listServerIds: ReturnType<typeof vi.fn> };
  reconciler?: ReturnType<typeof reconcilerFake>;
  serverHealth?: ReturnType<typeof serverHealthFake>;
  needsAttention?: boolean;
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
  const reconciler = overrides.reconciler ?? reconcilerFake({
    reconcile: overrides.reconcile,
    scan: overrides.scan,
    needsAttention: overrides.needsAttention,
  });
  const serverHealth = overrides.serverHealth ?? serverHealthFake();
  const registry = {
    all: () => [reconciler],
    forIntent: () => reconciler,
    forResource: () => reconciler,
    serverHealth: () => serverHealth,
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
  const worker = new ReconcileWorkerService(
    intents as never,
    claims as never,
    registry as never,
    clients as never,
    wake as never,
    (overrides.database ?? database()) as never,
  );
  return {
    worker,
    intents,
    claims,
    reconciler,
    serverHealth,
    wakeListeners,
    clients,
    listPending,
  };
}

describe('ReconcileWorkerService', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('persists five busy strikes and trips the breaker on a fresh worker', async () => {
    const db = database();
    const reconciler = reconcilerFake({
      reconcile: vi.fn().mockRejectedValue(new IncusError('INSTANCE_BUSY', 'retry', { action: 'start' })),
    });
    const first = makeWorker({ reconciler, database: db });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await first.worker.runOnce();
    }
    expect(reconciler.markFailure).not.toHaveBeenCalled();
    expect(db.strikes).toHaveLength(4);

    const second = makeWorker({ reconciler, database: db });
    await second.worker.runOnce();

    expect(db.strikes).toHaveLength(5);
    expect(reconciler.markFailure).toHaveBeenCalledOnce();
    expect(reconciler.markFailure).toHaveBeenCalledWith(
      resourceId,
      expect.objectContaining({ code: 'RESOURCE_NEEDS_ATTENTION' }),
      true,
    );
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
    const setup = makeWorker({ needsAttention: true });
    await setup.worker.runOnce();
    expect(setup.claims.claim).not.toHaveBeenCalled();
    expect(setup.reconciler.reconcile).not.toHaveBeenCalled();
    expect(setup.clients.get).not.toHaveBeenCalled();
  });

  it('still processes an explicit retry when the resource needs attention', async () => {
    const setup = makeWorker({ needsAttention: true });
    setup.listPending.mockResolvedValue({
      items: [{
        ...intent(),
        kind: 'volume.resize',
        resourceType: 'volume',
        request: { retryOf: '00000000-0000-4000-8000-000000000099', operation: 'resize' },
      }],
      nextCursor: null,
    });
    await setup.worker.runOnce();
    expect(setup.claims.claim).toHaveBeenCalled();
    expect(setup.reconciler.reconcile).toHaveBeenCalled();
  });

  it.each(['SSH_DAEMON_PENDING', 'GUEST_NOT_READY'] as const)(
    'does not count %s as Incus lock busy strikes',
    async (code) => {
      const db = database();
      const reconciler = reconcilerFake({
        reconcile: vi.fn().mockRejectedValue(new IncusError(code, 'retry', {})),
      });
      const setup = makeWorker({ reconciler, database: db });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await setup.worker.runOnce();
      }
      expect(reconciler.markFailure).not.toHaveBeenCalled();
      expect(db.strikes).toHaveLength(0);
      expect(setup.intents.scheduleRetry).toHaveBeenCalledTimes(5);
    },
  );

  it('records a reconcile success through the owning reconciler', async () => {
    const setup = makeWorker();
    await setup.worker.runOnce();
    expect(setup.reconciler.markSucceeded).toHaveBeenCalledWith(resourceId, 1);
    expect(setup.serverHealth.markServer).toHaveBeenCalledWith(
      serverId,
      'online',
      undefined,
      undefined,
    );
  });

  it('records a managed failure through the owning reconciler without parking the resource', async () => {
    const failure = { code: 'VOLUME_REQUIRES_DETACH', message: 'still attached', details: {} };
    const setup = makeWorker({
      reconcile: vi.fn().mockResolvedValue({ outcome: 'failed', failure }),
    });
    await setup.worker.runOnce();
    expect(setup.reconciler.markFailure).toHaveBeenCalledWith(resourceId, failure, false);
  });

  it('still processes a deleting volume even when needs_attention is set', async () => {
    const setup = makeWorker({ needsAttention: false });
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

  it('settles a superseded server intent as stale without reconciling it', async () => {
    const serverHealth = serverHealthFake();
    serverHealth.isCurrentServerIntent.mockResolvedValue(false);
    const setup = makeWorker({ serverHealth });
    await setup.worker.runOnce();
    expect(setup.reconciler.reconcile).not.toHaveBeenCalled();
    expect(setup.intents.settleForObservedGeneration).toHaveBeenCalledWith(
      'container',
      resourceId,
      1,
      { outcome: 'succeeded', placementServerId: serverId },
    );
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

  it.each(['SERVER_UNREACHABLE', 'INCUS_TIMEOUT'] as const)(
    'keeps %s retryable and marks the server unreachable',
    async (code) => {
      const setup = makeWorker({
        reconcile: vi.fn().mockRejectedValue(new IncusError(code, 'retry', {})),
      });

      await setup.worker.runOnce();

      expect(setup.intents.scheduleRetry).toHaveBeenCalledOnce();
      expect(setup.serverHealth.markServer).toHaveBeenCalledWith(
        serverId,
        'unreachable',
        expect.any(String),
        undefined,
      );
    },
  );

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

  it('starts the reconciliation loop on bootstrap and cleans it up on destroy', async () => {
    const setup = makeWorker({});
    setup.worker.onApplicationBootstrap();
    expect((setup.worker as unknown as { scanTimer?: unknown }).scanTimer).toBeDefined();
    await setup.worker.onModuleDestroy();
    expect((setup.worker as unknown as { scanTimer?: unknown }).scanTimer).toBeUndefined();
  });

  it('wakes immediately for Incus events and still runs a periodic full scan', async () => {
    vi.useFakeTimers();
    const scan = vi.fn().mockResolvedValue(undefined);
    const setup = makeWorker({ scan, serverHealth: serverHealthFake({ onlineServerIds: [serverId] }) });
    setup.worker.onApplicationBootstrap();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());

    setup.wakeListeners[0]?.({ reason: 'event' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(setup.listPending).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    await setup.worker.onModuleDestroy();
  });

  it('scans only servers the health port reports online and refreshes their inventory', async () => {
    const unknownServerId = '00000000-0000-4000-8000-000000000010';
    const onlineServerId = '00000000-0000-4000-8000-000000000011';
    const scan = vi.fn().mockResolvedValue(undefined);
    const clients = {
      get: vi.fn().mockResolvedValue(stubIncusClient()),
      listServerIds: vi.fn().mockResolvedValue([]),
    };
    const serverHealth = serverHealthFake({ onlineServerIds: [onlineServerId] });
    const setup = makeWorker({ scan, serverHealth, clients });
    setup.listPending.mockResolvedValue({ items: [], nextCursor: null });

    await (setup.worker as unknown as { fullScan: () => Promise<void> }).fullScan();

    expect(clients.get).toHaveBeenCalledOnce();
    expect(clients.get).toHaveBeenCalledWith(onlineServerId);
    expect(clients.get).not.toHaveBeenCalledWith(unknownServerId);
    expect(serverHealth.refreshInventory).toHaveBeenCalledWith(
      onlineServerId,
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(scan).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledWith(
      onlineServerId,
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('keeps scanning when inventory refresh fails for one server', async () => {
    const scan = vi.fn().mockResolvedValue(undefined);
    const serverHealth = serverHealthFake({ onlineServerIds: [serverId] });
    serverHealth.refreshInventory.mockRejectedValue(new Error('inventory unavailable'));
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const setup = makeWorker({ scan, serverHealth });
      setup.listPending.mockResolvedValue({ items: [], nextCursor: null });

      await (setup.worker as unknown as { fullScan: () => Promise<void> }).fullScan();

      expect(scan).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Inventory refresh failed'));
    } finally {
      error.mockRestore();
    }
  });

  it('processes a pending connect intent before excluding its unknown server from scans', async () => {
    const unknownServerId = '00000000-0000-4000-8000-000000000013';
    const expectedFingerprint = 'c'.repeat(64);
    const clients = {
      get: vi.fn().mockResolvedValue(stubIncusClient()),
      listServerIds: vi.fn().mockResolvedValue([]),
    };
    const setup = makeWorker({ clients });
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
      serverHealth: serverHealthFake({ isServerOnline: false }),
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
    const setup = makeWorker({
      scan,
      serverHealth: serverHealthFake({ onlineServerIds: [serverId] }),
    });

    setup.worker.onApplicationBootstrap();
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
    const serverRows = deferred<string[]>();
    const serverHealth = serverHealthFake({
      listOnlineServerIds: async () => {
        queryStarted.resolve();
        return serverRows.promise;
      },
    });
    const setup = makeWorker({ serverHealth });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      setup.worker.onApplicationBootstrap();
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
});
