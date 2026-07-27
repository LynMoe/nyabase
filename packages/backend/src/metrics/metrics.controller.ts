import {
  Controller, Get, Inject, Param, Query, UseGuards,
  ForbiddenException, NotFoundException,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import {
  AccessResolverService,
  type ResolvedServerGrant,
} from '../access/access-resolver.service.js';
import { UsersService } from '../users/users.service.js';
import type { UserRecord } from '../domain/domain-records.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import {
  HostMetricsDto, GpuMetricsDto, UserMetricsDto, ContainerMetricsDto,
  HostDiskCapacity, HostDiskIo, HostNetIo,
  UserMetrics, ContainerMetrics, type MetricSeries,
  GpuGrantMode, LABEL, MAX_AGENT_GPU_DEVICES,
  type DiskInfo,
} from '@nyabase/common';
import { MetricsQueryService, emptySeries, parseRange } from './metrics-query.service.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import {
  dataDiskDisplayName,
  publicDataDiskDisplayName,
} from '../mount-sources/utils.js';

interface ContainerMetricIdentity {
  containerId: string;
  name: string;
  ownerId: string;
}

interface ContainerMetricSeries {
  cpu: Map<string, MetricSeries>;
  memUsed: Map<string, MetricSeries>;
  gpuMemUsed: Map<string, MetricSeries>;
  diskBps: Map<string, MetricSeries>;
  netBps: Map<string, MetricSeries>;
}

@Controller('metrics')
@UseGuards(JwtAuthGuard)
export class MetricsController {
  constructor(
    private readonly metricsQuery: MetricsQueryService,
    private readonly accessResolver: AccessResolverService,
    private readonly usersService: UsersService,
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly agentGateway: AgentGateway,
  ) {}

  // ---------------------------------------------------------------------------
  // Access check helper
  // ---------------------------------------------------------------------------

  private async ensureAccess(userId: string, serverId: string): Promise<void> {
    try {
      await this.accessResolver.runWithActiveServerAccess(userId, serverId, async () => undefined);
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      throw new NotFoundException('Server not found');
    }
  }

  // ---------------------------------------------------------------------------
  // GET /metrics/servers/:id/host
  // ---------------------------------------------------------------------------

  @Get('servers/:id/host')
  async hostMetrics(
    @Param('id') serverId: string,
    @CurrentUser() user: UserRecord,
    @Query('range') range: string,
  ): Promise<HostMetricsDto> {
    // Capture one physical identity snapshot, then authorize every entry from
    // the same current database transaction. A cached mount grant or a disk
    // replacement at the same logical id must not widen this projection.
    const inventory = [...(this.agentGateway.stateCache.get(serverId)?.disks ?? [])];
    const visibleDisks = await this.currentVisibleLocalDisks(user.id, serverId, inventory);
    return this.hostMetricsFor(serverId, range, {
      includePhysicalTopology: false,
      diskInfos: visibleDisks,
    });
  }

  protected async hostMetricsFor(
    serverId: string,
    range: string,
    options: {
      includePhysicalTopology: boolean;
      diskInfos?: readonly DiskInfo[];
    },
  ): Promise<HostMetricsDto> {
    const { start, end, step } = parseRange(range);
    const srv = promqlLabelMatcher('server', serverId);

    const w = `${step}s`;
    const [cpu, memUsed, memTotal, load1, diskUsedRaw, diskTotalRaw, diskIoRaw, netIoRaw] =
      await Promise.all([
        this.metricsQuery.queryRangeSingle(`nyabase_host_cpu_usage_ratio{${srv}}`, start, end, step),
        this.metricsQuery.queryRangeSingle(`nyabase_host_mem_used_bytes{${srv}}`, start, end, step),
        this.metricsQuery.queryRangeSingle(`nyabase_host_mem_total_bytes{${srv}}`, start, end, step),
        this.metricsQuery.queryRangeSingle(`nyabase_host_load1{${srv}}`, start, end, step),
        this.metricsQuery.queryRangeByLabel(`nyabase_disk_used_bytes{${srv}}`, start, end, step, 'disk_id'),
        this.metricsQuery.queryRangeByLabel(`nyabase_disk_total_bytes{${srv}}`, start, end, step, 'disk_id'),
        this.metricsQuery.queryRangeSingle(
          `rate(nyabase_host_disk_read_bytes_total{${srv}}[${w}]) + rate(nyabase_host_disk_write_bytes_total{${srv}}[${w}])`,
          start, end, step,
        ),
        this.metricsQuery.queryRangeSingle(
          `rate(nyabase_host_net_rx_bytes_total{${srv}}[${w}]) + rate(nyabase_host_net_tx_bytes_total{${srv}}[${w}])`,
          start, end, step,
        ),
      ]);

    const diskInfos = options.diskInfos
      ?? (this.agentGateway.stateCache.get(serverId)?.disks ?? []);
    const disks: HostDiskCapacity[] = diskInfos.map((d) => ({
      diskId: d.diskId,
      displayName: options.includePhysicalTopology
        ? dataDiskDisplayName(d.mountPoint, d.label)
        : publicDataDiskDisplayName(d.diskId, d.label),
      ...(options.includePhysicalTopology ? { mountPoint: d.mountPoint } : {}),
      used: diskUsedRaw.get(d.diskId) ?? emptySeries(step),
      total: diskTotalRaw.get(d.diskId) ?? emptySeries(step),
    }));

    const diskIo = aggregateTopologySeries<HostDiskIo>(
      'All disks',
      [diskIoRaw],
      step,
    );
    const netIo = aggregateTopologySeries<HostNetIo>(
      'All interfaces',
      [netIoRaw],
      step,
    );

    return { cpu, memUsed, memTotal, load1, disks, diskIo, netIo };
  }

