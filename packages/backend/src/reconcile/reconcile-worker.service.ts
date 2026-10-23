import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  IncusError,
  subscribeIncusEvents,
  type IncusClientPort,
} from '../incus/index.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import {
  IntentRepository,
  runsDespiteAttention,
  type IntentRecord,
  type IntentFailure,
  type PhysicalSettlement,
} from './intent.repository.js';
import type { ReconcileOutcome } from './managed-reconciler.js';
import { ReconcilerRegistry } from './reconciler-registry.service.js';
import {
  NO_PLACEMENT_SERVER_ID,
  VOLUME_DESTROY_PLACEMENT_ID,
  ReconcileClaimRepository,
} from './reconcile-claim.repository.js';
import { ReconcileWakeService } from './reconcile-wake.service.js';
import { ResourceChains } from './resource-chains.js';
import {
  asFailure,
  boundedErrorMessage,
  boundedRetryDelay,
  BUSY_STRIKE_LIMIT,
  BUSY_STRIKE_WINDOW_MS,
  INTENT_PRUNE_INTERVAL_MS,
  INTENT_PRUNE_MAX_BATCHES,
  INTENT_RETENTION_MS,
  isAbortLikeError,
  isClosedDatabaseDriverError,
  isIncusError,
  isIncusInstanceLockBusy,
  QUEUE_MAX_PAGES,
  QUEUE_PAGE_SIZE,
  trackedClient,
} from './reconcile-worker-support.js';

