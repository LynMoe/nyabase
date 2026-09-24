import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  CORE_NODE_METRIC_CATALOG,
  INCUS_USER_KEYS,
  MAX_METRIC_POINTS_PER_BATCH,
  MAX_SERVER_CONCURRENCY,
  NODE_METRICS_SCRAPE_INTERVAL_MS,
  hyphenateContainerHex,
  validateNodeMetricSample,
  type NodeMetricSample,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import type { IncusClientPort } from '../incus/incus-client.js';
import { isLocalPoolRow } from '../storage-pools/storage-pools.service.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../runtime/reconcile-worker.service.js';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';
import { type MetricPoint, type MetricsWriteOptions, MetricsWriter } from './metrics-writer.js';

const PUBLISH_TIMEOUT_MS = 3_000;
const POOL_READ_TIMEOUT_MS = 2_000;
const POOL_READS_PER_TICK = 8;
const MAX_VOLUME_SERIES = 32;
const NIC_DEVICES = new Set(['eth0', 'eth1', 'eth2', 'eth3']);

interface InstanceDocument {
  config?: Record<string, string | undefined>;
  state?: {
    disk?: Record<string, { usage?: unknown; total?: unknown } | undefined>;
    network?: Record<string, {
      counters?: { bytes_received?: unknown; bytes_sent?: unknown };
    } | undefined>;
  };
}

export interface ContainerPublishFacts {
  readonly rootSizeBytes: number | null;
  readonly deleting: boolean;
  readonly volumesByDevice: Map<string, string>;
}

export function containerStateSamples(
  document: InstanceDocument,
  containerId: string,
  facts: ContainerPublishFacts,
): NodeMetricSample[] {
  if (facts.deleting) return [];
  const labels = { container_id: containerId };
  const samples: NodeMetricSample[] = [];
  const root = document.state?.disk?.root;
  const used = finiteNumber(root?.usage);
  if (used !== null) {
    samples.push({ name: 'nyabase_container_root_used_bytes', labels, value: used });
  }
  const reportedTotal = finiteNumber(root?.total);
  const size = reportedTotal !== null && reportedTotal > 0 ? reportedTotal : facts.rootSizeBytes;
  if (size !== null && size > 0) {
    samples.push({ name: 'nyabase_container_root_size_bytes', labels, value: size });
  }
  const network = document.state?.network;
  if (network) {
    for (const [device, nic] of Object.entries(network)) {
      if (!NIC_DEVICES.has(device)) continue;
      const rx = finiteNumber(nic?.counters?.bytes_received);
      const tx = finiteNumber(nic?.counters?.bytes_sent);
      const nicLabels = { container_id: containerId, device };
      if (rx !== null) {
        samples.push({ name: 'nyabase_container_net_rx_bytes_total', labels: nicLabels, value: rx });
      }
      if (tx !== null) {
        samples.push({ name: 'nyabase_container_net_tx_bytes_total', labels: nicLabels, value: tx });
      }
    }
  }
  let volumes = 0;
  for (const [device, disk] of Object.entries(document.state?.disk ?? {})) {
    if (!device.startsWith('nyd-') || volumes >= MAX_VOLUME_SERIES) continue;
    const volumeId = facts.volumesByDevice.get(device);
    if (!volumeId) continue;
    const volumeUsed = finiteNumber(disk?.usage);
    const volumeSize = finiteNumber(disk?.total);
    const volumeLabels = { container_id: containerId, volume_id: volumeId };
    if (volumeUsed !== null) {
      samples.push({ name: 'nyabase_container_volume_used_bytes', labels: volumeLabels, value: volumeUsed });
    }
    if (volumeSize !== null) {
      samples.push({ name: 'nyabase_container_volume_size_bytes', labels: volumeLabels, value: volumeSize });
    }
    volumes += 1;
  }
  return samples;
}

export function managedContainerId(document: InstanceDocument): string | null {
  if (document.config?.[INCUS_USER_KEYS.managed] !== 'true') return null;
  const raw = document.config[INCUS_USER_KEYS.containerId];
  if (typeof raw !== 'string') return null;
  return hyphenateContainerHex(raw.replaceAll('-', ''));
}