  private async currentVisibleLocalDisks(
    userId: string,
    serverId: string,
    inventory: readonly DiskInfo[],
  ): Promise<DiskInfo[]> {
    try {
      return await this.accessResolver.runWithActiveServerAccess(
        userId,
        serverId,
        async (manager) => {
          const visible: DiskInfo[] = [];
          for (const disk of inventory) {
            if (await this.accessResolver.hasMountSourceAccessInTransaction(
              manager,
              userId,
              serverId,
              { kind: 'local', id: disk.diskId },
              disk.sourceIdentity,
            )) visible.push(disk);
          }
          return visible;
        },
      );
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      throw new NotFoundException('Server not found');
    }
  }

  // ---------------------------------------------------------------------------
  // GET /metrics/servers/:id/gpus
  // ---------------------------------------------------------------------------

  @Get('servers/:id/gpus')
  async gpuMetrics(
    @Param('id') serverId: string,
    @CurrentUser() user: UserRecord,
    @Query('range') range: string,
  ): Promise<GpuMetricsDto> {
    const grant = await this.currentServerGrant(user.id, serverId);
    const allowedGpuIndices = grant.gpuMode === GpuGrantMode.All
      ? undefined
      : new Set(grant.gpuMode === GpuGrantMode.Indices ? grant.gpuIndices : []);
    return this.gpuMetricsFor(serverId, range, allowedGpuIndices);
  }

  protected async gpuMetricsFor(
    serverId: string,
    range: string,
    allowedGpuIndices?: ReadonlySet<number>,
  ): Promise<GpuMetricsDto> {
    const { start, end, step } = parseRange(range);
    const srv = promqlLabelMatcher('server', serverId);

    const [utilRaw, memUsedRaw, tempRaw, powerRaw, graphicsClockRaw] = await Promise.all([
      this.metricsQuery.queryRangeByLabel(`nyabase_gpu_util_ratio{${srv}}`, start, end, step, 'gpu_index'),
      this.metricsQuery.queryRangeByLabel(`nyabase_gpu_mem_used_bytes{${srv}}`, start, end, step, 'gpu_index'),
      this.metricsQuery.queryRangeByLabel(`nyabase_gpu_temp_celsius{${srv}}`, start, end, step, 'gpu_index'),
      this.metricsQuery.queryRangeByLabel(`nyabase_gpu_power_watts{${srv}}`, start, end, step, 'gpu_index'),
      this.metricsQuery.queryRangeByLabel(
        `nyabase_gpu_clock_graphics_mhz{${srv}}`,
        start,
        end,
        step,
        'gpu_index',
      ),
    ]);

    const inventory = this.agentGateway.stateCache.get(serverId)?.gpus ?? [];
    const inventoryByIndex = new Map(inventory.map((gpu) => [gpu.index, gpu]));
    const allIndices = new Set<number>([
      ...inventoryByIndex.keys(),
      ...Array.from(utilRaw.keys(), Number),
      ...Array.from(memUsedRaw.keys(), Number),
      ...Array.from(tempRaw.keys(), Number),
      ...Array.from(powerRaw.keys(), Number),
      ...Array.from(graphicsClockRaw.keys(), Number),
    ]);

    const gpus = Array.from(allIndices)
      .filter((index) => Number.isSafeInteger(index)
        && index >= 0
        && index < MAX_AGENT_GPU_DEVICES
        && (allowedGpuIndices === undefined || allowedGpuIndices.has(index)))
      .sort((a, b) => a - b)
      .map((index) => {
        const idxStr = String(index);
        const gpu = inventoryByIndex.get(index);
        return {
          index,
          model: gpu?.model ?? `GPU ${idxStr}`,
          memTotalMiB: gpu?.totalMemMiB ?? 0,
          util: utilRaw.get(idxStr) ?? emptySeries(step),
          memUsed: memUsedRaw.get(idxStr) ?? emptySeries(step),
          temp: tempRaw.get(idxStr) ?? emptySeries(step),
          power: powerRaw.get(idxStr) ?? emptySeries(step),
          graphicsClockMHz: graphicsClockRaw.get(idxStr) ?? emptySeries(step),
        };
      });

    return { gpus };
  }

