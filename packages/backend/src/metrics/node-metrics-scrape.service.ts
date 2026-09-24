import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  MAX_METRIC_POINTS_PER_BATCH,
  NODE_METRICS_FAILURE_THRESHOLD,
  NODE_METRICS_FRESHNESS_MS,
  NODE_METRICS_SCRAPE_INTERVAL_MS,
  NodeMetricsStatus,
  type NodeMetricSample,
} from '@nyabase/common';
import { NVIDIA_GPU_EXTENSION_ID, canonicalPciAddress } from '@nyabase/nvidia-gpu';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import {
  NODE_METRICS_PULL,
  type NodeMetricsPullPort,
} from '../runtime/server-preflight-reconciler.service.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';
import {
  type MetricPoint,
  type MetricsWriteOptions,
  MetricsWriter,
} from './metrics-writer.js';

interface NodeMetricsServerRow {
  id: string;
  revision: string;
  node_metrics_endpoint: string | null;
  node_metrics_token_ciphertext: string | null;
  node_metrics_token_fingerprint: string | null;
  node_metrics_status: 'unconfigured' | 'online' | 'unreachable' | 'unknown';
  node_metrics_last_success_at: Date | string | null;
}

type NodeMetricsHealthPatch = {
  node_metrics_status?: NodeMetricsStatus;
  node_metrics_last_success_at?: RawBuilder<Date> | null;
  node_metrics_outage_since?: RawBuilder<Date> | null;
  node_metrics_last_error?: string | null;
};

