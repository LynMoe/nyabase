import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Capability, PreflightStatus } from '@nyabase/common';
import { Kysely, sql } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { IncusError } from '../incus/index.js';
import { EphemeralStore } from '../platform/ephemeral-store.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
  ResourceAuthority,
} from '../reconcile/managed-reconciler.js';
import { ReconcilerRegistry } from '../reconcile/reconciler-registry.service.js';
import { AuthenticatedNodeMetricsPullAdapter } from '../metrics/node-metrics-pull.adapter.js';
import { IncusPreflightChecksAdapter } from './preflight-checks.adapter.js';
import { ServerConnector } from './server-connector.js';
import { ServerPreflightRunner } from './server-preflight-runner.js';
import { ServerPreflightStore } from './server-preflight.store.js';
import {
  ServerRevisionChangedError,
  failureReport,
  isRecord,
  preflightFailure,
  revisionNumber,
  staleOutcome,
  type PreflightOptions,
  type ServerRow,
} from './server-preflight-support.js';

/**
 * Drives `server.connect` (trust + pin the Incus server) and `server.preflight`
 * (prove the host can run guests). The work is in ServerConnector and
 * ServerPreflightRunner; server state is written by the reconcile flow itself.
 */
@Injectable()
export class ServerPreflightReconciler implements ManagedReconciler, OnModuleInit {
  readonly resourceType = 'server' as const;
  private readonly store: ServerPreflightStore;
  private readonly connector: ServerConnector;
  private readonly runner: ServerPreflightRunner;

  constructor(
    @Inject(PG_DATABASE) database: Kysely<NyabaseDatabase>,
    private readonly nodeMetrics: AuthenticatedNodeMetricsPullAdapter,
    private readonly checks: IncusPreflightChecksAdapter,
    ephemeral: EphemeralStore,
    private readonly config: NyabaseConfigService,
    private readonly registry: ReconcilerRegistry,
  ) {
    this.store = new ServerPreflightStore(database);
    this.connector = new ServerConnector(this.store, ephemeral);
    this.runner = new ServerPreflightRunner(this.store, this.connector, checks, nodeMetrics);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  supports(intent: IntentRecord): boolean {
    return intent.resourceType === this.resourceType;
  }

  // Server state is written by the reconcile flow itself, not per resource.
  async needsAttention(): Promise<boolean> {
    return false;
  }

  async markSucceeded(): Promise<void> {}

  async markFailure(): Promise<void> {}

  async resourceAuthorities(
    resourceIds: readonly string[],
  ): Promise<Map<string, ResourceAuthority>> {
    return new Map(resourceIds.map((id) => [id, {
      ownerId: null,
      adminCapability: Capability.ManageServers,
    }]));
  }

  async reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome> {
    if (!context.client || !context.intent.serverId) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
    }
    const server = await this.store.readServer(context.intent.serverId);
    if (!server) {
      return {
        outcome: 'failed',
        failure: preflightFailure('SERVER_NOT_FOUND', 'The desired server no longer exists'),
      };
    }
    const expectedRevision = context.intent.targetRevision;
    const currentRevision = revisionNumber(server.revision);
    if (currentRevision !== undefined && currentRevision !== expectedRevision) {
      return staleOutcome(context.intent);
    }
    if (context.intent.kind === 'server.connect') {
      try {
        await this.connector.connectWithTrustToken(
          context.client,
          server,
          context.intent,
          context.signal,
        );
      } catch (error) {
        if (error instanceof ServerRevisionChangedError) {
          return staleOutcome(context.intent);
        }
        throw error;
      }
      return { outcome: 'succeeded', observedRevision: context.intent.targetRevision };
    }
    return this.reconcilePreflight(context, server, expectedRevision);
  }

  private async reconcilePreflight(
    context: ReconcileRunContext,
    server: ServerRow,
    expectedRevision: number,
  ): Promise<ReconcileOutcome> {
    const serverId = server.id;
    const options = this.options(context.intent.request);
    if (
      !(await this.store.projectServer(serverId, expectedRevision, {
        preflight_status: 'running',
        status: 'unknown',
      }))
    ) {
      return staleOutcome(context.intent);
    }
    try {
      const report = await this.runner.runPreflight(
        context.client!,
        server,
        options,
        context.signal,
      );
      if (
        !(await this.store.projectServer(serverId, expectedRevision, {
          status: 'online',
          last_seen_at: sql<Date>`clock_timestamp()`,
          last_error: null,
          preflight_status: 'passed',
          preflight_checked_at: sql<Date>`clock_timestamp()`,
          preflight_report: JSON.stringify(report),
        }))
      ) {
        return staleOutcome(context.intent);
      }
      return { outcome: 'succeeded', observedRevision: context.intent.targetRevision };
    } catch (error) {
      if (error instanceof ServerRevisionChangedError) {
        return staleOutcome(context.intent);
      }
      const failure =
        error instanceof IncusError
          ? preflightFailure(error.code, error.message, error.details as Record<string, unknown>)
          : preflightFailure(
              'PREFLIGHT_FAILED',
              error instanceof Error ? error.message : String(error),
            );
      const retryable = error instanceof IncusError && error.disposition === 'retry';
      if (
        !(await this.store.projectServer(serverId, expectedRevision, {
          status: failure.code === 'SERVER_UNREACHABLE' ? 'unreachable' : 'unknown',
          last_error: failure.message.slice(0, 4096),
          preflight_status: retryable ? 'running' : 'failed',
          preflight_checked_at: sql<Date>`clock_timestamp()`,
          preflight_report: JSON.stringify(
            failureReport(
              retryable ? PreflightStatus.Running : PreflightStatus.Failed,
              failure.code,
            ),
          ),
        }))
      ) {
        return staleOutcome(context.intent);
      }
      throw error;
    }
  }

  private options(request: Record<string, unknown> | null): PreflightOptions {
    const value = isRecord(request?.preflight) ? request.preflight : request;
    const stringValue = (key: string): string | undefined =>
      isRecord(value) && typeof value[key] === 'string' && value[key].trim()
        ? String(value[key]).trim()
        : undefined;
    return {
      probeImageAlias:
        stringValue('probeImageAlias') ?? this.config.get<string>('incus.preflightImageAlias'),
      probeImageFingerprint:
        stringValue('probeImageFingerprint') ??
        this.config.get<string>('incus.preflightImageFingerprint'),
      probePoolName: stringValue('probePoolName') ?? '',
      probeAddress: stringValue('probeAddress') ?? '169.254.255.254',
      sourceServer:
        stringValue('sourceServer') ?? this.config.get<string>('incus.preflightSourceServer'),
    };
  }
}