  private async currentServerGrant(
    userId: string,
    serverId: string,
  ): Promise<ResolvedServerGrant> {
    try {
      return await this.accessResolver.runWithActiveServerAccess(
        userId,
        serverId,
        async (manager) => {
          const grant = await this.accessResolver.resolveServerInTransaction(
            manager,
            userId,
            serverId,
          );
          if (!grant) throw new ForbiddenException('Server access was revoked');
          return grant;
        },
      );
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      throw new NotFoundException('Server not found');
    }
  }

  // ---------------------------------------------------------------------------
  // GET /metrics/servers/:id/users
  // ---------------------------------------------------------------------------

  @Get('servers/:id/users')
  async userMetrics(
    @Param('id') serverId: string,
    @CurrentUser() user: UserRecord,
    @Query('range') range: string,
  ): Promise<UserMetricsDto> {
    await this.ensureAccess(user.id, serverId);
    return this.userMetricsFor(serverId, user, range, false);
  }

  protected async userMetricsFor(
    serverId: string,
    user: UserRecord,
    range: string,
    viewAll: boolean,
  ): Promise<UserMetricsDto> {
    const { start, end, step } = parseRange(range);
    const srv = promqlLabelMatcher('server', serverId);
    const window = `${step}s`;
    const diskOwnerFilter = viewAll
      ? ''
      : await this.diskOwnerFilter(user.id);

    const [containerSeries, containerMap, diskUsedRaw] = await Promise.all([
      this.queryContainerMetricSeries(srv, window, start, end, step),
      this.containerIdentityMap(serverId),
      this.metricsQuery.queryRangeByLabel(
        `nyabase_user_disk_used_bytes{${srv}${diskOwnerFilter}}`,
        start, end, step, 'user_id',
      ),
    ]);

    const normalizedSeries = this.normalizeContainerMetricSeries(containerSeries, containerMap, step);
    const ownerId = viewAll ? undefined : user.id;
    const cpuRaw = this.aggregateByOwner(normalizedSeries.cpu, containerMap, step, ownerId);
    const memRaw = this.aggregateByOwner(normalizedSeries.memUsed, containerMap, step, ownerId);
    const gpuRaw = this.aggregateByOwner(normalizedSeries.gpuMemUsed, containerMap, step, ownerId);
    const diskBpsRaw = this.aggregateByOwner(normalizedSeries.diskBps, containerMap, step, ownerId);
    const netBpsRaw = this.aggregateByOwner(normalizedSeries.netBps, containerMap, step, ownerId);

    const rawUserIds = viewAll
      ? new Set<string>([
        ...cpuRaw.keys(),
        ...memRaw.keys(),
        ...gpuRaw.keys(),
        ...diskBpsRaw.keys(),
        ...netBpsRaw.keys(),
        ...diskUsedRaw.keys(),
      ])
      : new Set<string>([user.id]);
    rawUserIds.delete('');
    rawUserIds.delete('__unknown__');

    const userMap = await this.resolveMetricUsers(rawUserIds, [user]);

    const allUserIds = viewAll
      ? new Set(
        [...rawUserIds]
          .map((id) => userMap.get(id)?.id ?? (/^\d+$/.test(id) ? null : id))
          .filter((id): id is string => id !== null),
      )
      : new Set<string>([user.id]);

    const metricFor = (raw: Map<string, MetricSeries>, userId: string) =>
      raw.get(userId) ?? emptySeries(step);

    const users: UserMetrics[] = Array.from(allUserIds).map((userId) => {
      const entity = userMap.get(userId) ?? (user.id === userId ? user : undefined);
      return {
        userId: entity?.id ?? userId,
        username: entity?.username ?? userId,
        displayName: entity?.displayName ?? userId,
        cpu: metricFor(cpuRaw, userId),
        memUsed: metricFor(memRaw, userId),
        gpuMemUsed: metricFor(gpuRaw, userId),
        diskBps: metricFor(diskBpsRaw, userId),
        netBps: metricFor(netBpsRaw, userId),
        diskUsed: this.metricForUserIdOrNumericId(diskUsedRaw, userId, entity, step),
      };
    });

    return { users };
  }

