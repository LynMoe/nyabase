import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import {
  IncusError,
  matchBusyInstanceError,
  subscribeIncusEvents,
  type IncusClientPort,
  type IncusFailureCode,
} from '../incus/index.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import {
  IntentRepository,
  isRestartIntent,
  isUserRetryIntent,
  type IntentRecord,
  type IntentResource,
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

function asFailure(error: unknown): IntentFailure {
  if (error instanceof IncusError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details as Record<string, unknown>,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'RECONCILE_FAILURE',
    message: message.slice(0, 4096),
    details: {},
  };
}

function isIncusInstanceLockBusy(failure: IntentFailure): boolean {
  if (failure.code !== 'INSTANCE_BUSY') return false;
  const reason = failure.details?.reason;
  if (reason === 'sshd_not_listening' || reason === 'guest_network_instance_not_ready') {
    return false;
  }
  const action = failure.details?.action;
  if (typeof action === 'string' && action.length > 0) return true;
  const errorText = failure.details?.error;
  return typeof errorText === 'string' && matchBusyInstanceError(errorText) !== undefined;
}

function isIncusError(error: unknown, code: IncusFailureCode): boolean {
  return error instanceof IncusError && error.code === code;
}

function boundedRetryDelay(attemptCount: number): number {
  const exponent = Math.min(6, Math.max(0, attemptCount));
  return Math.min(60_000, 1_000 * (2 ** exponent));
}

const MAX_BACKGROUND_ERROR_LENGTH = 512;
const BUSY_STRIKE_WINDOW_MS = 300_000;
const BUSY_STRIKE_LIMIT = 5;

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_BACKGROUND_ERROR_LENGTH
    ? `${message.slice(0, MAX_BACKGROUND_ERROR_LENGTH - 3)}...`
    : message;
}

