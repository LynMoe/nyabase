import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import {
  IncusError,
  matchBusyInstanceError,
  subscribeIncusEvents,
  type IncusClientPort,
  type IncusFailureCode,
} from '../incus/index.js';
import { ServerCardExtensionsService } from '../server-card-extensions/server-extensions.service.js';
import { RuntimeRoleService } from './runtime-role.service.js';
import {
  IntentRepository,
  isRestartIntent,
  type IntentRecord,
  type IntentResource,
  type IntentFailure,
  type PhysicalSettlement,
} from './intent.repository.js';
import {
  NO_PLACEMENT_SERVER_ID,
  VOLUME_DESTROY_PLACEMENT_ID,
  ReconcileClaimRepository,
  type LeaseGuard,
  type ReconcileClaim,
} from './reconcile-claim.repository.js';
import {
  RECONCILE_WAKE,
  ReconcileWakeService,
} from './reconcile-wake.service.js';

export const INCUS_CLIENT_FACTORY = Symbol('INCUS_CLIENT_FACTORY');
export const RECONCILER_REGISTRY = Symbol('RECONCILER_REGISTRY');
export const RESOURCE_STATUS = Symbol('RESOURCE_STATUS');

export interface IncusClientFactory {
  get(
    serverId: string,
    options?: {
      readonly expectedFingerprint?: string;
    },
  ): Promise<IncusClientPort>;
  listServerIds?(): Promise<readonly string[]>;
}
export interface ReconcileRunContext {
  readonly intent: IntentRecord;
  readonly client?: IncusClientPort;
  readonly claim: ReconcileClaim;
  readonly lease: LeaseGuard;
  readonly signal: AbortSignal;
}

export interface ReconcileOutcome {
  readonly outcome: 'succeeded' | 'retry' | 'failed';
  readonly observedGeneration?: number;
  readonly failure?: IntentFailure;
  readonly retryAfterMs?: number;
  readonly stale?: boolean;
}

export interface ManagedReconciler {
  supports(intent: IntentRecord): boolean;
  reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome>;
  scan?(serverId: string, client: IncusClientPort, signal: AbortSignal): Promise<void>;
}

export interface ResourceStatusPort {
  markNeedsAttention(
    resourceType: IntentResource,
    resourceId: string,
    reason: IntentFailure,
  ): Promise<void>;
  markFailure?(
    resourceType: IntentResource,
    resourceId: string,
    failure: IntentFailure,
  ): Promise<void>;
  markSucceeded?(
    resourceType: IntentResource,
    resourceId: string,
    generation: number,
  ): Promise<void>;
  needsAttention?(
    resourceType: IntentResource,
    resourceId: string,
  ): Promise<boolean>;
}

export type ReconcilerRegistry = readonly ManagedReconciler[];

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

function optionalByteCount(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return String(Math.trunc(value));
  }
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    return value;
  }
  return null;
}

@Injectable()
export class PgResourceStatusRepository implements ResourceStatusPort {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  async markNeedsAttention(
    resourceType: IntentResource,
    resourceId: string,
    reason: IntentFailure,
  ): Promise<void> {
    await this.writeFailure(resourceType, resourceId, reason, true);
  }

  async needsAttention(
    resourceType: IntentResource,
    resourceId: string,
  ): Promise<boolean> {
    if (resourceType === 'container') {
      const row = await this.database
        .selectFrom('control.containers')
        .select('needs_attention')
        .where('id', '=', resourceId)
        .executeTakeFirst();
      return row?.needs_attention === true;
    }
    if (resourceType === 'volume') {
      const row = await this.database
        .selectFrom('control.volumes')
        .select(['needs_attention', 'lifecycle_phase'])
        .where('id', '=', resourceId)
        .executeTakeFirst();
      return row?.needs_attention === true && row.lifecycle_phase !== 'deleting';
    }
    if (resourceType === 'image_assignment') {
      const row = await this.database
        .selectFrom('infra.image_server_assignments')
        .select('needs_attention')
        .where('id', '=', resourceId)
        .executeTakeFirst();
      return row?.needs_attention === true;
    }
    return false;
  }

  async markFailure(
    resourceType: IntentResource,
    resourceId: string,
    failure: IntentFailure,
  ): Promise<void> {
    await this.writeFailure(resourceType, resourceId, failure, false);
  }

  async markSucceeded(
    resourceType: IntentResource,
    resourceId: string,
    generation: number,
  ): Promise<void> {
    const now = sql<Date>`clock_timestamp()`;
    if (resourceType === 'container') {
      await this.database
        .updateTable('control.containers')
        .set({
          observed_generation: generation,
          needs_attention: false,
          failure_code: null,
          failure_reason: null,
          last_transition_at: now,
        })
        .where('id', '=', resourceId)
        .execute();
    } else if (resourceType === 'volume') {
      await this.database
        .updateTable('control.volumes')
        .set({
          observed_generation: generation,
          needs_attention: false,
          failure_code: null,
        })
        .where('id', '=', resourceId)
        .where('lifecycle_phase', '!=', 'deleting')
        .execute();
    } else if (resourceType === 'image_assignment') {
      await this.database
        .updateTable('infra.image_server_assignments')
        .set({
          needs_attention: false,
          failure_code: null,
          failure_reason: null,
          last_observed_at: now,
        })
        .where('id', '=', resourceId)
        .execute();
    }
  }