  // ---------------------------------------------------------------------------
  // GET /metrics/servers/:id/containers
  // ---------------------------------------------------------------------------

  @Get('servers/:id/containers')
  async containerMetrics(
    @Param('id') serverId: string,
    @CurrentUser() user: UserRecord,
    @Query('range') range: string,
  ): Promise<ContainerMetricsDto> {
    await this.ensureAccess(user.id, serverId);
    return this.containerMetricsFor(serverId, user, range, false);
  }

  protected async containerMetricsFor(
    serverId: string,
    user: UserRecord,
    range: string,
    viewAll: boolean,
  ): Promise<ContainerMetricsDto> {
    const { start, end, step } = parseRange(range);
    const srv = promqlLabelMatcher('server', serverId);
    const window = `${step}s`;

    const [series, containerMap] = await Promise.all([
      this.queryContainerMetricSeries(srv, window, start, end, step),
      this.containerIdentityMap(serverId),
    ]);
    const normalizedSeries = this.normalizeContainerMetricSeries(series, containerMap, step);

    const allContainerIds = new Set<string>([
      ...normalizedSeries.cpu.keys(), ...normalizedSeries.memUsed.keys(), ...normalizedSeries.gpuMemUsed.keys(),
      ...normalizedSeries.diskBps.keys(), ...normalizedSeries.netBps.keys(),
    ]);
    allContainerIds.delete('');
    allContainerIds.delete('__unknown__');

    const containers: ContainerMetrics[] = Array.from(allContainerIds).flatMap((shortId) => {
      const info = containerMap.get(shortId);
      if (!viewAll && info?.ownerId !== user.id) return [];
      return [{
        containerId: shortId,
        name: info?.name ?? shortId,
        ownerId: info?.ownerId ?? '',
        cpu: normalizedSeries.cpu.get(shortId) ?? emptySeries(step),
        memUsed: normalizedSeries.memUsed.get(shortId) ?? emptySeries(step),
        gpuMemUsed: normalizedSeries.gpuMemUsed.get(shortId) ?? emptySeries(step),
        diskBps: normalizedSeries.diskBps.get(shortId) ?? emptySeries(step),
        netBps: normalizedSeries.netBps.get(shortId) ?? emptySeries(step),
      }];
    });

    return { containers };
  }

  private async queryContainerMetricSeries(
    srv: string,
    window: string,
    start: number,
    end: number,
    step: number,
  ): Promise<ContainerMetricSeries> {
    const [cpu, memUsed, gpuMemUsed, diskRead, diskWrite, netRx, netTx] = await Promise.all([
      this.metricsQuery.queryRangeByLabel(
        `sum by (container_id) (rate(nyabase_container_cpu_usage_usec{${srv}}[${window}]) / 1e6) or sum by (container_id) (nyabase_container_cpu_usage_ratio{${srv}})`,
        start, end, step, 'container_id',
      ),
      this.metricsQuery.queryRangeByLabel(
        `sum by (container_id) (nyabase_container_mem_used_bytes{${srv}})`,
        start, end, step, 'container_id',
      ),
      this.metricsQuery.queryRangeByLabel(
        `sum by (container_id) (nyabase_gpu_proc_mem_used_bytes{${srv}})`,
        start, end, step, 'container_id',
      ),
      this.metricsQuery.queryRangeByLabel(
        `sum by (container_id) (rate(nyabase_container_io_read_bytes_total{${srv}}[${window}]))`,
        start, end, step, 'container_id',
      ),
      this.metricsQuery.queryRangeByLabel(
        `sum by (container_id) (rate(nyabase_container_io_write_bytes_total{${srv}}[${window}]))`,
        start, end, step, 'container_id',
      ),
      this.metricsQuery.queryRangeByLabel(
        `sum by (container_id) (rate(nyabase_container_net_rx_bytes_total{${srv}}[${window}]))`,
        start, end, step, 'container_id',
      ),
      this.metricsQuery.queryRangeByLabel(
        `sum by (container_id) (rate(nyabase_container_net_tx_bytes_total{${srv}}[${window}]))`,
        start, end, step, 'container_id',
      ),
    ]);

    return {
      cpu,
      memUsed,
      gpuMemUsed,
      diskBps: this.mergeSeriesMaps(diskRead, diskWrite, step),
      netBps: this.mergeSeriesMaps(netRx, netTx, step),
    };
  }