@Injectable()
export class ReconcileWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileWorkerService.name);
  private readonly workerId = `reconcile-${process.pid}-${Math.random().toString(16).slice(2)}`;
  private readonly controller = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly shutdownWarnings = new Set<string>();
  private unsubscribeWake?: () => void;
  private scanTimer?: NodeJS.Timeout;
  private wakeTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private retryTimerAt = Number.POSITIVE_INFINITY;
  private running = false;
  private rerunRequested = false;
  private lastPruneAt = 0;
  private scanning = false;
  private rescanRequested = false;
  private started = false;
  private stopping = false;
  private runPromise?: Promise<void>;
  private scanPromise?: Promise<void>;
  private destroyPromise?: Promise<void>;
  /** Servers with a running event watcher. */
  private readonly eventWatchers = new Set<string>();
  private readonly chains = new ResourceChains();
  /** A wake arrived during the pass: intents it already tried get one more go. */
  private retryAttempted = false;

  constructor(
    private readonly intents: IntentRepository,
    private readonly claims: ReconcileClaimRepository,
    private readonly registry: ReconcilerRegistry,
    @Inject(INCUS_CLIENT_FACTORY)
    private readonly clients: IncusClientFactory,
    private readonly wake: ReconcileWakeService,
  ) {}

  // Starts after every module's onModuleInit has registered its reconciler.
  onApplicationBootstrap(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.unsubscribeWake = this.wake.onWake((payload) => {
      if (payload.reason === 'scan') {
        // Desired state outside any one intent changed (grants, reserved CPUs, limits).
        this.requestFullScan();
        return;
      }
      if (payload.reason === 'reconnect' && payload.serverId) {
        // A server enrolled after bootstrap gets its event watcher on first connect.
        this.ensureEventWatcher(payload.serverId);
      }
      if (payload.reason === 'event' || payload.reason === 'reconnect') {
        this.scheduleWake(0);
      } else {
        this.scheduleWake(10);
      }
    });
    this.scanTimer = setInterval(() => {
      this.startBackgroundFullScan();
    }, 60_000);
    this.scanTimer.unref?.();
    this.startBackgroundFullScan();
    const watcherStartup = this.trackOperation(this.startEventWatchers());
    this.observeBackground(watcherStartup, 'Reconcile event watcher startup');
  }

  onModuleDestroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.stopping = true;
    this.controller.abort();
    this.chains.signal();
    try {
      this.unsubscribeWake?.();
    } catch (error) {
      this.logger.warn(`Reconcile wake unsubscribe failed: ${boundedErrorMessage(error)}`);
    } finally {
      this.unsubscribeWake = undefined;
    }
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.scanTimer = undefined;
    this.wakeTimer = undefined;
    this.retryTimer = undefined;
    this.destroyPromise = this.drainInFlight().then(() => {
      this.eventWatchers.clear();
    });
    return this.destroyPromise;
  }

  /**
   * Drain the ready queue. A call while a pass is running does not get lost:
   * the running pass makes one more round before its promise resolves.
   */
  runOnce(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.runPromise) {
      this.rerunRequested = true;
      this.retryAttempted = true;
      // A pass waiting on slow work looks at the queue again right away.
      this.chains.signal();
      return this.runPromise;
    }
    this.running = true;
    const operation = this.trackOperation(this.executeRunOnce());
    this.runPromise = operation;
    void operation.then(
      () => this.finishRun(operation),
      () => this.finishRun(operation),
    );
    return operation;
  }

  private scheduleWake(delayMs: number): void {
    if (this.wakeTimer || this.stopping || this.controller.signal.aborted) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.startBackgroundRunOnce();
    }, delayMs);
    this.wakeTimer.unref?.();
  }

  /** Wake the queue when the earliest scheduled retry falls due. */
  private async armRetryTimer(): Promise<void> {
    if (this.stopping || this.controller.signal.aborted) return;
    const next = await this.intents.nextRetryAt();
    if (!next) return;
    const at = next.getTime();
    if (this.retryTimer && this.retryTimerAt <= at) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    // Capped so a far-off retry is re-armed by the next pass instead of overflowing setTimeout.
    const delayMs = Math.min(Math.max(0, at - Date.now()) + 5, 60_000);
    this.retryTimerAt = Date.now() + delayMs;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryTimerAt = Number.POSITIVE_INFINITY;
      this.startBackgroundRunOnce();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private startBackgroundFullScan(): void {
    if (this.stopping || this.controller.signal.aborted) return;
    this.observeBackground(this.fullScan(), 'Reconcile full scan');
  }

  private startBackgroundRunOnce(): void {
    if (this.stopping || this.controller.signal.aborted) return;
    this.observeBackground(this.runOnce(), 'Reconcile queue pass');
  }

  private observeBackground(operation: Promise<unknown>, context: string): void {
    void operation.catch((error: unknown) => {
      if (this.isShutdownOrDriverClose(error)) {
        this.warnShutdown(context, error);
        return;
      }
      this.logger.error(`${context} failed: ${boundedErrorMessage(error)}`);
    });
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation);
    const remove = (): void => {
      this.inFlight.delete(operation);
    };
    void operation.then(remove, remove);
    return operation;
  }

  private async drainInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /**
   * Resolves once the queue is drained and nothing it started still runs.
   * While slow work runs, any finished chain, wake or due retry makes it list
   * the queue again, so one slow Incus call never holds up the others.
   */
  private async executeRunOnce(): Promise<void> {
    // Intents handed to a chain in this pass. One left pending (parked
    // resource, claim held elsewhere) is not retried when a chain finishes,
    // only after a wake, as a fresh pass would.
    const attempted = new Set<string>();
    try {
      do {
        this.rerunRequested = false;
        if (this.retryAttempted) {
          this.retryAttempted = false;
          attempted.clear();
        }
        if (this.controller.signal.aborted) return;
        await this.claims.reapExpired();
        if (await this.drainReadyQueue(attempted)) {
          this.rerunRequested = true;
          continue;
        }
        await this.armRetryTimer();
        if (this.chains.size > 0) {
          await this.chains.nextChange();
          this.rerunRequested = true;
        }
      } while (this.rerunRequested && !this.controller.signal.aborted);
    } catch (error) {
      if (this.isShutdownOrDriverClose(error)) {
        this.warnShutdown('Reconcile queue pass', error);
        return;
      }
      throw error;
    }
  }

  /**
   * Hand ready intents to their resource chains page by page. Intents skipped
   * in this pass (server at its concurrency limit) are excluded from later
   * pages so they cannot starve the rest; the next pass picks them up. Returns
   * true when the page budget ran out with work left.
   */
  private async drainReadyQueue(attempted: Set<string>): Promise<boolean> {
    const seen = new Set<string>();
    for (let page = 0; page < QUEUE_MAX_PAGES; page += 1) {
      const { items } = await this.intents.listPending({
        limit: QUEUE_PAGE_SIZE,
        readyAt: new Date(),
        excludeIds: [...new Set([...seen, ...attempted, ...this.chains.queuedIds])],
      });
      for (const intent of items) {
        if (this.controller.signal.aborted) return false;
        if (seen.has(intent.id) || attempted.has(intent.id) || this.chains.queuedIds.has(intent.id)) continue;
        seen.add(intent.id);
        while (this.chains.full && !this.chains.admits(intent)) {
          await this.chains.anyIdle();
          if (this.controller.signal.aborted) return false;
        }
        if (!this.chains.admits(intent)) continue;
        attempted.add(intent.id);
        this.enqueue(intent);
      }
      if (items.length < QUEUE_PAGE_SIZE) return false;
    }
    return true;
  }

  private enqueue(intent: IntentRecord): void {
    const tail = this.chains.enqueue(intent, () => this.processIntent(intent).catch((error: unknown) => {
      if (this.isShutdownOrDriverClose(error)) {
        this.warnShutdown(`Reconcile intent ${intent.id}`, error);
        return;
      }
      this.logger.error(`Reconcile intent ${intent.id} failed: ${boundedErrorMessage(error)}`);
    }));
    this.trackOperation(tail);
  }

  private finishRun(operation: Promise<void>): void {
    if (this.runPromise !== operation) return;
    this.runPromise = undefined;
    this.running = false;
    if (this.rerunRequested) {
      this.rerunRequested = false;
      this.startBackgroundRunOnce();
    }
  }

  private async processIntent(intent: IntentRecord): Promise<void> {
    if (this.controller.signal.aborted) return;
    // A parked resource waits for an operator, except for an explicit retry
    // or an enforcement that must not wait (`runsDespiteAttention`).
    if (
      !runsDespiteAttention(intent.request)
      && await this.registry.forResource(intent.resourceType)?.needsAttention(intent.resourceId)
    ) {
      return;
    }
    const serverId = intent.serverId;
    const placementServerId = intent.kind === 'volume.destroy'
      ? VOLUME_DESTROY_PLACEMENT_ID
      : (intent.serverId ?? NO_PLACEMENT_SERVER_ID);
    const claim = await this.claims.claim({
      resourceType: intent.resourceType,
      resourceId: intent.resourceId,
      placementServerId,
      serverId,
      workerId: this.workerId,
    });
    if (!claim) return;

    await this.claims.withLease(claim, async (lease) => {
      let client: IncusClientPort | undefined;
      let tracked: ReturnType<typeof trackedClient> | undefined;
      try {
        if (!await this.isCurrentServerIntent(intent)) {
          await this.settleStaleIntent(intent);
          return;
        }
        if (serverId) {
          tracked = trackedClient(await this.clients.get(serverId));
          client = tracked.client;
        }
        const reconciler = this.registry.forIntent(intent);
        if (!reconciler) {
          await this.settleFailure(intent, {
            code: 'RECONCILER_UNAVAILABLE',
            message: `No reconciler is registered for ${intent.kind}`,
            details: {},
          });
          return;
        }
        const outcome = await reconciler.reconcile({
          intent,
          client,
          claim,
          lease,
          signal: this.controller.signal,
        });
        if (this.controller.signal.aborted) return;
        lease.assertOwned();
        await this.applyOutcome(intent, outcome, tracked?.used() ? serverId : null);
      } catch (error) {
        if (this.controller.signal.aborted) {
          if (this.isShutdownOrDriverClose(error)) {
            this.warnShutdown(`Reconcile intent ${intent.id}`, error);
          } else {
            this.logger.error(
              `Reconcile intent ${intent.id} failed during shutdown: ${boundedErrorMessage(error)}`,
            );
          }
          return;
        }
        await this.handleError(intent, error, serverId);
      }
    });
  }

  /**
   * `contactedServerId` is set only when the reconciler actually made an Incus
   * call through the server's client; a stale or DB-only pass proves nothing
   * about the agent and must not mark the server online.
   */
  private async applyOutcome(
    intent: IntentRecord,
    outcome: ReconcileOutcome,
    contactedServerId: string | null,
  ): Promise<void> {
    if (outcome.stale) {
      // Superseded: settle without touching the resource's status columns.
      await this.settlePhysical(
        intent,
        outcome.observedRevision ?? intent.targetRevision,
        outcome.outcome === 'failed' && outcome.failure
          ? { outcome: 'failed', failure: outcome.failure }
          : { outcome: 'succeeded' },
      );
      return;
    }
    if (outcome.outcome === 'retry') {
      await this.retryOrNeedsAttention(
        intent,
        outcome.failure ?? {
          code: 'RECONCILE_RETRY',
          message: 'The physical state was not ready for reconciliation',
          details: {},
        },
        outcome.retryAfterMs,
      );
      return;
    }
    if (outcome.outcome === 'failed') {
      const failure = outcome.failure ?? {
        code: 'RECONCILE_FAILURE',
        message: 'The reconciler reported a managed failure',
        details: {},
      };
      await this.markResourceFailure(intent, failure, false);
      await this.settlePhysical(
        intent,
        outcome.observedRevision ?? intent.targetRevision,
        { outcome: 'failed', failure },
      );
      return;
    }
    await this.registry.forResource(intent.resourceType)?.markSucceeded(
      intent.resourceId,
      outcome.observedRevision ?? intent.targetRevision,
    );
    await this.settlePhysical(
      intent,
      outcome.observedRevision ?? intent.targetRevision,
      { outcome: 'succeeded' },
    );
    if (contactedServerId && intent.resourceType !== 'server') {
      await this.markServer(contactedServerId, 'online');
    }
  }

  private async handleError(
    intent: IntentRecord,
    error: unknown,
    serverId: string | null,
  ): Promise<void> {
    const failure = asFailure(error);
    if (
      isIncusError(error, 'SERVER_UNREACHABLE')
      || isIncusError(error, 'INCUS_TIMEOUT')
    ) {
      if (serverId) {
        await this.markServer(
          serverId,
          'unreachable',
          failure.message,
          intent.resourceType === 'server' ? intent.targetRevision : undefined,
        );
      }
      await this.retryOrNeedsAttention(intent, failure, 30_000, false);
      return;
    }
    if (error instanceof IncusError && error.disposition === 'retry') {
      await this.retryOrNeedsAttention(intent, failure);
      return;
    }
    if (error instanceof Error && error.message === 'RECONCILE_LEASE_LOST') {
      await this.retryOrNeedsAttention(intent, {
        code: 'RECONCILE_LEASE_LOST',
        message: 'The reconciliation lease expired before the operation completed',
        details: {},
      });
      return;
    }
    await this.markResourceFailure(intent, failure, false);
    await this.settlePhysical(intent, intent.targetRevision, { outcome: 'failed', failure });
  }

  private async retryOrNeedsAttention(
    intent: IntentRecord,
    failure: IntentFailure,
    retryAfterMs?: number,
    countBusy = true,
  ): Promise<void> {
    if (countBusy && !isIncusInstanceLockBusy(failure)) {
      await this.intents.resetBusyAttempts(intent.id);
    }
    if (countBusy && isIncusInstanceLockBusy(failure)) {
      const strikeCount = await this.intents.recordBusyAttempt(intent.id, BUSY_STRIKE_WINDOW_MS);
      if (strikeCount >= BUSY_STRIKE_LIMIT) {
        const attention: IntentFailure = {
          code: 'RESOURCE_NEEDS_ATTENTION',
          message: 'Instance remained busy for five attempts within five minutes',
          details: { busyAttempts: strikeCount },
        };
        await this.markResourceFailure(intent, attention, true);
        await this.settlePhysical(intent, intent.targetRevision, {
          outcome: 'failed',
          failure: attention,
        });
        return;
      }
    }
    await this.intents.scheduleRetry(
      intent.id,
      new Date(Date.now() + (retryAfterMs ?? boundedRetryDelay(intent.attemptCount))),
    );
  }

  private async settleFailure(intent: IntentRecord, failure: IntentFailure): Promise<void> {
    await this.markResourceFailure(intent, failure, false);
    await this.settlePhysical(intent, intent.targetRevision, { outcome: 'failed', failure });
  }

  private async markResourceFailure(
    intent: IntentRecord,
    failure: IntentFailure,
    attention: boolean,
  ): Promise<void> {
    await this.registry.forResource(intent.resourceType)
      ?.markFailure(intent.resourceId, failure, attention);
  }

  private async settleStaleIntent(intent: IntentRecord): Promise<void> {
    await this.settlePhysical(intent, intent.targetRevision, { outcome: 'succeeded' });
  }

  private async settlePhysical(
    intent: IntentRecord,
    revision: number,
    settlement: PhysicalSettlement,
  ): Promise<void> {
    const scoped = {
      ...settlement,
      placementServerId: intent.serverId ?? null,
    };
    const reconciler = this.registry.forResource(intent.resourceType);
    if (reconciler?.settle) {
      await reconciler.settle(intent, revision, scoped);
      return;
    }
    await this.intents.settleForObservedRevision(
      intent.resourceType,
      intent.resourceId,
      revision,
      scoped,
    );
  }

  private isCurrentServerIntent(intent: IntentRecord): Promise<boolean> {
    return this.registry.serverHealth().isCurrentServerIntent(intent);
  }

  private markServer(
    serverId: string,
    status: 'online' | 'unreachable' | 'unknown',
    error?: string,
    expectedRevision?: number,
  ): Promise<void> {
    return this.registry.serverHealth().markServer(serverId, status, error, expectedRevision);
  }

  private fullScan(): Promise<void> {
    if (this.controller.signal.aborted || this.scanning) return Promise.resolve();
    this.scanning = true;
    const operation = this.trackOperation(this.executeFullScan());
    this.scanPromise = operation;
    void operation.then(
      () => this.finishScan(operation),
      () => this.finishScan(operation),
    );
    return operation;
  }

  private async executeFullScan(): Promise<void> {
    try {
      await this.runOnce();
      if (this.controller.signal.aborted) return;
      // Registration starts a server as unknown. Only servers that have
      // completed onboarding may participate in background physical scans.
      await this.startEventWatchers();
      await this.pruneIntents();
      const serverIds = await this.registry.serverHealth().listOnlineServerIds();
      for (const serverId of serverIds) {
        if (this.controller.signal.aborted) return;
        let client: IncusClientPort;
        try {
          client = await this.clients.get(serverId);
        } catch (error) {
          if (this.isShutdownOrDriverClose(error)) {
            this.warnShutdown(`Full scan client lookup for ${serverId}`, error);
            return;
          }
          this.logger.error(
            `Full scan client lookup failed for ${serverId}: ${boundedErrorMessage(error)}`,
          );
          continue;
        }
        try {
          await this.registry.serverHealth().refreshInventory(
            serverId,
            client,
            this.controller.signal,
          );
        } catch (error) {
          if (this.isShutdownOrDriverClose(error)) {
            this.warnShutdown(`Inventory refresh for ${serverId}`, error);
            return;
          }
          this.logger.error(
            `Inventory refresh failed for ${serverId}: ${boundedErrorMessage(error)}`,
          );
        }
        for (const reconciler of this.registry.all()) {
          if (!reconciler.scan) continue;
          try {
            await reconciler.scan(serverId, client, this.controller.signal);
          } catch (error) {
            if (this.isShutdownOrDriverClose(error)) {
              this.warnShutdown(`Full scan for ${serverId}`, error);
              return;
            }
            this.logger.error(`Full scan failed for ${serverId}: ${boundedErrorMessage(error)}`);
          }
        }
      }
      if (this.controller.signal.aborted) return;
      await this.runOnce();
    } catch (error) {
      if (this.isShutdownOrDriverClose(error)) {
        this.warnShutdown('Reconcile full scan', error);
        return;
      }
      throw error;
    } finally {
      this.scanning = false;
    }
  }

  private finishScan(operation: Promise<void>): void {
    if (this.scanPromise !== operation) return;
    this.scanPromise = undefined;
    if (this.rescanRequested) {
      this.rescanRequested = false;
      this.startBackgroundFullScan();
    }
  }

  /** Run a full scan now, or right after the one in progress. */
  private requestFullScan(): void {
    if (this.scanning) {
      this.rescanRequested = true;
      return;
    }
    this.startBackgroundFullScan();
  }

  private async startEventWatchers(): Promise<void> {
    if (this.controller.signal.aborted) return;
    try {
      await this.ensureEventWatchers();
    } catch (error) {
      if (this.isShutdownOrDriverClose(error)) {
        this.warnShutdown('Reconcile event watcher startup', error);
      } else {
        this.logger.error(
          `Reconcile event watcher startup failed: ${boundedErrorMessage(error)}`,
        );
      }
    }
  }

  /** One watcher per registered server: new servers gain one, deleted servers' watchers end. */
  private async ensureEventWatchers(): Promise<void> {
    const serverIds = new Set(await this.clients.listServerIds());
    if (this.stopping || this.controller.signal.aborted) return;
    for (const serverId of serverIds) this.ensureEventWatcher(serverId);
    for (const serverId of [...this.eventWatchers]) {
      if (!serverIds.has(serverId)) this.eventWatchers.delete(serverId);
    }
  }

  private ensureEventWatcher(serverId: string): void {
    if (this.stopping || this.controller.signal.aborted || this.eventWatchers.has(serverId)) return;
    this.eventWatchers.add(serverId);
    const watcher = this.trackOperation(this.watchServer(serverId));
    void watcher.finally(() => this.eventWatchers.delete(serverId));
  }

  /** Hourly retention of settled intents (batched; the newest per resource is kept). */
  private async pruneIntents(): Promise<void> {
    if (Date.now() - this.lastPruneAt < INTENT_PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = Date.now();
    const cutoff = new Date(Date.now() - INTENT_RETENTION_MS);
    try {
      for (let batch = 0; batch < INTENT_PRUNE_MAX_BATCHES; batch += 1) {
        if (this.controller.signal.aborted) return;
        if (await this.intents.pruneSettled(cutoff) === 0) return;
      }
    } catch (error) {
      if (this.isShutdownOrDriverClose(error)) throw error;
      this.logger.error(`Intent retention failed: ${boundedErrorMessage(error)}`);
    }
  }

  private async watchServer(serverId: string): Promise<void> {
    try {
      while (!this.stopping && !this.controller.signal.aborted && this.eventWatchers.has(serverId)) {
        try {
          // Keep the watcher from constructing an mTLS client for a server
          // whose onboarding connect intent has not established online state.
          if (!await this.isServerOnline(serverId)) {
            await this.waitForWatcherRetry();
            continue;
          }
          const client = await this.clients.get(serverId);
          const stream = subscribeIncusEvents(client, { signal: this.controller.signal });
          for await (const wake of stream) {
            this.wake.wake({
              serverId,
              reason: wake.reason === 'reconnected'
                ? 'reconnect'
                : wake.reason === 'disconnected'
                  ? 'disconnected'
                  : 'event',
            });
            if (this.controller.signal.aborted) {
              stream.close();
              return;
            }
          }
        } catch (error) {
          if (this.isShutdownOrDriverClose(error)) {
            this.warnShutdown(`Incus event watcher for ${serverId}`, error);
            return;
          }
          this.logger.error(
            `Incus event watcher for ${serverId} failed: ${boundedErrorMessage(error)}`,
          );
        }
        if (!this.stopping && !this.controller.signal.aborted) {
          await this.waitForWatcherRetry();
        }
      }
    } catch (error) {
      if (this.isShutdownOrDriverClose(error)) {
        this.warnShutdown(`Incus event watcher for ${serverId}`, error);
        return;
      }
      this.logger.error(
        `Incus event watcher for ${serverId} stopped unexpectedly: ${boundedErrorMessage(error)}`,
      );
    }
  }

  private isServerOnline(serverId: string): Promise<boolean> {
    return this.registry.serverHealth().isServerOnline(serverId);
  }

  private waitForWatcherRetry(): Promise<void> {
    if (this.stopping || this.controller.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (timer) clearTimeout(timer);
        this.controller.signal.removeEventListener('abort', finish);
        resolve();
      };
      timer = setTimeout(finish, 1_000);
      timer.unref?.();
      this.controller.signal.addEventListener('abort', finish, { once: true });
    });
  }

  private isShutdownOrDriverClose(error: unknown): boolean {
    return isClosedDatabaseDriverError(error)
      || (this.stopping && (
        isAbortLikeError(error)
        || isIncusError(error, 'INCUS_TIMEOUT')
      ));
  }

  private warnShutdown(context: string, error: unknown): void {
    const key = `${context}:${isClosedDatabaseDriverError(error) ? 'driver' : 'shutdown'}`;
    if (this.shutdownWarnings.has(key)) return;
    this.shutdownWarnings.add(key);
    this.logger.warn(
      `${context} stopped during shutdown or driver close: ${boundedErrorMessage(error)}`,
    );
  }
}