  private async writeFailure(
    resourceType: IntentResource,
    resourceId: string,
    failure: IntentFailure,
    attention: boolean,
  ): Promise<void> {
    const code = failure.code.slice(0, 128);
    const reason = failure.message.slice(0, 4096);
    if (resourceType === 'container') {
      const values = attention
        ? {
          needs_attention: true,
          failure_code: code,
          failure_reason: reason,
          last_transition_at: sql<Date>`clock_timestamp()`,
        }
        : {
          needs_attention: false,
          failure_code: code,
          failure_reason: reason,
          last_transition_at: sql<Date>`clock_timestamp()`,
        };
      await this.database
        .updateTable('control.containers')
        .set(values)
        .where('id', '=', resourceId)
        .execute();
    } else if (resourceType === 'volume') {
      const current = await this.database
        .selectFrom('control.volumes')
        .select('lifecycle_phase')
        .where('id', '=', resourceId)
        .executeTakeFirst();
      if (current?.lifecycle_phase === 'deleting') {
        await this.database
          .updateTable('control.volumes')
          .set({ failure_code: code })
          .where('id', '=', resourceId)
          .where('lifecycle_phase', '=', 'deleting')
          .execute();
        return;
      }
      const values = attention
        ? {
          needs_attention: true,
          failure_code: code,
          lifecycle_phase: 'failed' as const,
        }
        : {
          needs_attention: false,
          failure_code: code,
        };
      await this.database
        .updateTable('control.volumes')
        .set(values)
        .where('id', '=', resourceId)
        .where('lifecycle_phase', '!=', 'deleting')
        .execute();
    } else if (resourceType === 'image_assignment') {
      const values = attention
        ? {
          needs_attention: true,
          failure_code: code,
          failure_reason: reason,
          lifecycle_phase: 'failed' as const,
          last_observed_at: sql<Date>`clock_timestamp()`,
        }
        : {
          needs_attention: false,
          failure_code: code,
          failure_reason: reason,
          last_observed_at: sql<Date>`clock_timestamp()`,
        };
      await this.database
        .updateTable('infra.image_server_assignments')
        .set(values)
        .where('id', '=', resourceId)
        .execute();
    }
  }
}

