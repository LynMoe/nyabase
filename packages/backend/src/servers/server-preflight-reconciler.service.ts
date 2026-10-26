import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  FailureCode,
  PreflightStatus,
  type NodeMetricSample,
  type PreflightReport,
} from '@nyabase/common';
import { sql } from 'kysely';
import { IncusError, type IncusClientPort, type IncusSchema } from '../incus/index.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';
import { intentFailure } from '../reconcile/intent-model.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
  ResourceAuthority,
} from '../reconcile/managed-reconciler.js';
import { ReconcilerRegistry } from '../reconcile/reconciler-registry.service.js';
import { AgentNodeMetricsPullAdapter } from '../metrics/node-metrics-pull.adapter.js';
import {
  evaluateLanBridge,
  listHostLanAddresses,
  lookupParentNetwork,
  metricSamplesFrom,
  IncusPreflightChecksAdapter,
} from './preflight-checks.adapter.js';
import { ServerConnector } from './server-connector.js';
import { allocatableCpus, parseCpuTopology } from '../cpu/cpu-allocation.js';
import { runProbe, type PreflightOptions, type ProbeRun, type ReportChecks } from './server-preflight-probe.js';
import {
  ServerPreflightStore,
  ServerRevisionChangedError,
  normalized,
  revisionNumber,
  type IpPoolNetwork,
  type ServerRow,
} from './server-preflight.store.js';
import { gpuPreflight } from '../gpu/inventory.js';
import { isRecord } from '../platform/domain-utils.js';

/** The first node-metrics pull: its outcome, or the failure that downgrades the check to a warning. */
interface MetricsEvidence {
  readonly pull: NodeMetricsPull;
  readonly failure: unknown;
}

interface NodeMetricsPull {
  readonly status: 'online' | 'unreachable' | 'unknown';
  readonly report?: Record<string, unknown> & {
    readonly samples?: readonly NodeMetricSample[];
  };
}

function successReport(checks: ReportChecks, gpu?: Record<string, unknown>): PreflightReport {
  const controlReady = Object.entries(checks).every(([name, value]) => {
    if (name === 'nodeMetrics') return value === 'pass' || value === 'warn';
    return value === 'pass';
  });
  return {
    status: PreflightStatus.Passed,
    controlReady,
    checks,
    failureCode: null,
    checkedAt: new Date().toISOString(),
    ...(gpu ? { gpu } : {}),
  };
}

function failureReport(
  status: PreflightStatus.Running | PreflightStatus.Failed,
  code: string,
): PreflightReport {
  const failureCode = (Object.values(FailureCode) as string[]).includes(code)
    ? (code as FailureCode)
    : FailureCode.PreflightFailed;
  return {
    status,
    controlReady: false,
    checks: {
      api: 'fail',
      parentInterface: 'fail',
      nftables: 'fail',
      ipv4Filtering: 'fail',
      networkPrerequisites: 'fail',
      storagePool: 'fail',
      simplestreamsImage: 'fail',
      guestAddress: 'fail',
      nodeMetrics: 'fail',
    },
    failureCode,
    checkedAt: status === PreflightStatus.Running ? null : new Date().toISOString(),
  };
}

function staleOutcome(intent: IntentRecord): ReconcileOutcome {
  return {
    outcome: 'succeeded',
    observedRevision: intent.targetRevision,
    stale: true,
  };
}

/**
 * Drives `server.preflight` (prove the host can run guests): agent reachability, storage
 * pool, node metrics, LAN bridge, GPU inventory and a throwaway probe container
 * that proves guest networking. Server state is written by the reconcile flow itself.
 */
@Injectable()
export class ServerPreflightReconciler implements ManagedReconciler, OnModuleInit {
  readonly resourceType = 'server' as const;