function isClosedDatabaseDriverError(error: unknown): boolean {
  const message = boundedErrorMessage(error).toLowerCase();
  return message.includes('driver has already been destroyed')
    || message.includes('driver has already been closed')
    || message.includes('pool has already been closed')
    || message.includes('connection has already been closed');
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError'
    || error.message === 'The operation was aborted'
    || error.message === 'The operation was aborted.';
}

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
  private running = false;
  private scanning = false;
  private started = false;
  private stopping = false;
  private runPromise?: Promise<void>;
  private scanPromise?: Promise<void>;
  private destroyPromise?: Promise<void>;
  private eventWatchers: Promise<void>[] = [];

  constructor(
    private readonly intents: IntentRepository,
    private readonly claims: ReconcileClaimRepository,
    private readonly registry: ReconcilerRegistry,
    @Inject(INCUS_CLIENT_FACTORY)
    private readonly clients: IncusClientFactory,
    private readonly wake: ReconcileWakeService,
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  // Starts after every module's onModuleInit has registered its reconciler.
  onApplicationBootstrap(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.unsubscribeWake = this.wake.onWake((payload) => {
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
    try {
      this.unsubscribeWake?.();
    } catch (error) {
      this.logger.warn(`Reconcile wake unsubscribe failed: ${boundedErrorMessage(error)}`);
    } finally {
      this.unsubscribeWake = undefined;
    }
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.scanTimer = undefined;
    this.wakeTimer = undefined;
    this.destroyPromise = this.drainInFlight().then(() => {
      this.eventWatchers = [];
    });
    return this.destroyPromise;
  }

  runOnce(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.runPromise) return this.runPromise;
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

  private async executeRunOnce(): Promise<void> {
    try {
      if (this.controller.signal.aborted) return;
      await this.claims.reapExpired();
      const page = await this.intents.listPending({
        limit: 100,
        readyAt: new Date(),
      });
      for (const intent of page.items) {
        if (this.controller.signal.aborted) break;
        await this.processIntent(intent);
      }
    } catch (error) {
      if (this.isShutdownOrDriverClose(error)) {
        this.warnShutdown('Reconcile queue pass', error);
        return;
      }
      throw error;
    }
  }

  private finishRun(operation: Promise<void>): void {
    if (this.runPromise !== operation) return;
    this.runPromise = undefined;
    this.running = false;
  }

  private async processIntent(intent: IntentRecord): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (
      !isUserRetryIntent(intent.request)
      && await this.registry.forResource(intent.resourceType)?.needsAttention(intent.resourceId)
    ) {
      return;
    }
    const serverId = await this.claimServerId(intent);
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
      try {
        if (!await this.isCurrentServerIntent(intent)) {
          await this.settleStaleIntent(intent);
          return;
        }
        if (serverId) {
          const expectedFingerprint = intent.kind === 'server.connect'
            && typeof intent.request?.expectedServerCertFingerprint === 'string'
            ? intent.request.expectedServerCertFingerprint
            : undefined;
          client = await this.clients.get(serverId, { expectedFingerprint });
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
        await this.applyOutcome(intent, outcome, serverId);
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

  private async applyOutcome(
    intent: IntentRecord,
    outcome: ReconcileOutcome,
    serverId: string | null,
  ): Promise<void> {
    if (outcome.stale) {
      await this.clearBusyStrikes(intent.resourceType, intent.resourceId);
      await this.settlePhysical(intent, intent.targetGeneration, { outcome: 'succeeded' });
      return;
    }
    if (outcome.outcome !== 'retry') {
      await this.clearBusyStrikes(intent.resourceType, intent.resourceId);
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
        outcome.observedGeneration ?? intent.targetGeneration,
        { outcome: 'failed', failure },
      );
      return;
    }
    await this.registry.forResource(intent.resourceType)?.markSucceeded(
      intent.resourceId,
      outcome.observedGeneration ?? intent.targetGeneration,
    );
    await this.settlePhysical(
      intent,
      outcome.observedGeneration ?? intent.targetGeneration,
      { outcome: 'succeeded' },
    );
    if (serverId && intent.resourceType !== 'server') {
      await this.markServer(serverId, 'online');
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
          intent.resourceType === 'server' ? intent.targetGeneration : undefined,
        );
      }
      await this.retryOrNeedsAttention(intent, failure, 30_000, false);
      return;
    }
    if (isIncusError(error, 'TLS_PIN_MISMATCH')) {
      if (serverId) {
        await this.markServer(
          serverId,
          'unknown',
          failure.message,
          intent.resourceType === 'server' ? intent.targetGeneration : undefined,
        );
      }
      await this.markResourceFailure(intent, failure, false);
      await this.settlePhysical(intent, intent.targetGeneration, { outcome: 'failed', failure });
      return;
    }
    if (isIncusError(error, 'TLS_ERROR')) {
      if (serverId) {
        await this.markServer(
          serverId,
          'unknown',
          failure.message,
          intent.resourceType === 'server' ? intent.targetGeneration : undefined,
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
    await this.settlePhysical(intent, intent.targetGeneration, { outcome: 'failed', failure });
  }

  private async retryOrNeedsAttention(
    intent: IntentRecord,
    failure: IntentFailure,
    retryAfterMs?: number,
    countBusy = true,
  ): Promise<void> {
    if (countBusy && isIncusInstanceLockBusy(failure)) {
      const strikeCount = await this.recordBusyStrike(intent.resourceType, intent.resourceId);
      if (strikeCount >= BUSY_STRIKE_LIMIT) {
        const attention: IntentFailure = {
          code: 'RESOURCE_NEEDS_ATTENTION',
          message: 'Instance remained busy for five attempts within five minutes',
          details: { busyAttempts: strikeCount },
        };
        await this.markResourceFailure(intent, attention, true);
        await this.settlePhysical(intent, intent.targetGeneration, {
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
    await this.settlePhysical(intent, intent.targetGeneration, { outcome: 'failed', failure });
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
    await this.settlePhysical(intent, intent.targetGeneration, { outcome: 'succeeded' });
  }

  private async settlePhysical(
    intent: IntentRecord,
    generation: number,
    settlement: PhysicalSettlement,
  ): Promise<void> {
    const scoped = {
      ...settlement,
      placementServerId: intent.serverId ?? null,
    };
    if (isRestartIntent(intent.kind, intent.request)) {
      await this.intents.settleOne(intent.id, settlement);
      if (settlement.outcome === 'succeeded') {
        await this.intents.settleForObservedGeneration(
          intent.resourceType,
          intent.resourceId,
          generation,
          scoped,
        );
      }
      return;
    }
    await this.intents.settleForObservedGeneration(
      intent.resourceType,
      intent.resourceId,
      generation,
      scoped,
    );
  }

  private isCurrentServerIntent(intent: IntentRecord): Promise<boolean> {
    return this.registry.serverHealth().isCurrentServerIntent(intent);
  }

  private async claimServerId(intent: IntentRecord): Promise<string | null> {
    return intent.serverId;
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
  }

  private async startEventWatchers(): Promise<void> {
    if (this.controller.signal.aborted) return;
    let serverIds: readonly string[];
    try {
      serverIds = await this.clients.listServerIds();
    } catch (error) {
      if (this.isShutdownOrDriverClose(error)) {
        this.warnShutdown('Reconcile event watcher startup', error);
      } else {
        this.logger.error(
          `Reconcile event watcher startup failed: ${boundedErrorMessage(error)}`,
        );
      }
      return;
    }
    if (this.stopping || this.controller.signal.aborted) return;
    this.eventWatchers = serverIds.map((serverId) => this.trackOperation(this.watchServer(serverId)));
  }

  private async watchServer(serverId: string): Promise<void> {
    try {
      while (!this.stopping && !this.controller.signal.aborted) {
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

  private async recordBusyStrike(
    resourceType: IntentResource,
    resourceId: string,
  ): Promise<number> {
    const observedAt = new Date();
    await this.database
      .insertInto('control.reconcile_busy_strikes')
      .values({
        resource_type: resourceType,
        resource_id: resourceId,
        observed_at: observedAt,
      })
      .execute();
    const cutoff = new Date(observedAt.getTime() - BUSY_STRIKE_WINDOW_MS);
    const rows = await this.database
      .selectFrom('control.reconcile_busy_strikes')
      .select('observed_at')
      .where('resource_type', '=', resourceType)
      .where('resource_id', '=', resourceId)
      .where('observed_at', '>=', cutoff)
      .execute();
    return rows.length;
  }

  private async clearBusyStrikes(
    resourceType: IntentResource,
    resourceId: string,
  ): Promise<void> {
    await this.database
      .deleteFrom('control.reconcile_busy_strikes')
      .where('resource_type', '=', resourceType)
      .where('resource_id', '=', resourceId)
      .execute();
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