@Injectable()
export class ContainerStateMetricsPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContainerStateMetricsPublisher.name);
  private readonly inFlight = new Set<string>();
  private readonly poolCursor = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Optional() @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory | null,
    private readonly metricsWriter: MetricsWriter,
    private readonly runtimeRole: RuntimeRoleService,
    private readonly config: NyabaseConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.runtimeRole.runsWorker() || !this.enabled() || this.timer) return;
    this.timer = setInterval(() => {
      void this.publishAvailableServers();
    }, NODE_METRICS_SCRAPE_INTERVAL_MS);
    this.timer.unref?.();
    void this.publishAvailableServers();
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async publishAvailableServers(): Promise<void> {
    if (this.shuttingDown || !this.enabled() || !this.clients) return;
    let servers: Array<{ id: string }>;
    try {
      servers = await this.database
        .selectFrom('infra.servers')
        .select('id')
        .where('status', '=', 'online')
        .execute();
    } catch (error) {
      this.logger.warn(`Container state metrics server list failed: ${messageOf(error)}`);
      return;
    }
    void this.publishPools(servers.map((server) => server.id));
    let cursor = 0;
    const workerCount = Math.min(MAX_SERVER_CONCURRENCY, servers.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (!this.shuttingDown) {
        const index = cursor;
        cursor += 1;
        const server = servers[index];
        if (!server) return;
        await this.publishServer(server.id);
      }
    }));
  }

  private async publishPools(onlineServerIds: readonly string[]): Promise<void> {
    if (!this.clients || onlineServerIds.length === 0) return;
    let pools: Array<{
      id: string;
      server_id: string;
      incus_name: string;
      shareable: boolean;
      driver: string;
      shared_backend_id: string | null;
    }>;
    let systemPools: Array<{ id: string; system_pool_id: string | null }>;
    try {
      [pools, systemPools] = await Promise.all([
        this.database
          .selectFrom('infra.storage_pools')
          .select(['id', 'server_id', 'incus_name', 'shareable', 'driver', 'shared_backend_id'])
          .where('registered', '=', true)
          .where('server_id', 'in', [...onlineServerIds])
          .execute(),
        this.database
          .selectFrom('infra.servers')
          .select(['id', 'system_pool_id'])
          .where('id', 'in', [...onlineServerIds])
          .execute(),
      ]);
    } catch (error) {
      this.logger.warn(`Storage pool metrics list failed: ${messageOf(error)}`);
      return;
    }
    const systemPoolByServer = new Map(systemPools.map((row) => [row.id, row.system_pool_id]));
    const byServer = new Map<string, typeof pools>();
    for (const pool of pools) {
      if (!isLocalPoolRow(pool)) continue;
      const list = byServer.get(pool.server_id) ?? [];
      list.push(pool);
      byServer.set(pool.server_id, list);
    }
    await Promise.all([...byServer.entries()].map(async ([serverId, rows]) => {
      const systemPoolId = systemPoolByServer.get(serverId);
      const ordered = [...rows].sort((left, right) => {
        const leftSystem = left.id === systemPoolId ? 0 : 1;
        const rightSystem = right.id === systemPoolId ? 0 : 1;
        return leftSystem - rightSystem || left.incus_name.localeCompare(right.incus_name);
      });
      const start = this.poolCursor.get(serverId) ?? 0;
      const chosen = Array.from({ length: Math.min(POOL_READS_PER_TICK, ordered.length) }, (_, offset) =>
        ordered[(start + offset) % ordered.length]).filter((pool): pool is typeof ordered[number] => pool !== undefined);
      this.poolCursor.set(serverId, ordered.length === 0 ? 0 : (start + chosen.length) % ordered.length);
      if (!this.clients || chosen.length === 0) return;
      try {
        const client = await this.clients.get(serverId);
        const ts = Date.now();
        const points: MetricPoint[] = [];
        for (const pool of chosen) {
          try {
            const resources = await client.getStoragePoolResources(pool.incus_name, {
              signal: AbortSignal.timeout(POOL_READ_TIMEOUT_MS),
            });
            const space = resources.metadata?.space;
            const used = finiteNumber(space?.used);
            const total = finiteNumber(space?.total);
            const labels = { pool_id: pool.id };
            if (used !== null) {
              const point = acceptedPoint({ name: 'nyabase_storage_pool_used_bytes', labels, value: used }, ts);
              if (point) points.push(point);
            }
            if (total !== null && total > 0) {
              const point = acceptedPoint({ name: 'nyabase_storage_pool_size_bytes', labels, value: total }, ts);
              if (point) points.push(point);
            }
          } catch (error) {
            this.logger.warn(`Storage pool metrics failed for ${pool.incus_name}: ${messageOf(error)}`);
          }
        }
        if (points.length > 0) await this.metricsWriter.writeBatch(serverId, points);
      } catch (error) {
        this.logger.warn(`Storage pool metrics client failed for ${serverId}: ${messageOf(error)}`);
      }
    }));
  }

  private async publishServer(serverId: string): Promise<void> {
    if (this.inFlight.has(serverId) || !this.clients) return;
    this.inFlight.add(serverId);
    try {
      const client = await this.clients.get(serverId);
      const signal = AbortSignal.timeout(PUBLISH_TIMEOUT_MS);
      const listed = await client.listInstances(2, { signal });
      const documents = Array.isArray(listed.metadata) ? listed.metadata : [];
      const facts = await this.loadFacts(serverId);
      const ts = Date.now();
      const points: MetricPoint[] = [];
      for (const document of documents) {
        const containerId = managedContainerId(document as InstanceDocument);
        if (!containerId) continue;
        const containerFacts = facts.get(containerId);
        const samples = containerStateSamples(
          document as InstanceDocument,
          containerId,
          containerFacts ?? { rootSizeBytes: null, deleting: false, volumesByDevice: new Map() },
        );
        for (const sample of samples) {
          const point = acceptedPoint(sample, ts);
          if (point) points.push(point);
        }
      }
      if (points.length === 0) return;
      const options: MetricsWriteOptions = { containerOwners: ownerMap(facts) };
      for (let offset = 0; offset < points.length; offset += MAX_METRIC_POINTS_PER_BATCH) {
        await this.metricsWriter.writeBatch(
          serverId,
          points.slice(offset, offset + MAX_METRIC_POINTS_PER_BATCH),
          options,
        );
      }
    } catch (error) {
      this.logger.warn(`Container state metrics publish failed for ${serverId}: ${messageOf(error)}`);
    } finally {
      this.inFlight.delete(serverId);
    }
  }

  private async loadFacts(serverId: string): Promise<Map<string, ContainerPublishFacts & { ownerId: string | null }>> {
    const containers = await this.database
      .selectFrom('control.containers')
      .select(['id', 'owner_id', 'lifecycle_phase', 'root_size_bytes'])
      .where('server_id', '=', serverId)
      .execute();
    const facts = new Map<string, ContainerPublishFacts & { ownerId: string | null }>();
    const liveIds: string[] = [];
    for (const row of containers) {
      const deleting = row.lifecycle_phase === 'deleting';
      facts.set(row.id, {
        rootSizeBytes: finiteNumber(row.root_size_bytes),
        deleting,
        volumesByDevice: new Map(),
        ownerId: deleting ? null : row.owner_id,
      });
      if (!deleting) liveIds.push(row.id);
    }
    if (liveIds.length === 0) return facts;
    const attachments = await this.database
      .selectFrom('control.volume_attachments')
      .select(['container_id', 'device_name', 'volume_id'])
      .where('container_id', 'in', liveIds)
      .execute();
    for (const row of attachments) {
      const current = facts.get(row.container_id);
      if (!current || current.deleting) continue;
      const volumeId = hyphenateContainerHex(String(row.volume_id).replaceAll('-', ''));
      if (!volumeId) continue;
      current.volumesByDevice.set(row.device_name, volumeId);
    }
    return facts;
  }

  private enabled(): boolean {
    return this.config.get<boolean>('metrics.containerSeriesEnabled') !== false;
  }
}

function ownerMap(
  facts: ReadonlyMap<string, { ownerId: string | null; deleting: boolean }>,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [id, fact] of facts) {
    if (!fact.deleting && fact.ownerId) owners.set(id, fact.ownerId);
  }
  return owners;
}

function acceptedPoint(sample: NodeMetricSample, ts: number): MetricPoint | null {
  try {
    const validated = validateNodeMetricSample(sample, CORE_NODE_METRIC_CATALOG);
    return { name: validated.name, labels: { ...validated.labels }, value: validated.value, ts };
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { IncusClientPort };
