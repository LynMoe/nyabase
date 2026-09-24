import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type PerformanceAdminUsageResponse,
  type PerformanceMetric,
  type PerformanceRange,
  type PerformanceMultiSeriesResponse,
  type PerformanceSelfResponse,
  type PerformanceSeriesResponse,
  type PerformanceUsageResponse,
} from '@nyabase/common';
import { NVIDIA_GPU_EXTENSION_ID, canonicalPciAddress } from '@nyabase/nvidia-gpu';
import type { Kysely } from 'kysely';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { isLocalPoolDto, StoragePoolsService } from '../storage-pools/storage-pools.service.js';
import {
  absoluteChart,
  buildChart,
  buildSeries,
  buildUsage,
  emptyHost,
  toUserUsage,
  type InventoryContainer,
  type ObservedSample,
} from './performance-model.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUERY_TIMEOUT_MS = 2_000;

const RANGES: Record<PerformanceRange, { seconds: number; step: number }> = {
  '15m': { seconds: 15 * 60, step: 15 },
  '1h': { seconds: 60 * 60, step: 15 },
  '6h': { seconds: 6 * 60 * 60, step: 60 },
  '24h': { seconds: 24 * 60 * 60, step: 300 },
};

const INSTANT_QUERIES: Array<[string, (selector: string) => string, string]> = [
  ['cpu_usage_cores', (selector) => `rate(nyabase_container_cpu_usage_seconds_total${selector}[1m])`, 'nyabase_container_cpu_usage_seconds_total'],
  ['cpu_limit_cores', (selector) => `last_over_time(nyabase_container_cpu_limit_cores${selector}[2m])`, 'nyabase_container_cpu_limit_cores'],
  ['mem_used_bytes', (selector) => `last_over_time(nyabase_container_mem_used_bytes${selector}[2m])`, 'nyabase_container_mem_used_bytes'],
  ['mem_limit_bytes', (selector) => `last_over_time(nyabase_container_mem_limit_bytes${selector}[2m])`, 'nyabase_container_mem_limit_bytes'],
  ['root_used_bytes', (selector) => `last_over_time(nyabase_container_root_used_bytes${selector}[2m])`, 'nyabase_container_root_used_bytes'],
  ['root_size_bytes', (selector) => `last_over_time(nyabase_container_root_size_bytes${selector}[2m])`, 'nyabase_container_root_size_bytes'],
  ['disk_read_bytes_per_sec', (selector) => `rate(nyabase_container_disk_io_read_bytes_total${selector}[1m])`, 'nyabase_container_disk_io_read_bytes_total'],
  ['disk_write_bytes_per_sec', (selector) => `rate(nyabase_container_disk_io_write_bytes_total${selector}[1m])`, 'nyabase_container_disk_io_write_bytes_total'],
  ['net_rx_bytes_per_sec', (selector) => `rate(nyabase_container_net_rx_bytes_total${selector}[1m])`, 'nyabase_container_net_rx_bytes_total'],
  ['net_tx_bytes_per_sec', (selector) => `rate(nyabase_container_net_tx_bytes_total${selector}[1m])`, 'nyabase_container_net_tx_bytes_total'],
  ['volume_used_bytes', (selector) => `last_over_time(nyabase_container_volume_used_bytes${selector}[2m])`, 'nyabase_container_volume_used_bytes'],
  ['volume_size_bytes', (selector) => `last_over_time(nyabase_container_volume_size_bytes${selector}[2m])`, 'nyabase_container_volume_size_bytes'],
  ['gpu_limit_bytes', (selector) => `last_over_time(nyabase_container_gpu_mem_limit_bytes${selector}[2m])`, 'nyabase_container_gpu_mem_limit_bytes'],
  ['gpu_process_bytes', (selector) => `last_over_time(nyabase_node_gpu_process_mem_used_bytes${selector}[2m])`, 'nyabase_node_gpu_process_mem_used_bytes'],
];

const SERIES_FAMILIES: Record<PerformanceMetric, readonly string[]> = {
  cpu: ['cpu_usage_cores'],
  memory: ['mem_used_bytes', 'mem_limit_bytes'],
  disk: ['root_used_bytes', 'root_size_bytes', 'volume_used_bytes', 'volume_size_bytes'],
  gpu: ['gpu_process_bytes', 'gpu_limit_bytes'],
  network: ['net_rx_bytes_per_sec', 'net_tx_bytes_per_sec'],
};