@Injectable()
export class ReconcileWorkerService implements OnModuleInit, OnModuleDestroy {
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
    private readonly role: RuntimeRoleService,
    private readonly intents: IntentRepository,
    private readonly claims: ReconcileClaimRepository,
    @Inject(RECONCILER_REGISTRY)
    private readonly reconcilers: ReconcilerRegistry,
    @Optional() @Inject(INCUS_CLIENT_FACTORY)
    private readonly clients?: IncusClientFactory,
    @Optional() @Inject(RESOURCE_STATUS)
    private readonly resourceStatus?: ResourceStatusPort,
    @Optional() @Inject(RECONCILE_WAKE)
    private readonly wake?: ReconcileWakeService,
    @Optional() @Inject(PG_DATABASE)
    private readonly database?: Kysely<NyabaseDatabase>,
    @Optional() private readonly serverExtensions?: ServerCardExtensionsService,
  ) {}

  onModuleInit(): void {
    if (!this.role.runsWorker() || this.started || this.stopping) return;
    this.started = true;
    this.unsubscribeWake = this.wake?.onWake((payload) => {
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
    if (!this.role.runsWorker() || this.controller.signal.aborted) return Promise.resolve();
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
    if (await this.resourceStatus?.needsAttention?.(intent.resourceType, intent.resourceId)) {
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
        if (serverId && this.clients) {
          const expectedFingerprint = intent.kind === 'server.connect'
            && typeof intent.request?.expectedServerCertFingerprint === 'string'
            ? intent.request.expectedServerCertFingerprint
            : undefined;
          client = await this.clients.get(serverId, { expectedFingerprint });
        }
        const reconciler = this.reconcilers.find((candidate) => candidate.supports(intent));
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
      await this.resourceStatus?.markFailure?.(intent.resourceType, intent.resourceId, failure);
      await this.settlePhysical(
        intent,
        outcome.observedGeneration ?? intent.targetGeneration,
        { outcome: 'failed', failure },
      );
      return;
    }
    await this.resourceStatus?.markSucceeded?.(
      intent.resourceType,
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
      await this.resourceStatus?.markFailure?.(intent.resourceType, intent.resourceId, failure);
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
    await this.resourceStatus?.markFailure?.(intent.resourceType, intent.resourceId, failure);
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
        await this.resourceStatus?.markNeedsAttention(intent.resourceType, intent.resourceId, attention);
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
    await this.resourceStatus?.markFailure?.(intent.resourceType, intent.resourceId, failure);
    await this.settlePhysical(intent, intent.targetGeneration, { outcome: 'failed', failure });
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

  private async isCurrentServerIntent(intent: IntentRecord): Promise<boolean> {
    if (
      !this.database
      || intent.resourceType !== 'server'
      || !intent.serverId
      || (intent.kind !== 'server.connect' && intent.kind !== 'server.preflight')
    ) {
      return true;
    }
    const server = await this.database
      .selectFrom('infra.servers')
      .select('revision')
      .where('id', '=', intent.serverId)
      .executeTakeFirst();
    return server !== undefined && Number(server.revision) === intent.targetGeneration;
  }

  private async claimServerId(intent: IntentRecord): Promise<string | null> {
    return intent.serverId;
  }

  private async markServer(
    serverId: string,
    status: 'online' | 'unreachable' | 'unknown',
    error?: string,
    expectedRevision?: number,
  ): Promise<void> {
    if (!this.database) return;
    await this.database
      .updateTable('infra.servers')
      .set({
        status,
        last_seen_at: status === 'online' ? sql<Date>`clock_timestamp()` : undefined,
        last_error: error?.slice(0, 4096) ?? null,
      })
      .where((expression) => expectedRevision === undefined
        ? expression('id', '=', serverId)
        : expression.and([
          expression('id', '=', serverId),
          expression('revision', '=', String(expectedRevision)),
        ]))
      .execute();
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
      if (this.controller.signal.aborted || !this.database || !this.clients) return;
      // Registration starts a server as unknown. Only servers that have
      // completed onboarding may participate in background physical scans.
      const servers = await this.database
        .selectFrom('infra.servers')
        .select('id')
        .where('status', '=', 'online')
        .execute();
      for (const server of servers) {
        if (this.controller.signal.aborted) return;
        let client: IncusClientPort;
        try {
          client = await this.clients.get(server.id);
        } catch (error) {
          if (this.isShutdownOrDriverClose(error)) {
            this.warnShutdown(`Full scan client lookup for ${server.id}`, error);
            return;
          }
          this.logger.error(
            `Full scan client lookup failed for ${server.id}: ${boundedErrorMessage(error)}`,
          );
          continue;
        }
        try {
          await this.refreshServerInventory(server.id, client, this.controller.signal);
        } catch (error) {
          if (this.isShutdownOrDriverClose(error)) {
            this.warnShutdown(`Inventory refresh for ${server.id}`, error);
            return;
          }
          this.logger.error(
            `Inventory refresh failed for ${server.id}: ${boundedErrorMessage(error)}`,
          );
        }
        for (const reconciler of this.reconcilers) {
          if (!reconciler.scan) continue;
          try {
            await reconciler.scan(server.id, client, this.controller.signal);
          } catch (error) {
            if (this.isShutdownOrDriverClose(error)) {
              this.warnShutdown(`Full scan for ${server.id}`, error);
              return;
            }
            this.logger.error(`Full scan failed for ${server.id}: ${boundedErrorMessage(error)}`);
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
    if (!this.clients?.listServerIds || this.controller.signal.aborted) return;
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
          const client = await this.clients!.get(serverId);
          const stream = subscribeIncusEvents(client, { signal: this.controller.signal });
          for await (const wake of stream) {
            this.wake?.wake({
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

  private async isServerOnline(serverId: string): Promise<boolean> {
    if (!this.database) return true;
    const server = await this.database
      .selectFrom('infra.servers')
      .select('status')
      .where('id', '=', serverId)
      .executeTakeFirst();
    return server?.status === 'online';
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
    if (!this.database) return 0;
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
    if (!this.database) return;
    await this.database
      .deleteFrom('control.reconcile_busy_strikes')
      .where('resource_type', '=', resourceType)
      .where('resource_id', '=', resourceId)
      .execute();
  }

  private async refreshServerInventory(
    serverId: string,
    client: IncusClientPort,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.database) return;
    const resources = await client.getResources({ signal });
    await this.serverExtensions?.refreshExistingHealth(serverId, resources.metadata, []);

    const pools = await this.database
      .selectFrom('infra.storage_pools')
      .select(['id', 'incus_name'])
      .where('server_id', '=', serverId)
      .where('registered', '=', true)
      .execute();
    for (const pool of pools) {
      if (signal.aborted) return;
      const poolResources = await client.getStoragePoolResources(pool.incus_name, { signal });
      await this.database
        .updateTable('infra.storage_pools')
        .set({
          used_bytes: optionalByteCount(poolResources.metadata.space?.used),
          total_bytes: optionalByteCount(poolResources.metadata.space?.total),
          last_observed_at: sql<Date>`clock_timestamp()`,
        })
        .where('id', '=', pool.id)
        .execute();
    }
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