interface ActiveScrape {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

const NODE_METRICS_SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

@Injectable()
export class NodeMetricsScrapeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NodeMetricsScrapeService.name);
  private readonly failures = new Map<string, number>();
  private readonly inFlight = new Map<string, ActiveScrape>();
  private readonly activeRuns = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private destroyPromise: Promise<void> | null = null;

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Inject(NODE_METRICS_PULL) private readonly nodeMetrics: NodeMetricsPullPort,
    private readonly metricsWriter: MetricsWriter,
    private readonly runtimeRole: RuntimeRoleService,
    @Optional() private readonly config?: NyabaseConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.runtimeRole.runsWorker() || this.shuttingDown || this.timer) return;
    this.timer = setInterval(() => this.startBackgroundScrape(), NODE_METRICS_SCRAPE_INTERVAL_MS);
    this.timer.unref?.();
    this.startBackgroundScrape();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const operation of this.inFlight.values()) {
      operation.controller.abort();
    }
    this.destroyPromise = this.drainActiveOperations();
    return this.destroyPromise;
  }

  scrapeAll(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    return this.trackRun(this.runScrapeAll());
  }

  private async runScrapeAll(): Promise<void> {
    let servers: NodeMetricsServerRow[];
    try {
      servers = await this.database
        .selectFrom('infra.servers')
        .select([
          'id',
          'revision',
          'node_metrics_endpoint',
          'node_metrics_token_ciphertext',
          'node_metrics_token_fingerprint',
          'node_metrics_status',
          'node_metrics_last_success_at',
        ])
        .where('node_metrics_endpoint', 'is not', null)
        .where('node_metrics_token_ciphertext', 'is not', null)
        .execute();
    } catch (error) {
      this.logScrapeFailure('load node metrics configuration', error);
      return;
    }
    const results = await Promise.allSettled(servers.map((server) => this.scrapeServer(server)));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logScrapeFailure('scrape node metrics server', result.reason);
      }
    }
  }

  scrapeServerNow(serverId: string): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    return this.trackRun(this.runScrapeServerNow(serverId));
  }

  private async runScrapeServerNow(serverId: string): Promise<void> {
    try {
      const server = await this.database
        .selectFrom('infra.servers')
        .select([
          'id',
          'revision',
          'node_metrics_endpoint',
          'node_metrics_token_ciphertext',
          'node_metrics_token_fingerprint',
          'node_metrics_status',
          'node_metrics_last_success_at',
        ])
        .where('id', '=', serverId)
        .executeTakeFirst();
      if (server) await this.scrapeServer(server);
    } catch (error) {
      this.logScrapeFailure(`load server ${serverId}`, error);
    }
  }

  private scrapeServer(server: NodeMetricsServerRow): Promise<void> {
    if (
      this.shuttingDown
      || this.inFlight.has(server.id)
      || !server.node_metrics_endpoint
      || !server.node_metrics_token_ciphertext
    ) return Promise.resolve();
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.executeScrape(server, controller.signal));
    const operation: ActiveScrape = { controller, promise };
    this.inFlight.set(server.id, operation);
    void promise.then(
      () => this.clearActiveScrape(server.id, operation),
      () => this.clearActiveScrape(server.id, operation),
    );
    return promise;
  }

  private async executeScrape(
    server: NodeMetricsServerRow,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (!server.node_metrics_endpoint || !server.node_metrics_token_ciphertext) return;
      const result = await this.nodeMetrics.pull(
        server.id,
        server.node_metrics_endpoint,
        server.node_metrics_token_ciphertext,
        signal,
      );
      if (this.shuttingDown || signal.aborted) return;
      if (result.status !== 'online' || !result.report?.samples) {
        throw new Error('NODE_METRICS_INVALID_RESPONSE');
      }
      if (!(await this.isCurrentConfiguration(server))) {
        this.logger.debug(`Ignoring stale node metrics success for ${server.id}`);
        return;
      }
      const now = Date.now();
      const enabled = this.containerSeriesEnabled();
      const scraped = result.report.samples
        .filter((sample: NodeMetricSample) => enabled || !sample.name.startsWith('nyabase_container_'))
        .map((sample: NodeMetricSample) => ({
          name: sample.name,
          labels: { ...sample.labels },
          value: sample.value,
          ts: now,
        }));
      const owners = await this.loadContainerOwners(server.id);
      const points: MetricPoint[] = [
        ...scraped,
        ...(enabled ? gpuMemoryLimitPoints(scraped, await this.loadGpuClaims(server.id), now) : []),
        {
          name: 'nyabase_node_scrape_up',
          labels: {},
          value: 1,
          ts: now,
        },
      ];
      if (this.shuttingDown || signal.aborted) return;
      if (!(await this.isCurrentConfiguration(server))) {
        this.logger.debug(`Ignoring node metrics success before VM write for ${server.id}`);
        return;
      }
      const writeOptions: MetricsWriteOptions = {
        guard: () => this.isCurrentConfiguration(server),
        containerOwners: owners,
      };
      await this.writeChunks(server.id, points, writeOptions);
      if (this.shuttingDown || signal.aborted) return;
      const updated = await this.updateNodeMetricsHealth(server, {
        node_metrics_status: NodeMetricsStatus.Online,
        node_metrics_last_success_at: sql<Date>`clock_timestamp()`,
        node_metrics_outage_since: null,
        node_metrics_last_error: null,
      });
      if (updated) {
        this.failures.delete(configurationKey(server));
      } else {
        this.logger.debug(`Ignoring stale node metrics success projection for ${server.id}`);
      }
    } catch (error) {
      if (this.shuttingDown || signal.aborted) return;
      await this.recordFailure(server, error);
    }
  }

  private async recordFailure(server: NodeMetricsServerRow, error: unknown): Promise<void> {
    if (this.shuttingDown) return;
    const key = configurationKey(server);
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    const lastSuccess = server.node_metrics_last_success_at
      ? new Date(server.node_metrics_last_success_at).getTime()
      : NaN;
    const fresh = Number.isFinite(lastSuccess)
      && Date.now() - lastSuccess <= NODE_METRICS_FRESHNESS_MS;
    const status = failures >= NODE_METRICS_FAILURE_THRESHOLD
      ? NodeMetricsStatus.Unreachable
      : fresh
        ? NodeMetricsStatus.Online
        : NodeMetricsStatus.Unknown;
    const errorCode = error && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string'
      ? error.code
      : 'NODE_METRICS_PULL_FAILED';
    const now = Date.now();
    try {
      if (!(await this.isCurrentConfiguration(server))) {
        this.logger.debug(`Ignoring stale node metrics failure for ${server.id}`);
        return;
      }
      if (this.shuttingDown) return;
      await this.metricsWriter.writeBatch(server.id, [{
        name: 'nyabase_node_scrape_up',
        labels: {},
        value: 0,
        ts: now,
      }], {
        guard: () => this.isCurrentConfiguration(server),
      });
      if (this.shuttingDown) return;
      const updated = await this.updateNodeMetricsHealth(server, {
        node_metrics_status: status,
        node_metrics_outage_since: sql<Date>`coalesce(node_metrics_outage_since, clock_timestamp())`,
        node_metrics_last_error: errorCode.slice(0, 4096),
      });
      if (!updated) {
        this.logger.debug(`Ignoring stale node metrics failure projection for ${server.id}`);
      }
    } catch (writeError) {
      this.logger.warn(
        `Node metrics failure projection failed for ${server.id}: ${
          writeError instanceof Error ? writeError.message : String(writeError)
        }`,
      );
    }
  }

  private startBackgroundScrape(): void {
    if (this.shuttingDown) return;
    void this.scrapeAll().catch((error: unknown) => {
      this.logScrapeFailure('background node metrics scrape', error);
    });
  }

  private trackRun(promise: Promise<void>): Promise<void> {
    this.activeRuns.add(promise);
    void promise.then(
      () => this.activeRuns.delete(promise),
      () => this.activeRuns.delete(promise),
    );
    return promise;
  }

  private clearActiveScrape(serverId: string, operation: ActiveScrape): void {
    if (this.inFlight.get(serverId) === operation) {
      this.inFlight.delete(serverId);
    }
  }

  private async drainActiveOperations(): Promise<void> {
    const active = [
      ...new Set([
        ...this.activeRuns,
        ...[...this.inFlight.values()].map((operation) => operation.promise),
      ]),
    ];
    if (active.length === 0) return;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve('timeout'),
        NODE_METRICS_SHUTDOWN_DRAIN_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([
      Promise.allSettled(active).then(() => 'drained' as const),
      timeout,
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (
      result === 'timeout'
      && (this.activeRuns.size > 0 || this.inFlight.size > 0)
    ) {
      this.logger.warn(
        `Node metrics shutdown drain timed out with ${
          this.activeRuns.size
        } scrape runs and ${this.inFlight.size} server operations still active`,
      );
    }
  }

  private containerSeriesEnabled(): boolean {
    if (!this.config) return true;
    return this.config.get<boolean>('metrics.containerSeriesEnabled') !== false;
  }

  private async writeChunks(
    serverId: string,
    points: MetricPoint[],
    options: MetricsWriteOptions,
  ): Promise<void> {
    for (let offset = 0; offset < points.length; offset += MAX_METRIC_POINTS_PER_BATCH) {
      await this.metricsWriter.writeBatch(
        serverId,
        points.slice(offset, offset + MAX_METRIC_POINTS_PER_BATCH),
        options,
      );
    }
  }

  private async loadContainerOwners(serverId: string): Promise<Map<string, string>> {
    const rows = await this.database
      .selectFrom('control.containers')
      .select(['id', 'owner_id'])
      .where('server_id', '=', serverId)
      .where('lifecycle_phase', '<>', 'deleting')
      .execute();
    const owners = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.owner_id === 'string' && row.owner_id.length > 0) {
        owners.set(row.id, row.owner_id);
      }
    }
    return owners;
  }

  private async loadGpuClaims(serverId: string): Promise<Map<string, string[]>> {
    const rows = await this.database
      .selectFrom('control.extension_device_claims')
      .select(['container_id', 'device_key'])
      .where('server_id', '=', serverId)
      .where('extension_id', '=', NVIDIA_GPU_EXTENSION_ID)
      .execute();
    const claims = new Map<string, string[]>();
    for (const row of rows) {
      const pci = typeof row.device_key === 'string' ? canonicalPciAddress(row.device_key) : null;
      if (!pci || typeof row.container_id !== 'string') continue;
      const list = claims.get(row.container_id) ?? [];
      list.push(pci);
      claims.set(row.container_id, list);
    }
    return claims;
  }

  private async isCurrentConfiguration(server: NodeMetricsServerRow): Promise<boolean> {
    const current = await this.database
      .selectFrom('infra.servers')
      .select([
        'revision',
        'node_metrics_endpoint',
        'node_metrics_token_ciphertext',
        'node_metrics_token_fingerprint',
      ])
      .where('id', '=', server.id)
      .executeTakeFirst();
    return current !== undefined
      && String(current.revision) === String(server.revision)
      && current.node_metrics_endpoint === server.node_metrics_endpoint
      && current.node_metrics_token_ciphertext === server.node_metrics_token_ciphertext
      && current.node_metrics_token_fingerprint === server.node_metrics_token_fingerprint;
  }

  private async updateNodeMetricsHealth(
    server: NodeMetricsServerRow,
    values: NodeMetricsHealthPatch,
  ): Promise<boolean> {
    const result = await this.database
      .updateTable('infra.servers')
      .set(values)
      .where('id', '=', server.id)
      .where('revision', '=', server.revision)
      .where('node_metrics_endpoint', '=', server.node_metrics_endpoint)
      .where('node_metrics_token_ciphertext', '=', server.node_metrics_token_ciphertext)
      .where('node_metrics_token_fingerprint', '=', server.node_metrics_token_fingerprint)
      .execute();
    if (!result || typeof result !== 'object' || !('numUpdatedRows' in result)) return true;
    return Number(result.numUpdatedRows) > 0;
  }

  private logScrapeFailure(context: string, error: unknown): void {
    this.logger.warn(
      `Node metrics ${context} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function gpuMemoryLimitPoints(
  samples: readonly MetricPoint[],
  claims: ReadonlyMap<string, readonly string[]>,
  ts: number,
): MetricPoint[] {
  const totals = new Map<string, number>();
  for (const sample of samples) {
    if (sample.name !== 'nyabase_node_gpu_mem_total_bytes') continue;
    const pci = canonicalPciAddress(sample.labels.gpu_pci ?? '');
    if (!pci || !Number.isFinite(sample.value) || sample.value < 0) continue;
    totals.set(pci, sample.value);
  }
  const points: MetricPoint[] = [];
  for (const [containerId, addresses] of claims) {
    if (addresses.length === 0) continue;
    let sum = 0;
    let complete = true;
    for (const address of addresses) {
      const pci = canonicalPciAddress(address);
      const total = pci ? totals.get(pci) : undefined;
      if (total === undefined) {
        complete = false;
        break;
      }
      sum += total;
    }
    if (!complete) continue;
    points.push({
      name: 'nyabase_container_gpu_mem_limit_bytes',
      labels: { container_id: containerId },
      value: sum,
      ts,
    });
  }
  return points;
}

function configurationKey(server: NodeMetricsServerRow): string {
  return [
    server.id,
    String(server.revision),
    server.node_metrics_endpoint ?? '',
    server.node_metrics_token_fingerprint ?? '',
  ].join('\u0000');
}