export interface PerformanceQuery {
  serverId?: string;
  userId?: string;
  containerId?: string;
  metric?: PerformanceMetric;
  metrics?: string;
  spark?: string;
  range?: PerformanceRange;
}

@Injectable()
export class PerformanceQueryService {
  private readonly logger = new Logger(PerformanceQueryService.name);

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly config: NyabaseConfigService,
    private readonly access: AccessResolverService,
    private readonly storagePools: StoragePoolsService,
  ) {}

  async userUsage(userId: string, query: PerformanceQuery): Promise<PerformanceUsageResponse | PerformanceSelfResponse> {
    if (query.containerId) return this.selfUsage(userId, query.containerId, false);
    const admin = await this.adminUsage(userId, query, false);
    if (!('servers' in admin)) return admin;
    const usage = toUserUsage(admin);
    usage.ownContainers = admin.servers.flatMap((server) =>
      server.containers
        .filter((container) => container.userId === userId)
        .map((container) => ({
          containerId: container.containerId,
          name: container.name,
          cpu: container.cpu,
          memory: container.memory,
          gpu: { usedBytes: container.gpu.usedBytes, limitBytes: container.gpu.limitBytes, ratio: container.gpu.ratio, pciAddresses: container.gpu.pciAddresses },
          disk: container.disk,
          network: container.network,
          volumes: container.volumes,
        })));
    return usage;
  }

  async adminUsage(actorId: string, query: PerformanceQuery, admin = true): Promise<PerformanceAdminUsageResponse | PerformanceSelfResponse> {
    if (query.containerId) return this.selfUsage(actorId, query.containerId, admin);
    const servers = await this.resolveServers(actorId, query.serverId, admin);
    const userId = optionalUuid(query.userId, 'userId');
    if (servers.length === 0) {
      return { sampledAt: null, truncated: false, servers: [] };
    }
    const containers = (await this.loadContainers(servers)).filter((container) =>
      !userId || container.ownerId === userId);
    const samples = servers.length === 0
      ? []
      : await this.queryInstant(servers.map((server) => server.id));
    const scrapeUp = await this.queryScrapeUp(servers.map((server) => server.id));
    const usage = buildUsage({ containers, samples, scrapeUp, now: Date.now(), admin: true });
    const known = new Set(usage.servers.map((server) => server.serverId));
    for (const server of servers) {
      if (known.has(server.id)) continue;
      const scrape = scrapeUp.get(server.id);
      usage.servers.push({
        serverId: server.id,
        serverName: server.name,
        stale: !scrape || scrape.value === 0 || Date.now() - scrape.ts > 45_000,
        sampledAt: scrape ? new Date(scrape.ts).toISOString() : null,
        people: [],
        containers: [],
        unattributedGpu: [],
        host: emptyHost(),
        sparkline: null,
      });
    }
    usage.servers.sort((left, right) => left.serverName.localeCompare(right.serverName));
    await this.attachHost(usage, samples, admin ? null : actorId);
    if (query.spark === '1') await this.attachSparklines(usage);
    return usage;
  }

  async userSeries(userId: string, query: PerformanceQuery): Promise<PerformanceSeriesResponse | PerformanceMultiSeriesResponse> {
    if (query.metrics) return this.multiSeries(userId, query, false);
    if (query.containerId) throw new BadRequestException('containerId is not available');
    const series = await this.adminSeries(userId, query, false);
    if (!('lines' in series)) return series;
    return {
      ...series,
      lines: series.lines.map((line) => ({ key: line.key, label: line.label, points: line.points })),
    };
  }

  async adminSeries(actorId: string, query: PerformanceQuery, admin = true): Promise<PerformanceSeriesResponse | PerformanceMultiSeriesResponse> {
    if (query.metrics) return this.multiSeries(actorId, query, admin);
    const metric = query.metric ?? 'cpu';
    const range = query.range ?? '1h';
    if (!SERIES_FAMILIES[metric] || !RANGES[range]) {
      throw new BadRequestException('metric or range is invalid');
    }
    const containerId = optionalUuid(query.containerId, 'containerId');
    const servers = await this.resolveServers(actorId, query.serverId, admin);
    const userId = optionalUuid(query.userId, 'userId');
    const containers = (await this.loadContainers(servers)).filter((container) =>
      (!userId || container.ownerId === userId)
      && (!containerId || container.id === containerId));
    const families = Object.fromEntries(INSTANT_QUERIES) as Record<string, (selector: string) => string>;
    const window = RANGES[range];
    const end = Math.floor(Date.now() / 1000 / window.step) * window.step;
    const start = end - window.seconds;
    const selector = selectorFor(servers.map((server) => server.id), containerId);
    const series = new Map<string, Array<{ ts: number; labels: Record<string, string>; value: number }>>();
    if (selector) {
      await Promise.all(SERIES_FAMILIES[metric].map(async (family) => {
        const points = await this.queryRange(families[family]?.(selector) ?? '', start, end, window.step);
        series.set(family, points);
      }));
    }
    return {
      metric,
      range,
      lines: buildSeries({ metric, containers, series, containerId }),
    };
  }

  private async selfUsage(actorId: string, containerId: string, admin: boolean): Promise<PerformanceSelfResponse> {
    const row = await this.database
      .selectFrom('control.containers')
      .select(['id', 'server_id', 'owner_id', 'lifecycle_phase'])
      .where('id', '=', containerId)
      .executeTakeFirst();
    if (!row || row.lifecycle_phase === 'deleting') throw new NotFoundException('Container not found');
    if (!admin && row.owner_id !== actorId) throw new NotFoundException('Container not found');
    const servers = await this.resolveServers(actorId, row.server_id, admin);
    const containers = (await this.loadContainers(servers)).filter((container) => container.id === containerId);
    const samples = await this.queryInstant(servers.map((server) => server.id));
    const scrapeUp = await this.queryScrapeUp(servers.map((server) => server.id));
    const usage = buildUsage({ containers, samples, scrapeUp, now: Date.now(), admin: true });
    const server = usage.servers[0];
    const container = server?.containers[0];
    if (!server || !container) throw new NotFoundException('Container not found');
    return {
      sampledAt: server.sampledAt,
      stale: server.stale,
      serverId: row.server_id,
      container: {
        containerId: container.containerId,
        name: container.name,
        cpu: container.cpu,
        memory: container.memory,
        gpu: {
          usedBytes: container.gpu.usedBytes,
          limitBytes: container.gpu.limitBytes,
          ratio: container.gpu.ratio,
          pciAddresses: container.gpu.pciAddresses,
        },
        disk: container.disk,
        network: container.network,
        volumes: container.volumes,
      },
    };
  }

  private async multiSeries(
    actorId: string,
    query: PerformanceQuery,
    admin: boolean,
  ): Promise<PerformanceMultiSeriesResponse> {
    if (query.metric) throw new BadRequestException('metric or range is invalid');
    const requested = (query.metrics ?? '').split(',').filter(Boolean);
    const metrics: PerformanceMetric[] = ['cpu', 'memory', 'disk', 'gpu', 'network'];
    if (requested.join(',') !== metrics.join(',')) throw new BadRequestException('metric or range is invalid');
    if (!query.serverId) throw new BadRequestException('serverId is required');
    const range = query.range ?? '1h';
    if (!RANGES[range]) throw new BadRequestException('metric or range is invalid');
    const containerId = optionalUuid(query.containerId, 'containerId');
    const userId = optionalUuid(query.userId, 'userId');
    const servers = await this.resolveServers(actorId, query.serverId, admin);
    let containers = await this.loadContainers(servers);
    if (userId) containers = containers.filter((container) => container.ownerId === userId);
    if (containerId) {
      containers = containers.filter((container) => container.id === containerId);
      const container = containers[0];
      if (!container || (!admin && container.ownerId !== actorId)) {
        throw new NotFoundException('Container not found');
      }
    }
    const window = RANGES[range];
    const end = Math.floor(Date.now() / 1000 / window.step) * window.step;
    const start = end - window.seconds;
    const selector = selectorFor(servers.map((server) => server.id), containerId);
    const families = Object.fromEntries(INSTANT_QUERIES.map(([family, promql]) => [family, promql]));
    const series = new Map<string, Array<{ ts: number; labels: Record<string, string>; value: number }>>();
    if (selector) {
      const names = [...new Set(metrics.flatMap((metric) => SERIES_FAMILIES[metric]))];
      await Promise.all(names.map(async (family) => {
        series.set(family, await this.queryRange(families[family]?.(selector) ?? '', start, end, window.step));
      }));
    }
    const count = Math.floor(window.seconds / window.step) + 1;
    const timeline = Array.from({ length: count }, (_, index) => (start + index * window.step) * 1000);
    const machine = await this.machineFrame(query.serverId);
    const chart = (metric: PerformanceMetric, pci?: string) => absoluteChart({
      metric,
      containers,
      series,
      containerId,
      timeline,
      pci,
    });
    const cpu = chart('cpu');
    const memory = chart('memory');
    const disk = chart('disk');
    const network = chart('network');
    return {
      range,
      serverId: query.serverId,
      ...(containerId ? { containerId } : {}),
      t: timeline.map((ts) => new Date(ts).toISOString()),
      charts: {
        cpu: { unit: 'cores', yMax: machine.cpuCount, otherCount: cpu.otherCount, lines: cpu.lines },
        memory: { unit: 'bytes', yMax: machine.memoryTotal, otherCount: memory.otherCount, lines: memory.lines },
        disk: { unit: 'bytes', yMax: machine.diskTotal, otherCount: disk.otherCount, lines: disk.lines },
        network: { unit: 'bytes_per_sec', yMax: null, otherCount: network.otherCount, lines: network.lines },
      },
      gpus: machine.gpus.map((card) => {
        const gpu = chart('gpu', card.pci);
        return {
          pci: card.pci,
          index: card.index,
          unit: 'bytes' as const,
          yMax: card.totalBytes,
          otherCount: gpu.otherCount,
          lines: gpu.lines,
        };
      }),
    };
  }

  private async machineFrame(serverId: string) {
    const selector = selectorFor([serverId]);
    const pools = (await this.storagePools.list()).filter((pool) => isLocalPoolDto(pool) && pool.serverId === serverId);
    const poolIds = new Set(pools.map((pool) => pool.id));
    const empty = {
      cpuCount: null as number | null,
      memoryTotal: null as number | null,
      diskTotal: null as number | null,
      gpus: [] as Array<{ pci: string; index: number | null; totalBytes: number | null }>,
    };
    if (!selector) return empty;
    const [cpuCount, memTotal, poolSize, gpuUsedNow, gpuTotal, gpuIndex] = await Promise.all([
      this.vector(`count by (server_id) (nyabase_node_cpu_usage_ratio${selector})`),
      this.vector(`nyabase_node_mem_total_bytes${selector}`),
      this.vector(`last_over_time(nyabase_storage_pool_size_bytes${selector}[3m])`),
      this.vector(`nyabase_node_gpu_mem_used_bytes${selector}`),
      this.vector(`nyabase_node_gpu_mem_total_bytes${selector}`),
      this.vector(`nyabase_node_gpu_smi_index${selector}`),
    ]);
    const diskSizes = poolSize.filter((row) => row.labels.server_id === serverId && poolIds.has(row.labels.pool_id ?? ''));
    return {
      cpuCount: valueFor(cpuCount, serverId),
      memoryTotal: valueFor(memTotal, serverId),
      diskTotal: diskSizes.length === 0 ? null : diskSizes.reduce((sum, row) => sum + row.value, 0),
      gpus: gpuCards(gpuUsedNow, gpuTotal, gpuIndex, serverId).map((card) => ({
        pci: card.pci,
        index: card.index,
        totalBytes: card.totalBytes,
      })),
    };
  }

  private async attachHost(
    usage: PerformanceAdminUsageResponse,
    samples: readonly import('./performance-model.js').ObservedSample[],
    userId: string | null,
  ): Promise<void> {
    const serverIds = usage.servers.map((server) => server.serverId);
    if (serverIds.length === 0) return;
    const selector = selectorFor(serverIds);
    const pools = userId
      ? await this.storagePools.listForUser(userId)
      : (await this.storagePools.list()).filter(isLocalPoolDto);
    const [cpu, cpuCount, memUsed, memTotal, poolUsed, poolSize, gpuUsed, gpuTotal, gpuIndex] = selector
      ? await Promise.all([
        this.vector(`avg by (server_id) (nyabase_node_cpu_usage_ratio${selector})`),
        this.vector(`count by (server_id) (nyabase_node_cpu_usage_ratio${selector})`),
        this.vector(`nyabase_node_mem_used_bytes${selector}`),
        this.vector(`nyabase_node_mem_total_bytes${selector}`),
        this.vector(`last_over_time(nyabase_storage_pool_used_bytes${selector}[3m])`),
        this.vector(`last_over_time(nyabase_storage_pool_size_bytes${selector}[3m])`),
        this.vector(`nyabase_node_gpu_mem_used_bytes${selector}`),
        this.vector(`nyabase_node_gpu_mem_total_bytes${selector}`),
        this.vector(`nyabase_node_gpu_smi_index${selector}`),
      ])
      : [[], [], [], [], [], [], [], [], []];
    for (const server of usage.servers) {
      const used = valueFor(memUsed, server.serverId);
      const total = valueFor(memTotal, server.serverId);
      const rx = sumServer(samples, 'net_rx_bytes_per_sec', server.serverId);
      const tx = sumServer(samples, 'net_tx_bytes_per_sec', server.serverId);
      const serverPools = pools
        .filter((pool) => pool.serverId === server.serverId)
        .sort((left, right) => (left.displayName ?? left.incusName).localeCompare(right.displayName ?? right.incusName));
      server.host = {
        cpuRatio: valueFor(cpu, server.serverId),
        cpuCount: valueFor(cpuCount, server.serverId),
        memory: {
          usedBytes: used,
          limitBytes: total,
          ratio: used !== null && total !== null && total > 0 ? used / total : null,
        },
        network: { rxBytesPerSec: rx, txBytesPerSec: tx },
        disks: serverPools.map((pool) => {
          const poolUsedBytes = valueFor(poolUsed, server.serverId, pool.id) ?? pool.usedBytes ?? null;
          const poolSizeBytes = valueFor(poolSize, server.serverId, pool.id) ?? pool.totalBytes ?? null;
          return {
            id: pool.id,
            name: pool.displayName ?? pool.incusName,
            usedBytes: poolUsedBytes,
            sizeBytes: poolSizeBytes,
            ratio: poolUsedBytes !== null && poolSizeBytes !== null && poolSizeBytes > 0
              ? poolUsedBytes / poolSizeBytes
              : null,
          };
        }),
        gpus: gpuCards(gpuUsed, gpuTotal, gpuIndex, server.serverId),
      };
    }
  }

  private async attachSparklines(usage: PerformanceAdminUsageResponse): Promise<void> {
    const serverIds = usage.servers.map((server) => server.serverId);
    const selector = selectorFor(serverIds);
    if (!selector) return;
    const step = 30;
    const end = Math.floor(Date.now() / 1000 / step) * step;
    const start = end - 29 * step;
    const stamps = Array.from({ length: 30 }, (_, index) => (start + index * step) * 1000);
    const [cpu, memUsed, memTotal, rx, tx, poolUsed, poolSize, gpuUsed, gpuTotal] = await Promise.all([
      this.queryRange(`avg by (server_id) (nyabase_node_cpu_usage_ratio${selector})`, start, end, step),
      this.queryRange(`nyabase_node_mem_used_bytes${selector}`, start, end, step),
      this.queryRange(`nyabase_node_mem_total_bytes${selector}`, start, end, step),
      this.queryRange(`sum by (server_id) (rate(nyabase_container_net_rx_bytes_total${selector}[1m]))`, start, end, step),
      this.queryRange(`sum by (server_id) (rate(nyabase_container_net_tx_bytes_total${selector}[1m]))`, start, end, step),
      this.queryRange(`last_over_time(nyabase_storage_pool_used_bytes${selector}[3m])`, start, end, step),
      this.queryRange(`last_over_time(nyabase_storage_pool_size_bytes${selector}[3m])`, start, end, step),
      this.queryRange(`nyabase_node_gpu_mem_used_bytes${selector}`, start, end, step),
      this.queryRange(`nyabase_node_gpu_mem_total_bytes${selector}`, start, end, step),
    ]);
    for (const server of usage.servers) {
      server.sparkline = {
        t: stamps.map((ts) => new Date(ts).toISOString()),
        cpu: alignRatio(cpu, stamps, server.serverId),
        memory: alignRatioPair(memUsed, memTotal, stamps, server.serverId),
        network: stamps.map((ts) => ({
          rx: alignValue(rx, ts, server.serverId),
          tx: alignValue(tx, ts, server.serverId),
        })),
        disks: server.host.disks.map((disk) => ({
          id: disk.id,
          v: alignRatioPair(poolUsed, poolSize, stamps, server.serverId, disk.id),
        })),
        gpus: server.host.gpus.map((gpu) => ({
          pci: gpu.pci,
          v: alignRatioPair(gpuUsed, gpuTotal, stamps, server.serverId, undefined, gpu.pci),
        })),
      };
    }
  }

  private async resolveServers(
    actorId: string,
    serverId: string | undefined,
    admin: boolean,
  ): Promise<Array<{ id: string; name: string }>> {
    const requested = optionalUuid(serverId, 'serverId');
    if (admin) {
      const rows = await this.database.selectFrom('infra.servers').select(['id', 'name']).execute();
      if (!requested) return rows;
      const found = rows.find((row) => row.id === requested);
      if (!found) throw new NotFoundException('Server not found');
      return [found];
    }
    const allowed = new Set(await this.access.listAccessibleServers(actorId));
    if (requested && !allowed.has(requested)) throw new NotFoundException('Server not found');
    const ids = requested ? [requested] : [...allowed];
    if (ids.length === 0) return [];
    return this.database
      .selectFrom('infra.servers')
      .select(['id', 'name'])
      .where('id', 'in', ids)
      .execute();
  }

  private async loadContainers(
    servers: readonly { id: string; name: string }[],
  ): Promise<InventoryContainer[]> {
    if (servers.length === 0) return [];
    const names = new Map(servers.map((server) => [server.id, server.name]));
    const containers = await this.database
      .selectFrom('control.containers')
      .select(['id', 'server_id', 'owner_id', 'name', 'lifecycle_phase', 'power_intent', 'cpu_millis', 'created_at'])
      .where('server_id', 'in', servers.map((server) => server.id))
      .where('lifecycle_phase', '<>', 'deleting')
      .execute();
    if (containers.length === 0) return [];
    const ownerIds = [...new Set(containers.map((row) => row.owner_id))];
    const containerIds = containers.map((row) => row.id);
    const [users, claims, attachments] = await Promise.all([
      this.database.selectFrom('iam.users').select(['id', 'username', 'display_name']).where('id', 'in', ownerIds).execute(),
      this.database
        .selectFrom('control.extension_device_claims')
        .select(['container_id', 'device_key'])
        .where('extension_id', '=', NVIDIA_GPU_EXTENSION_ID)
        .where('container_id', 'in', containerIds)
        .execute(),
      this.database
        .selectFrom('control.volume_attachments')
        .innerJoin('control.volumes', 'control.volumes.id', 'control.volume_attachments.volume_id')
        .select([
          'control.volume_attachments.container_id as container_id',
          'control.volume_attachments.volume_id as volume_id',
          'control.volumes.name as name',
          'control.volumes.shared_backend_id as shared_backend_id',
        ])
        .where('control.volume_attachments.container_id', 'in', containerIds)
        .execute(),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const pciByContainer = new Map<string, string[]>();
    for (const claim of claims) {
      const pci = canonicalPciAddress(claim.device_key);
      if (!pci) continue;
      const list = pciByContainer.get(claim.container_id) ?? [];
      list.push(pci);
      pciByContainer.set(claim.container_id, list);
    }
    const volumesByContainer = new Map<string, Array<{ volumeId: string; name: string; shared: boolean }>>();
    for (const attachment of attachments) {
      const list = volumesByContainer.get(attachment.container_id) ?? [];
      list.push({
        volumeId: attachment.volume_id,
        name: attachment.name,
        shared: attachment.shared_backend_id != null,
      });
      volumesByContainer.set(attachment.container_id, list);
    }
    return containers.flatMap((row) => {
      const user = userById.get(row.owner_id);
      const serverName = names.get(row.server_id);
      if (!user || !serverName) return [];
      return [{
        id: row.id,
        serverId: row.server_id,
        serverName,
        ownerId: row.owner_id,
        displayName: user.display_name,
        username: user.username,
        name: row.name,
        lifecyclePhase: row.lifecycle_phase,
        powerIntent: row.power_intent,
        cpuMillis: row.cpu_millis,
        createdAt: new Date(row.created_at).getTime(),
        pciAddresses: pciByContainer.get(row.id) ?? [],
        volumes: volumesByContainer.get(row.id) ?? [],
      }];
    });
  }

  private async queryInstant(serverIds: readonly string[]): Promise<ObservedSample[]> {
    const selector = selectorFor(serverIds);
    if (!selector) return [];
    const groups = await Promise.all(INSTANT_QUERIES.map(async ([family, promql, rawName]) => {
      const [rows, times] = await Promise.all([
        this.vector(promql(selector)),
        this.vector(`tlast_over_time(${rawName}${selector}[2m])`),
      ]);
      return rows.map((row) => ({
        family,
        labels: row.labels,
        value: row.value,
        ts: rawSampleTime(times, row.labels),
      }));
    }));
    return groups.flat();
  }

  private async queryScrapeUp(serverIds: readonly string[]) {
    const selector = selectorFor(serverIds);
    const [rows, times] = selector
      ? await Promise.all([
        this.vector(`last_over_time(nyabase_node_scrape_up${selector}[2m])`),
        this.vector(`tlast_over_time(nyabase_node_scrape_up${selector}[2m])`),
      ])
      : [[], []];
    const map = new Map<string, { value: number; ts: number }>();
    for (const row of rows) {
      const serverId = row.labels.server_id;
      if (serverId) map.set(serverId, { value: row.value, ts: rawSampleTime(times, row.labels) });
    }
    return map;
  }

  private async queryRange(promql: string, start: number, end: number, step: number) {
    if (!promql) return [];
    const body = await this.metricsFetch('/api/v1/query_range', { query: promql, start, end, step });
    const result = Array.isArray(body?.data?.result) ? body.data.result : [];
    const points: Array<{ ts: number; labels: Record<string, string>; value: number }> = [];
    for (const series of result) {
      const labels = stringLabels(series.metric);
      const values = Array.isArray(series.values) ? series.values : [];
      for (const pair of values) {
        const ts = Number(pair?.[0]) * 1000;
        const value = Number(pair?.[1]);
        if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
        points.push({ ts, labels, value });
      }
    }
    return points;
  }

  private async vector(promql: string) {
    const body = await this.metricsFetch('/api/v1/query', { query: promql });
    const result = Array.isArray(body?.data?.result) ? body.data.result : [];
    const rows: Array<{ labels: Record<string, string>; value: number; ts: number }> = [];
    for (const series of result) {
      const labels = stringLabels(series.metric);
      const ts = Number(series.value?.[0]) * 1000;
      const value = Number(series.value?.[1]);
      if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
      rows.push({ labels, value, ts });
    }
    return rows;
  }

  private async metricsFetch(
    path: string,
    params: Record<string, string | number>,
  ): Promise<MetricsResponse | null> {
    const base = this.config.get<string>('metrics.victoriaMetricsUrl').replace(/\/$/, '');
    const url = new URL(path, `${base}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
      if (!response.ok) {
        this.logger.warn(`VictoriaMetrics ${path} returned ${response.status}`);
        return null;
      }
      return await response.json() as MetricsResponse;
    } catch (error) {
      this.logger.warn(`VictoriaMetrics ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

export function rawSampleTime(
  times: readonly { labels: Record<string, string>; value: number }[],
  labels: Record<string, string>,
): number {
  const key = seriesIdentity(labels);
  const match = times.find((row) => seriesIdentity(row.labels) === key);
  if (!match || !Number.isFinite(match.value) || match.value <= 0) return 0;
  return match.value * 1000;
}

function seriesIdentity(labels: Record<string, string>): string {
  return [
    labels.server_id ?? '',
    labels.container_id ?? '',
    labels.device ?? '',
    labels.volume_id ?? '',
    labels.gpu_pci ?? '',
  ].join('\0');
}

function valueFor(
  rows: readonly { labels: Record<string, string>; value: number }[],
  serverId: string,
  poolId?: string,
  pci?: string,
): number | null {
  const matches = rows.filter((row) =>
    row.labels.server_id === serverId
    && (poolId === undefined || row.labels.pool_id === poolId)
    && (pci === undefined || row.labels.gpu_pci === pci));
  if (matches.length === 0) return null;
  if (poolId || pci) return matches[0]?.value ?? null;
  return matches.reduce((sum, row) => sum + row.value, 0) / matches.length;
}

function sumServer(
  samples: readonly { family: string; labels: Record<string, string>; value: number }[],
  family: string,
  serverId: string,
): number | null {
  const rows = samples.filter((sample) => sample.family === family && sample.labels.server_id === serverId);
  if (rows.length === 0) return null;
  return rows.reduce((sum, row) => sum + row.value, 0);
}

function gpuCards(
  used: readonly { labels: Record<string, string>; value: number }[],
  total: readonly { labels: Record<string, string>; value: number }[],
  index: readonly { labels: Record<string, string>; value: number }[],
  serverId: string,
) {
  const pcis = new Set<string>();
  for (const row of [...used, ...total, ...index]) {
    if (row.labels.server_id === serverId && row.labels.gpu_pci) pcis.add(row.labels.gpu_pci);
  }
  return [...pcis].map((pci) => {
    const usedBytes = valueFor(used, serverId, undefined, pci);
    const totalBytes = valueFor(total, serverId, undefined, pci);
    const smi = valueFor(index, serverId, undefined, pci);
    return {
      pci,
      index: smi === null ? null : smi,
      usedBytes,
      totalBytes,
      ratio: usedBytes !== null && totalBytes !== null && totalBytes > 0 ? usedBytes / totalBytes : null,
    };
  }).sort((left, right) => (left.index ?? 999) - (right.index ?? 999) || left.pci.localeCompare(right.pci));
}

function alignValue(
  points: readonly { ts: number; labels: Record<string, string>; value: number }[],
  ts: number,
  serverId: string,
  poolId?: string,
  pci?: string,
): number | null {
  const match = points.find((point) =>
    Math.abs(point.ts - ts) < 15_000
    && point.labels.server_id === serverId
    && (poolId === undefined || point.labels.pool_id === poolId)
    && (pci === undefined || point.labels.gpu_pci === pci));
  return match?.value ?? null;
}

function alignRatio(
  points: readonly { ts: number; labels: Record<string, string>; value: number }[],
  stamps: readonly number[],
  serverId: string,
): Array<number | null> {
  return stamps.map((ts) => alignValue(points, ts, serverId));
}

function alignRatioPair(
  used: readonly { ts: number; labels: Record<string, string>; value: number }[],
  total: readonly { ts: number; labels: Record<string, string>; value: number }[],
  stamps: readonly number[],
  serverId: string,
  poolId?: string,
  pci?: string,
): Array<number | null> {
  return stamps.map((ts) => {
    const usedBytes = alignValue(used, ts, serverId, poolId, pci);
    const totalBytes = alignValue(total, ts, serverId, poolId, pci);
    return usedBytes !== null && totalBytes !== null && totalBytes > 0 ? usedBytes / totalBytes : null;
  });
}

function optionalUuid(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!UUID_PATTERN.test(value)) throw new BadRequestException(`${name} is invalid`);
  return value.toLowerCase();
}

function selectorFor(serverIds: readonly string[], containerId?: string): string | null {
  if (serverIds.length === 0) return null;
  const servers = serverIds.map((id) => id.toLowerCase()).join('|');
  const container = containerId ? `,container_id="${containerId}"` : '';
  return `{server_id=~"${servers}"${container}}`;
}

interface MetricsSeries {
  metric?: Record<string, unknown>;
  value?: [number, string];
  values?: Array<[number, string]>;
}

interface MetricsResponse {
  data?: { result?: MetricsSeries[] };
}

function stringLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const labels: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') labels[key] = entry;
  }
  return labels;
}