  private async containerIdentityMap(serverId: string): Promise<Map<string, ContainerMetricIdentity>> {
    const result = new Map<string, ContainerMetricIdentity>();
    const desiredContainers = await this.database
      .selectFrom('control.containers')
      .select(['id', 'name', 'owner_id'])
      .where('server_id', '=', serverId)
      .execute();
    const desiredById = new Map(desiredContainers.map((container) => [container.id, container]));

    for (const container of desiredContainers) {
      result.set(container.id, {
        containerId: container.id,
        name: container.name,
        ownerId: container.owner_id,
      });
    }

    for (const runtime of this.agentGateway.stateCache.get(serverId)?.containers.values() ?? []) {
      const desiredId = runtime.labels?.[LABEL.CONTAINER_ID];
      const container = desiredId ? desiredById.get(desiredId) : undefined;
      const runtimeId = runtime.runtime.runtimeId;
      const ownerId = container?.owner_id ?? '';
      const name = container?.name ?? runtimeId.slice(0, 12);
      const info = { containerId: desiredId ?? runtimeId.slice(0, 12), name, ownerId };
      result.set(runtimeId, info);
      result.set(runtimeId.slice(0, 12), info);
      if (desiredId) result.set(desiredId, info);
    }

    return result;
  }

  private normalizeContainerMetricSeries(
    series: ContainerMetricSeries,
    containerMap: Map<string, ContainerMetricIdentity>,
    step: number,
  ): ContainerMetricSeries {
    return {
      cpu: this.normalizeSeriesByContainerId(series.cpu, containerMap, step),
      memUsed: this.normalizeSeriesByContainerId(series.memUsed, containerMap, step),
      gpuMemUsed: this.normalizeSeriesByContainerId(series.gpuMemUsed, containerMap, step),
      diskBps: this.normalizeSeriesByContainerId(series.diskBps, containerMap, step),
      netBps: this.normalizeSeriesByContainerId(series.netBps, containerMap, step),
    };
  }

  private normalizeSeriesByContainerId(
    raw: Map<string, MetricSeries>,
    containerMap: Map<string, ContainerMetricIdentity>,
    step: number,
  ): Map<string, MetricSeries> {
    const result = new Map<string, MetricSeries>();
    for (const [containerId, series] of raw) {
      const canonicalId = containerMap.get(containerId)?.containerId ?? containerId;
      result.set(canonicalId, this.mergeGaugeAliasSeries(result.get(canonicalId) ?? emptySeries(step), series, step));
    }
    return result;
  }

  private aggregateByOwner(
    raw: Map<string, MetricSeries>,
    containerMap: Map<string, ContainerMetricIdentity>,
    step: number,
    ownerId?: string,
  ): Map<string, MetricSeries> {
    const result = new Map<string, MetricSeries>();
    for (const [containerId, series] of raw) {
      const info = containerMap.get(containerId);
      if (!info?.ownerId) continue;
      if (ownerId && info.ownerId !== ownerId) continue;
      result.set(info.ownerId, this.addSeries(result.get(info.ownerId) ?? emptySeries(step), series, step));
    }
    return result;
  }

  private mergeSeriesMaps(
    left: Map<string, MetricSeries>,
    right: Map<string, MetricSeries>,
    step: number,
  ): Map<string, MetricSeries> {
    const result = new Map<string, MetricSeries>();
    const keys = new Set([...left.keys(), ...right.keys()]);
    for (const key of keys) {
      result.set(key, this.addSeries(left.get(key) ?? emptySeries(step), right.get(key) ?? emptySeries(step), step));
    }
    return result;
  }

