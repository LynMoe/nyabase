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
    targetRevision: 1,
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

function stubIncusClient(extra: Record<string, unknown> = {}) {
  return {
    getResources: vi.fn().mockResolvedValue({ metadata: {} }),
    ...extra,
  };
}

/**
 * Busy streaks live on the intent row, so two workers share them through the
 * repository. This stand-in keeps one streak per intent id the same way.
 */
function busyLedger() {
  const attempts = new Map<string, number>();
  return {
    attempts,
    recordBusyAttempt: vi.fn(async (intentId: string) => {
      const next = (attempts.get(intentId) ?? 0) + 1;
      attempts.set(intentId, next);
      return next;
    }),
    resetBusyAttempts: vi.fn(async (intentId: string) => {
      attempts.delete(intentId);
    }),
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
      observedRevision: 1,
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
  busy?: ReturnType<typeof busyLedger>;
  clients?: { get: ReturnType<typeof vi.fn>; listServerIds: ReturnType<typeof vi.fn> };
  reconciler?: ReturnType<typeof reconcilerFake>;
  serverHealth?: ReturnType<typeof serverHealthFake>;
  needsAttention?: boolean;
} = {}) {
  const listPending = vi.fn().mockResolvedValue({
    items: [intent()],
    nextCursor: null,
  });
  const busy = overrides.busy ?? busyLedger();
  const intents = {
    listPending,
    recordBusyAttempt: busy.recordBusyAttempt,
    resetBusyAttempts: busy.resetBusyAttempts,
    scheduleRetry: vi.fn().mockResolvedValue(undefined),
    settleForObservedRevision: vi.fn().mockResolvedValue(undefined),
    settleOne: vi.fn().mockResolvedValue(true),
    nextRetryAt: vi.fn().mockResolvedValue(null),
    pruneSettled: vi.fn().mockResolvedValue(0),
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
  );
  return {
    worker,
    busy,
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
    const busy = busyLedger();
    const reconciler = reconcilerFake({
      reconcile: vi.fn().mockRejectedValue(new IncusError('INSTANCE_BUSY', 'retry', { action: 'start' })),
    });
    const first = makeWorker({ reconciler, busy });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await first.worker.runOnce();
    }
    expect(reconciler.markFailure).not.toHaveBeenCalled();
    expect([...busy.attempts.values()]).toEqual([4]);

    const second = makeWorker({ reconciler, busy });
    await second.worker.runOnce();

    expect([...busy.attempts.values()]).toEqual([5]);
    expect(busy.recordBusyAttempt).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000003',
      300_000,
    );
    expect(reconciler.markFailure).toHaveBeenCalledOnce();
    expect(reconciler.markFailure).toHaveBeenCalledWith(
      resourceId,
      expect.objectContaining({ code: 'RESOURCE_NEEDS_ATTENTION' }),
      true,
    );
    expect(second.intents.settleForObservedRevision).toHaveBeenCalledWith(
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

  it('ends the busy streak when the intent is retried for another reason', async () => {
    const busy = new IncusError('INSTANCE_BUSY', 'retry', { action: 'start' });
    const reconcile = vi.fn()
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(new IncusError('GUEST_NOT_READY', 'retry', {}))
      .mockRejectedValue(busy);
    const reconciler = reconcilerFake({ reconcile });
    const setup = makeWorker({ reconciler });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await setup.worker.runOnce();
    }
    // 3 busy, reset, 4 busy: five busy strikes in total but never five in a row.
    expect(setup.busy.resetBusyAttempts).toHaveBeenCalledOnce();
    expect([...setup.busy.attempts.values()]).toEqual([4]);
    expect(reconciler.markFailure).not.toHaveBeenCalled();
    expect(setup.intents.scheduleRetry).toHaveBeenCalledTimes(8);
  });

  it.each(['SERVER_UNREACHABLE', 'INCUS_TIMEOUT'] as const)(
    'does not count or reset on %s',
    async (code) => {
      const busy = new IncusError('INSTANCE_BUSY', 'retry', { action: 'start' });
      const reconcile = vi.fn()
        .mockRejectedValueOnce(busy)
        .mockRejectedValueOnce(busy)
        .mockRejectedValueOnce(new IncusError(code, 'retry', {}))
        .mockRejectedValue(busy);
      const reconciler = reconcilerFake({ reconcile });
      const setup = makeWorker({ reconciler });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await setup.worker.runOnce();
      }
      expect(setup.busy.recordBusyAttempt).toHaveBeenCalledTimes(5);
      expect(setup.busy.resetBusyAttempts).not.toHaveBeenCalled();
      // Five busy strikes around one unreachable attempt trip the breaker on the sixth run.
      expect(reconciler.markFailure).toHaveBeenCalledOnce();
      expect(reconciler.markFailure).toHaveBeenCalledWith(
        resourceId,
        expect.objectContaining({ code: 'RESOURCE_NEEDS_ATTENTION' }),
        true,
      );
    },
  );

  it('lets a reconciler settle its own intents instead of the default sweep', async () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const reconciler = { ...reconcilerFake(), settle };
    const setup = makeWorker({ reconciler: reconciler as never });
    await setup.worker.runOnce();
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ id: '00000000-0000-4000-8000-000000000003' }),
      1,
      expect.objectContaining({ outcome: 'succeeded', placementServerId: serverId }),
    );
    expect(setup.intents.settleForObservedRevision).not.toHaveBeenCalled();
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

  it('still processes an intent marked despiteAttention when the resource needs attention', async () => {
    const setup = makeWorker({ needsAttention: true });
    setup.listPending.mockResolvedValue({
      items: [{
        ...intent(),
        request: {
          operation: 'detach_volume',
          attachmentId: '00000000-0000-4000-8000-000000000009',
          despiteAttention: true,
        },
      }],
      nextCursor: null,
    });
    await setup.worker.runOnce();
    expect(setup.claims.claim).toHaveBeenCalled();
    expect(setup.reconciler.reconcile).toHaveBeenCalled();
    expect(setup.reconciler.markSucceeded).toHaveBeenCalledWith(resourceId, 1);
  });

  it.each(['SSH_DAEMON_PENDING', 'GUEST_NOT_READY'] as const)(
    'does not count %s as Incus lock busy strikes',
    async (code) => {
      const reconciler = reconcilerFake({
        reconcile: vi.fn().mockRejectedValue(new IncusError(code, 'retry', {})),
      });
      const setup = makeWorker({ reconciler });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await setup.worker.runOnce();
      }
      expect(reconciler.markFailure).not.toHaveBeenCalled();
      expect(setup.busy.recordBusyAttempt).not.toHaveBeenCalled();
      expect(setup.intents.scheduleRetry).toHaveBeenCalledTimes(5);
    },
  );

  it('records a reconcile success through the owning reconciler', async () => {
    const setup = makeWorker({
      reconcile: vi.fn(async (context: { client: { getResources: () => Promise<unknown> } }) => {
        await context.client.getResources();
        return { outcome: 'succeeded', observedRevision: 1 };
      }) as never,
    });
    await setup.worker.runOnce();
    expect(setup.reconciler.markSucceeded).toHaveBeenCalledWith(resourceId, 1);
    expect(setup.serverHealth.markServer).toHaveBeenCalledWith(
      serverId,
      'online',
      undefined,
      undefined,
    );
  });

  it('never marks a server online from a pass that made no Incus call', async () => {
    const quiet = makeWorker();
    await quiet.worker.runOnce();
    expect(quiet.reconciler.markSucceeded).toHaveBeenCalledWith(resourceId, 1);
    expect(quiet.serverHealth.markServer).not.toHaveBeenCalled();

    const stale = makeWorker({
      reconcile: vi.fn().mockResolvedValue({ outcome: 'succeeded', observedRevision: 1, stale: true }),
    });
    await stale.worker.runOnce();
    expect(stale.reconciler.markSucceeded).not.toHaveBeenCalled();
    expect(stale.intents.settleForObservedRevision).toHaveBeenCalled();
    expect(stale.serverHealth.markServer).not.toHaveBeenCalled();

    const unreachable = makeWorker({
      reconcile: vi.fn(async (context: { client: { getResources: () => Promise<unknown> } }) => {
        await context.client.getResources().catch(() => undefined);
        return { outcome: 'succeeded', observedRevision: 1 };
      }) as never,
      clients: {
        get: vi.fn().mockResolvedValue(stubIncusClient({
          getResources: vi.fn().mockRejectedValue(new IncusError('SERVER_UNREACHABLE', 'retry')),
        })),
        listServerIds: vi.fn().mockResolvedValue([]),
      },
    });
    await unreachable.worker.runOnce();
    expect(unreachable.serverHealth.markServer).not.toHaveBeenCalled();
  });

  it('settles a stale failed outcome as failed without recording a resource failure', async () => {
    const failure = { code: 'RESTART_SUPERSEDED', message: 'superseded', details: {} };
    const setup = makeWorker({
      reconcile: vi.fn().mockResolvedValue({ outcome: 'failed', failure, stale: true }),
    });
    await setup.worker.runOnce();
    expect(setup.reconciler.markFailure).not.toHaveBeenCalled();
    expect(setup.intents.settleForObservedRevision).toHaveBeenCalledWith(
      'container',
      resourceId,
      1,
      expect.objectContaining({ outcome: 'failed', failure }),
    );
  });

  it('reruns a pass requested while one is in flight instead of dropping it', async () => {
    const gate = deferred<void>();
    const setup = makeWorker({
      reconcile: vi.fn(async () => {
        await gate.promise;
        return { outcome: 'succeeded', observedRevision: 1 };
      }),
    });
    const first = setup.worker.runOnce();
    await vi.waitFor(() => expect(setup.listPending).toHaveBeenCalledTimes(1));
    const second = setup.worker.runOnce();
    // The pass waiting on the slow intent lists the queue again at once.
    await vi.waitFor(() => expect(setup.listPending).toHaveBeenCalledTimes(2));
    gate.resolve();
    await Promise.all([first, second]);
    expect(setup.listPending.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('pages past a full page, excluding intents it already handled', async () => {
    const setup = makeWorker();
    const page = (offset: number, count: number) => Array.from({ length: count }, (_, index) => ({
      ...intent(),
      id: `00000000-0000-4000-8000-${String(offset + index).padStart(12, '0')}`,
    }));
    setup.listPending
      .mockResolvedValueOnce({ items: page(0, 100), nextCursor: null })
      .mockResolvedValueOnce({ items: page(100, 3), nextCursor: null })
      .mockResolvedValue({ items: [], nextCursor: null });
    await setup.worker.runOnce();
    const second = setup.listPending.mock.calls[1]![0] as { excludeIds: string[] };
    expect(second.excludeIds).toHaveLength(100);
    // One more look once the resource's chain went idle.
    expect(setup.listPending).toHaveBeenCalledTimes(3);
    expect(setup.claims.claim).toHaveBeenCalledTimes(103);
  });

  it('runs other resources while one intent is slow, but never one resource twice at once', async () => {
    const gate = deferred<void>();
    const running = new Map<string, number>();
    let overlap = false;
    const order: string[] = [];
    const reconcile = vi.fn(async ({ intent: current }: { intent: { id: string; resourceId: string } }) => {
      const active = (running.get(current.resourceId) ?? 0) + 1;
      running.set(current.resourceId, active);
      if (active > 1) overlap = true;
      order.push(current.id);
      if (current.id === 'slow-1') await gate.promise;
      running.set(current.resourceId, active - 1);
      return { outcome: 'succeeded', observedRevision: 1 };
    });
    const setup = makeWorker({ reconcile: reconcile as never });
    const other = '00000000-0000-4000-8000-0000000000aa';
    setup.listPending
      .mockResolvedValueOnce({
        items: [
          { ...intent(), id: 'slow-1' },
          { ...intent(), id: 'slow-2' },
          { ...intent(), id: 'fast-1', resourceId: other },
        ],
        nextCursor: null,
      })
      .mockResolvedValue({ items: [], nextCursor: null });

    const pass = setup.worker.runOnce();
    await vi.waitFor(() => expect(order).toEqual(['slow-1', 'fast-1']));
    gate.resolve();
    await pass;

    expect(order).toEqual(['slow-1', 'fast-1', 'slow-2']);
    expect(overlap).toBe(false);
  });

  it('caps how many resources of one server reconcile at once', async () => {
    const gate = deferred<void>();
    let active = 0;
    let peak = 0;
    const reconcile = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return { outcome: 'succeeded', observedRevision: 1 };
    });
    const setup = makeWorker({ reconcile });
    const items = Array.from({ length: 6 }, (_, index) => ({
      ...intent(),
      id: `intent-${index}`,
      resourceId: `00000000-0000-4000-8000-00000000010${index}`,
    }));
    let listed = false;
    setup.listPending.mockImplementation(async ({ excludeIds }: { excludeIds: string[] }) => {
      if (!listed) {
        listed = true;
        return { items, nextCursor: null };
      }
      return { items: items.filter((item) => !excludeIds.includes(item.id)), nextCursor: null };
    });

    const pass = setup.worker.runOnce();
    await vi.waitFor(() => expect(active).toBe(4));
    gate.resolve();
    await pass;

    expect(peak).toBe(4);
    expect(reconcile).toHaveBeenCalledTimes(6);
  });

  it('does not spin on an intent that stays pending after it was tried', async () => {
    const setup = makeWorker({ needsAttention: true });
    await setup.worker.runOnce();
    // Listed, tried (parked resource: left pending), then one look after its chain went idle.
    expect(setup.listPending).toHaveBeenCalledTimes(2);
    expect(setup.claims.claim).not.toHaveBeenCalled();
  });

  it('arms a timer for the earliest scheduled retry', async () => {
    vi.useFakeTimers();
    try {
      const setup = makeWorker();
      setup.listPending.mockResolvedValue({ items: [], nextCursor: null });
      setup.intents.nextRetryAt.mockResolvedValueOnce(new Date(Date.now() + 2_000));
      await setup.worker.runOnce();
      expect(setup.listPending).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(setup.listPending).toHaveBeenCalledTimes(2);
      await setup.worker.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts an event watcher for a server that connects after bootstrap', async () => {
    const clients = {
      get: vi.fn().mockResolvedValue(stubIncusClient()),
      listServerIds: vi.fn().mockResolvedValue([]),
    };
    const serverHealth = serverHealthFake({ isServerOnline: false });
    const setup = makeWorker({ clients, serverHealth });
    setup.worker.onApplicationBootstrap();
    await vi.waitFor(() => expect(clients.listServerIds).toHaveBeenCalled());
    for (const listener of setup.wakeListeners) listener({ reason: 'reconnect', serverId } as never);
    await vi.waitFor(() => expect(serverHealth.isServerOnline).toHaveBeenCalledWith(serverId));
    await setup.worker.onModuleDestroy();
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
    expect(setup.intents.settleForObservedRevision).toHaveBeenCalledWith(
      'container',
      resourceId,
      1,
      { outcome: 'succeeded', placementServerId: serverId },
    );
  });

  it('sweeps every pending intent up to the observed revision by default', async () => {
    const setup = makeWorker();
    await setup.worker.runOnce();
    expect(setup.intents.settleForObservedRevision).toHaveBeenCalledOnce();
    expect(setup.intents.settleOne).not.toHaveBeenCalled();
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
