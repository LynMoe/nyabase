import { PreflightStatus, FailureCode, type PreflightReport } from '@nyabase/common';
import { sql } from 'kysely';
import { IncusError, type IncusClientPort, type IncusSchema } from '../incus/index.js';
import type { AuthenticatedNodeMetricsPullAdapter } from '../metrics/node-metrics-pull.adapter.js';
import { gpuPreflight } from '../gpu/preflight.js';
import type { IncusPreflightChecksAdapter } from './preflight-checks.adapter.js';
import type { ServerConnector } from './server-connector.js';
import {
  evaluateLanBridge,
  listHostLanAddresses,
  lookupParentNetwork,
  metricSamplesFrom,
} from './server-preflight-network.js';
import {
  pullNodeMetrics,
  pullNodeMetricsAfterProbe,
  type NodeMetricsPull,
} from './server-preflight-metrics.js';
import { runProbe, type ProbeRun } from './server-preflight-probe.js';
import type { ServerPreflightStore } from './server-preflight.store.js';
import {
  ServerRevisionChangedError,
  failureReport,
  normalized,
  revisionNumber,
  successReport,
  type IpPoolNetwork,
  type PreflightOptions,
  type ReportChecks,
  type ServerRow,
} from './server-preflight-support.js';

/** The first node-metrics pull: its outcome, or the failure that downgrades the check to a warning. */
interface MetricsEvidence {
  readonly pull: NodeMetricsPull;
  readonly failure: unknown;
}

/**
 * The whole preflight for one server: API identity, storage pool, node
 * metrics, LAN bridge, GPU inventory and a throwaway probe container that
 * proves guest networking.
 */
export class ServerPreflightRunner {
  constructor(
    private readonly store: ServerPreflightStore,
    private readonly connector: ServerConnector,
    private readonly checks: IncusPreflightChecksAdapter,
    private readonly nodeMetrics: AuthenticatedNodeMetricsPullAdapter,
  ) {}

  /** The system pool must be registered on this server and exist in Incus. */
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
      const pull = await pullNodeMetrics(
        this.store,
        this.nodeMetrics,
        server,
        signal,
        expectedRevision,
      );
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
  ): Promise<{ parentInterface: string; poolNetworks: IpPoolNetwork[]; hostIpv4: string }> {
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
    return { parentInterface, poolNetworks, hostIpv4: lan.hostIpv4! };
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

  async runPreflight(
    client: IncusClientPort,
    server: ServerRow,
    options: PreflightOptions,
    signal: AbortSignal,
  ): Promise<PreflightReport> {
    const expectedRevision = revisionNumber(server.revision);
    await this.connector.connect(client, server, undefined, expectedRevision, signal);
    const pools = await client.listStoragePools(1, { signal });
    const resources = await client.getResources({ signal });
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
      guestCanReachHost: 'fail',
      networkPrerequisites: 'pass',
      storagePool: 'pass',
      simplestreamsImage: 'fail',
      guestAddress: 'fail',
      egress: 'fail',
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
      hostIpv4: lan.hostIpv4,
      checks,
      adapter: this.checks,
      secondMetricsPull: () => pullNodeMetricsAfterProbe(this.nodeMetrics, server, signal),
      created: false,
    };
    const cleanupError = await runProbe(run);
    if (cleanupError) await this.failOnCleanupError(server, expectedRevision, cleanupError);
    return successReport(checks, gpu.evidence);
  }
}