  private addSeries(left: MetricSeries, right: MetricSeries, step: number): MetricSeries {
    const values = new Map<number, number | null>();
    for (const point of left.points) {
      values.set(point.t, point.v ?? null);
    }
    for (const point of right.points) {
      if (!values.has(point.t)) {
        values.set(point.t, point.v ?? null);
        continue;
      }
      const prev = values.get(point.t);
      values.set(point.t, this.addNullableMetricValues(prev, point.v ?? null));
    }
    return {
      step,
      points: [...values.entries()]
        .sort(([leftT], [rightT]) => leftT - rightT)
        .map(([t, v]) => ({ t, v })),
    };
  }

  private addNullableMetricValues(left: number | null | undefined, right: number | null): number | null {
    if (left == null && right == null) return null;
    if (left == null) return right;
    if (right == null) return left;
    return left + right;
  }

  private metricForUserIdOrNumericId(
    raw: Map<string, MetricSeries>,
    userId: string,
    entity: UserRecord | undefined,
    step: number,
  ): MetricSeries {
    const series = raw.get(userId) ?? emptySeries(step);
    if (entity?.numericId == null) return series;
    return this.mergeGaugeAliasSeries(series, raw.get(String(entity.numericId)) ?? emptySeries(step), step);
  }

  private mergeGaugeAliasSeries(primary: MetricSeries, alias: MetricSeries, step: number): MetricSeries {
    const values = new Map<number, number | null>();
    for (const point of alias.points) {
      values.set(point.t, point.v ?? null);
    }
    for (const point of primary.points) {
      values.set(point.t, point.v ?? null);
    }
    return {
      step,
      points: [...values.entries()]
        .sort(([leftT], [rightT]) => leftT - rightT)
        .map(([t, v]) => ({ t, v })),
    };
  }

  private async resolveMetricUsers(
    rawUserIds: Set<string>,
    fallbacks: UserRecord[],
  ): Promise<Map<string, UserRecord>> {
    const ids = [...rawUserIds].filter((id) => id && id !== '__unknown__');
    const numericIds = ids
      .filter((id) => /^\d+$/.test(id))
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id));
    const uuidIds = new Set(ids.filter((id) => !/^\d+$/.test(id)));

    if (numericIds.length > 0) {
      const uuidByNumeric = await this.usersService.getUserIdsByNumericIds(numericIds);
      for (const uuid of uuidByNumeric.values()) uuidIds.add(uuid);
    }
    for (const fallback of fallbacks) {
      if (fallback.id) uuidIds.add(fallback.id);
    }

    const entities = uuidIds.size > 0 ? await this.usersService.findByIds([...uuidIds]) : [];
    const byId = new Map<string, UserRecord>();
    for (const fallback of fallbacks) {
      if (fallback.id) byId.set(fallback.id, fallback);
    }
    for (const entity of entities) {
      byId.set(entity.id, entity);
      if (entity.numericId != null) byId.set(String(entity.numericId), entity);
    }
    for (const fallback of fallbacks) {
      if (fallback.numericId != null && fallback.id) byId.set(String(fallback.numericId), fallback);
    }
    return byId;
  }

  private async diskOwnerFilter(userId: string): Promise<string> {
    const numericMap = await this.usersService.getNumericIdsByUserIds([userId]);
    const numericId = numericMap.get(userId);
    if (numericId == null) return `,${promqlLabelMatcher('user_id', userId)}`;
    const exactOwnerAlternatives = `${escapePromqlRegex(userId)}|${numericId}`;
    return `,user_id=~${promqlStringLiteral(exactOwnerAlternatives)}`;
  }

}

function aggregateTopologySeries<T extends HostDiskIo | HostNetIo>(
  label: string,
  source: Iterable<MetricSeries>,
  step: number,
): T[] {
  const rows = [...source];
  if (rows.length === 0) return [];
  const values = new Map<number, { sum: number; observed: boolean }>();
  for (const series of rows) {
    for (const point of series.points) {
      const current = values.get(point.t) ?? { sum: 0, observed: false };
      if (point.v !== null) {
        current.sum += point.v;
        current.observed = true;
      }
      values.set(point.t, current);
    }
  }
  return [{
    label,
    bps: {
      step,
      points: [...values.entries()]
        .sort(([left], [right]) => left - right)
        .map(([t, value]) => ({ t, v: value.observed ? value.sum : null })),
    },
  } as T];
}

/** Keep all request-derived values inside one PromQL string literal. */
function promqlStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function promqlLabelMatcher(label: string, value: string): string {
  return `${label}=${promqlStringLiteral(value)}`;
}

/** Escape a literal embedded in a Prometheus/RE2 regular expression. */
function escapePromqlRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