  constructor(
    private readonly store: ServerPreflightStore,
    private readonly connector: ServerConnector,
    private readonly nodeMetrics: AgentNodeMetricsPullAdapter,
    private readonly checks: IncusPreflightChecksAdapter,
    private readonly config: NyabaseConfigService,
    private readonly registry: ReconcilerRegistry,
  ) {}

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
        failure: intentFailure('SERVER_NOT_FOUND', 'The desired server no longer exists'),
      };
    }
    const expectedRevision = context.intent.targetRevision;
    const currentRevision = revisionNumber(server.revision);
    if (currentRevision !== undefined && currentRevision !== expectedRevision) {
      return staleOutcome(context.intent);
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
      const report = await this.runPreflight(
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
          ? intentFailure(error.code, error.message, error.details as Record<string, unknown>)
          : intentFailure(
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

  /** The system pool must be registered on this server and exist in Incus. */
  /** Containers are pinned to unreserved CPUs; reserved CPUs must exist and leave some over. */
  private async requireUnreservedCpus(serverId: string, resources: unknown): Promise<void> {
    const topology = parseCpuTopology(resources);
    const reserved = await this.store.readReservedCpus(serverId);
    const known = new Set(topology.map((entry) => entry.id));
    const unknown = reserved.filter((cpu) => !known.has(cpu));
    if (topology.length === 0 || unknown.length > 0 || allocatableCpus(topology, reserved).length === 0) {
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: topology.length === 0 ? 'cpu_topology_unknown' : unknown.length > 0
          ? 'reserved_cpu_unknown'
          : 'no_unreserved_cpus',
        serverId,
        reservedCpus: reserved,
      });
    }
  }

  private async requireSystemPool(
    server: ServerRow,
    pools: readonly IncusSchema<'StoragePool'>[],
  ) {
    const systemPool = server.system_pool_id
      ? await this.store.readSystemPool(server.system_pool_id)
      : undefined;
    if (
      !systemPool ||
      systemPool.server_id !== server.id ||
      !systemPool.registered ||
      !pools.some((pool) => pool.name === systemPool.incus_name)
    ) {
      throw new IncusError('MISSING_STORAGE_POOL', 'managed_failure', {
        serverId: server.id,
        systemPoolId: server.system_pool_id,
      });
    }
    return systemPool;
  }

  private async collectMetrics(
    server: ServerRow,
    signal: AbortSignal,
    expectedRevision: number | undefined,
  ): Promise<MetricsEvidence> {
    try {
      const pull = await this.pullNodeMetrics(server, signal, expectedRevision);
      return { pull, failure: null };
    } catch (error) {
      return {
        pull: { status: 'unreachable', report: { warning: 'node_metrics_unavailable' } },
        failure: error,
      };
    }
  }

  /** Probe the LAN bridge the server's guests attach to; fails the preflight with the first problem found. */
  private async requireLanBridge(
    client: IncusClientPort,
    server: ServerRow,
    network: Record<string, unknown>,
    samples: ReturnType<typeof metricSamplesFrom>,
    signal: AbortSignal,
  ): Promise<{ parentInterface: string; poolNetworks: IpPoolNetwork[] }> {
    const poolNetworks = await this.store.listIpPoolNetworks(server.id);
    const parentInterface = server.parent_interface?.trim() || '';
    const parentLookup = parentInterface
      ? await lookupParentNetwork(client, parentInterface, signal)
      : { networkMissing: true, stateMissing: true };
    const extraHostAddresses = await listHostLanAddresses(
      client,
      parentInterface,
      parentLookup,
      signal,
    );
    const lan = evaluateLanBridge({
      parentInterface,
      network,
      lookup: parentLookup,
      pools: poolNetworks,
      samples,
      extraHostAddresses,
    });
    if (lan.reason) {
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: lan.reason,
        network: JSON.stringify(network).slice(0, 2048),
      });
    }
    return { parentInterface, poolNetworks };
  }

  /** The probe cannot run without an image and a pool; both may default from the system pool. */
  private probeOptions(options: PreflightOptions, systemPoolName: string): PreflightOptions {
    const probeOptions = {
      ...options,
      probePoolName: options.probePoolName || systemPoolName,
    };
    if (
      (!probeOptions.probeImageAlias && !probeOptions.probeImageFingerprint) ||
      !probeOptions.probePoolName
    ) {
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'preflight_probe_options_missing',
      });
    }
    return probeOptions;
  }

  /** A probe that could not be removed fails the preflight (unless the server changed meanwhile). */
  private async failOnCleanupError(
    server: ServerRow,
    expectedRevision: number | undefined,
    cleanupError: unknown,
  ): Promise<never> {
    if (
      !(await this.store.projectServer(server.id, expectedRevision, {
        status: 'unknown',
        last_error: `Preflight cleanup failed: ${String(cleanupError).slice(0, 3800)}`,
        preflight_status: 'failed',
        preflight_checked_at: sql<Date>`clock_timestamp()`,
        preflight_report: JSON.stringify(
          failureReport(PreflightStatus.Failed, FailureCode.PreflightCleanupFailed),
        ),
      }))
    ) {
      throw new ServerRevisionChangedError();
    }
    throw new IncusError('PREFLIGHT_CLEANUP_FAILED', 'managed_failure', {
      error: String(cleanupError).slice(0, 1024),
      ...(cleanupError instanceof IncusError
        ? { code: cleanupError.code, details: cleanupError.details }
        : {}),
    });
  }

  private async runPreflight(
    client: IncusClientPort,
    server: ServerRow,
    options: PreflightOptions,
    signal: AbortSignal,
  ): Promise<PreflightReport> {
    const expectedRevision = revisionNumber(server.revision);
    await this.connector.connect(client, server, expectedRevision, signal);
    const pools = await client.listStoragePools(1, { signal });
    const resources = await client.getResources({ signal });
    await this.requireUnreservedCpus(server.id, resources.metadata);
    const systemPool = await this.requireSystemPool(server, pools.metadata);
    const metrics = await this.collectMetrics(server, signal, expectedRevision);
    const metricEvidence = metrics.failure ? undefined : metrics.pull.report;
    const firstSamples = metricSamplesFrom(metricEvidence);
    const network = await this.checks.checkNetworkPrerequisites(server.id, metricEvidence);
    const gpu = gpuPreflight({
      serverId: server.id,
      resources: resources.metadata,
      metricSamples: firstSamples,
      enabled: server.gpu_enabled === true,
    });
    await this.store.setGpuHealth(server.id, gpu.health);
    const lan = await this.requireLanBridge(client, server, network, firstSamples, signal);
    const checks: ReportChecks = {
      api: 'pass',
      parentInterface: 'pass',
      nftables: 'pass',
      ipv4Filtering: 'fail',
      networkPrerequisites: 'pass',
      storagePool: 'pass',
      simplestreamsImage: 'fail',
      guestAddress: 'fail',
      nodeMetrics: metrics.failure ? 'warn' : metrics.pull.status === 'online' ? 'pass' : 'fail',
    };
    const run: ProbeRun = {
      client,
      server,
      signal,
      probeName: `nyabase-preflight-${normalized(server.id)}`,
      options: this.probeOptions(options, systemPool.incus_name),
      parentInterface: lan.parentInterface,
      poolNetwork: lan.poolNetworks[0]!,
      checks,
      secondMetricsPull: () => this.pullNodeMetricsAfterProbe(server, signal),
      created: false,
    };
    const cleanupError = await runProbe(run);
    if (cleanupError) await this.failOnCleanupError(server, expectedRevision, cleanupError);
    return successReport(checks, gpu.evidence);
  }

  /** Collect the server's metrics through its agent and record the pull outcome on the server. */
  private async pullNodeMetrics(
    server: ServerRow,
    signal: AbortSignal,
    expectedRevision?: number,
  ): Promise<NodeMetricsPull> {
    const project = async (values: Record<string, unknown>): Promise<void> => {
      if (!(await this.store.projectServer(server.id, expectedRevision, values))) {
        throw new ServerRevisionChangedError();
      }
    };
    try {
      const result = await this.nodeMetrics.pull(server.id, signal);
      if (result.status !== 'online') {
        await project({
          node_metrics_status: result.status,
          node_metrics_outage_since: sql<Date>`coalesce(node_metrics_outage_since, clock_timestamp())`,
          node_metrics_last_error: `Node metrics status: ${result.status}`,
        });
        throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
          reason: 'node_metrics_pull_not_online',
          status: result.status,
        });
      }
      await project({
        node_metrics_status: 'online',
        node_metrics_last_success_at: sql<Date>`clock_timestamp()`,
        node_metrics_outage_since: null,
        node_metrics_last_error: null,
      });
      return result;
    } catch (error) {
      if (error instanceof ServerRevisionChangedError) throw error;
      if (error instanceof IncusError) throw error;
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'NODE_METRICS_PULL_FAILED';
      await project({
        node_metrics_status: 'unknown',
        node_metrics_outage_since: sql<Date>`coalesce(node_metrics_outage_since, clock_timestamp())`,
        node_metrics_last_error: `Node metrics pull failed: ${code}`,
      });
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'node_metrics_pull_failed',
        code,
      });
    }
  }

  /** The second pull, after the probe exists, which must prove nftables state. */
  private async pullNodeMetricsAfterProbe(
    server: ServerRow,
    signal: AbortSignal,
  ): Promise<NodeMetricsPull> {
    try {
      const result = await this.nodeMetrics.pull(server.id, signal);
      if (result.status !== 'online') {
        throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
          reason: 'preflight_nft_unavailable',
          status: result.status,
        });
      }
      return result;
    } catch (error) {
      if (error instanceof IncusError) throw error;
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'preflight_nft_unavailable',
      });
    }
  }
}
