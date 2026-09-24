import type {
  PerformanceAdminUsageResponse,
  PerformanceContainerRow,
  PerformanceCpu,
  PerformanceHostSnapshot,
  PerformanceMetric,
  PerformancePersonRow,
  PerformanceQuantity,
  PerformanceSeriesLine,
  PerformanceSeriesPoint,
  PerformanceUsageResponse,
  PerformanceVolumeUsage,
} from '@nyabase/common';

export const PERFORMANCE_FRESHNESS_MS = 45_000;
export const PERFORMANCE_CONTAINER_CAP = 2_000;
export const PERFORMANCE_SERIES_LIMIT = 8;

export interface InventoryContainer {
  id: string;
  serverId: string;
  serverName: string;
  ownerId: string;
  displayName: string;
  username: string;
  name: string;
  lifecyclePhase: string;
  powerIntent: string;
  cpuMillis: number;
  createdAt: number;
  pciAddresses: string[];
  volumes: Array<{ volumeId: string; name: string; shared: boolean }>;
}

export function emptyHost(): PerformanceHostSnapshot {
  return {
    cpuRatio: null,
    cpuCount: null,
    memory: { usedBytes: null, limitBytes: null, ratio: null },
    network: { rxBytesPerSec: null, txBytesPerSec: null },
    disks: [],
    gpus: [],
  };
}

export interface ObservedSample {
  family: string;
  labels: Record<string, string>;
  value: number;
  ts: number;
}

interface Reading {
  value: number;
  ts: number;
}

export function cpuLimitCores(cpuMillis: number, kernelCores: number | null): number | null {
  if (cpuMillis > 0) return cpuMillis / 1000;
  if (kernelCores !== null && kernelCores > 0) return kernelCores;
  return null;
}

export function buildUsage(input: {
  containers: readonly InventoryContainer[];
  samples: readonly ObservedSample[];
  scrapeUp: ReadonlyMap<string, Reading>;
  now: number;
  admin: boolean;
}): PerformanceAdminUsageResponse {
  const samples = ownedSamples(input.samples, input.containers);
  const byContainer = indexSamples(samples);
  const unattributedByServer = unattributedGpu(input.samples);
  const containers = [...input.containers].sort((left, right) =>
    left.serverName.localeCompare(right.serverName)
    || left.username.localeCompare(right.username)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id));
  const truncated = containers.length > PERFORMANCE_CONTAINER_CAP;
  const visible = truncated ? containers.slice(0, PERFORMANCE_CONTAINER_CAP) : containers;
  const peopleSource = containers;
  const servers = new Map<string, {
    serverId: string;
    serverName: string;
    people: Map<string, InventoryContainer[]>;
    containers: PerformanceContainerRow[];
    newest: number | null;
  }>();
  for (const container of peopleSource) {
    const server = servers.get(container.serverId) ?? {
      serverId: container.serverId,
      serverName: container.serverName,
      people: new Map(),
      containers: [],
      newest: null,
    };
    const group = server.people.get(container.ownerId) ?? [];
    group.push(container);
    server.people.set(container.ownerId, group);
    servers.set(container.serverId, server);
  }
  const rows = visible.map((container) => containerRow(container, byContainer, unattributedByServer));
  for (const row of rows) {
    const server = servers.get(row.containerId ? input.containers.find((item) => item.id === row.containerId)?.serverId ?? '' : '');
    if (!server) continue;
    server.containers.push(row);
  }
  const serverRows = [...servers.values()].map((server) => {
    const people = [...server.people.entries()].map(([userId, group]) =>
      personRow(userId, group, byContainer, unattributedByServer));
    const newest = newestSample(server.serverId, samples, input.scrapeUp);
    const scrape = input.scrapeUp.get(server.serverId);
    const containerSamples = samples.filter((sample) =>
      sample.labels.server_id === server.serverId
      && sample.labels.container_id
      && sample.labels.container_id !== '__unattributed__');
    const staleSamples = containerSamples.filter((sample) => input.now - sample.ts > PERFORMANCE_FRESHNESS_MS);
    const scrapeStale = !scrape
      || scrape.value === 0
      || input.now - scrape.ts > PERFORMANCE_FRESHNESS_MS;
    const stale = scrapeStale || staleSamples.length > 0;
    const sampledAtMs = staleSamples.length > 0
      ? Math.min(...staleSamples.map((sample) => sample.ts))
      : newest;
    return {
      serverId: server.serverId,
      serverName: server.serverName,
      stale,
      sampledAt: sampledAtMs === null ? null : new Date(sampledAtMs).toISOString(),
      people,
      containers: server.containers,
      unattributedGpu: unattributedByServer.get(server.serverId) ?? [],
      host: emptyHost(),
      sparkline: null,
    };
  }).sort((left, right) => left.serverName.localeCompare(right.serverName));
  const sampledAt = serverRows.reduce<string | null>((latest, server) => {
    if (!server.sampledAt) return latest;
    if (!latest || server.sampledAt > latest) return server.sampledAt;
    return latest;
  }, null);
  return { sampledAt, truncated, servers: serverRows };
}

export function toUserUsage(admin: PerformanceAdminUsageResponse): PerformanceUsageResponse {
  return {
    sampledAt: admin.sampledAt,
    servers: admin.servers.map((server) => ({
      serverId: server.serverId,
      serverName: server.serverName,
      stale: server.stale,
      sampledAt: server.sampledAt,
      people: server.people,
      host: server.host,
      sparkline: server.sparkline,
    })),
  };
}

export function buildSeries(input: {
  metric: PerformanceMetric;
  containers: readonly InventoryContainer[];
  series: ReadonlyMap<string, Array<{ ts: number; labels: Record<string, string>; value: number }>>;
  containerId?: string;
  timeline?: readonly number[];
}): PerformanceSeriesLine[] {
  return buildChart(input).lines;
}

export function buildChart(input: {
  metric: PerformanceMetric;
  containers: readonly InventoryContainer[];
  series: ReadonlyMap<string, Array<{ ts: number; labels: Record<string, string>; value: number }>>;
  containerId?: string;
  timeline?: readonly number[];
}): { lines: PerformanceSeriesLine[]; otherCount: number } {
  const containers = input.containerId
    ? input.containers.filter((container) => container.id === input.containerId)
    : input.containers;
  const stamps = new Set<number>(input.timeline ?? []);
  if (!input.timeline) {
    for (const points of input.series.values()) {
      for (const point of points) stamps.add(point.ts);
    }
  }
  const timeline = [...stamps].sort((left, right) => left - right);
  if (input.containerId) {
    const container = containers[0];
    if (!container) return { lines: [], otherCount: 0 };
    return { otherCount: 0, lines: [{
      key: container.id,
      label: container.name,
      points: timeline.map((ts) => ({
        t: new Date(ts).toISOString(),
        v: metricAt(input.metric, [container], input.series, ts),
      })),
    }] };
  }
  const byOwner = new Map<string, InventoryContainer[]>();
  for (const container of containers) {
    const group = byOwner.get(container.ownerId) ?? [];
    group.push(container);
    byOwner.set(container.ownerId, group);
  }
  const lines = [...byOwner.entries()].map(([userId, group]) => ({
    key: userId,
    label: group[0]?.displayName || group[0]?.username || userId,
    points: timeline.map((ts) => ({
      t: new Date(ts).toISOString(),
      v: metricAt(input.metric, group, input.series, ts),
    })),
    rank: lastValue(timeline, (ts) => metricAt(input.metric, group, input.series, ts)),
  }));
  lines.sort((left, right) => (right.rank ?? -1) - (left.rank ?? -1) || left.label.localeCompare(right.label));
  const head = lines.slice(0, PERFORMANCE_SERIES_LIMIT);
  const rest = lines.slice(PERFORMANCE_SERIES_LIMIT);
  const result: PerformanceSeriesLine[] = head.map(({ key, label, points }) => ({ key, label, points }));
  const restContainers = rest.flatMap((line) => byOwner.get(line.key) ?? []);
  if (restContainers.length > 0) {
    result.push({
      key: 'other',
      label: '其他',
      points: timeline.map((ts) => ({
        t: new Date(ts).toISOString(),
        v: metricAt(input.metric, restContainers, input.series, ts),
      })),
    });
  }
  return { lines: result, otherCount: rest.length };
}

export function absoluteChart(input: {
  metric: PerformanceMetric;
  containers: readonly InventoryContainer[];
  series: ReadonlyMap<string, Array<{ ts: number; labels: Record<string, string>; value: number }>>;
  containerId?: string;
  timeline: readonly number[];
  pci?: string;
}): { lines: PerformanceSeriesLine[]; otherCount: number } {
  const containers = input.containerId
    ? input.containers.filter((container) => container.id === input.containerId)
    : input.containers;
  const read = (group: readonly InventoryContainer[], ts: number) => {
    const live = group.filter((container) => container.createdAt <= ts);
    if (live.length === 0) return null;
    return absoluteUsed(input.metric, live, input.series, ts, input.pci) ?? 0;
  };
  const pointsFor = (group: readonly InventoryContainer[]) => input.timeline.map((ts) => ({
    t: new Date(ts).toISOString(),
    v: read(group, ts),
  }));
  if (input.containerId) {
    const container = containers[0];
    if (!container) return { lines: [], otherCount: 0 };
    return { otherCount: 0, lines: [{ key: container.id, label: container.name, points: pointsFor([container]) }] };
  }
  const byOwner = new Map<string, InventoryContainer[]>();
  for (const container of containers) {
    const group = byOwner.get(container.ownerId) ?? [];
    group.push(container);
    byOwner.set(container.ownerId, group);
  }
  const lines = [...byOwner.entries()].map(([userId, group]) => ({
    key: userId,
    label: group[0]?.displayName || group[0]?.username || userId,
    points: pointsFor(group),
    rank: lastValue(input.timeline, (ts) => read(group, ts)),
  }));
  lines.sort((left, right) => (right.rank ?? -1) - (left.rank ?? -1) || left.label.localeCompare(right.label));
  const head = lines.slice(0, PERFORMANCE_SERIES_LIMIT);
  const rest = lines.slice(PERFORMANCE_SERIES_LIMIT);
  const result: PerformanceSeriesLine[] = head.map(({ key, label, points }) => ({ key, label, points }));
  const restContainers = rest.flatMap((line) => byOwner.get(line.key) ?? []);
  if (restContainers.length > 0) {
    result.push({
      key: 'other',
      label: '其他',
      points: pointsFor(restContainers),
    });
  }
  return { lines: result, otherCount: rest.length };
}

function containerRow(
  container: InventoryContainer,
  samples: Map<string, Map<string, Reading[]>>,
  unattributed: Map<string, Array<{ gpuPci: string; usedBytes: number }>>,
): PerformanceContainerRow {
  const cpu = cpuFor(container, samples);
  const memory = memoryFor(container, samples);
  const gpu = gpuFor(container, samples, unattributed);
  const disk = diskFor(container, samples);
  const network = networkFor(container.id, samples);
  return {
    containerId: container.id,
    name: container.name,
    userId: container.ownerId,
    displayName: container.displayName,
    username: container.username,
    lifecyclePhase: container.lifecyclePhase,
    powerIntent: container.powerIntent,
    cpu,
    memory,
    gpu: { ...gpu, pciAddresses: container.pciAddresses },
    disk,
    network,
    volumes: volumesFor(container, samples),
  };
}

function personRow(
  userId: string,
  containers: readonly InventoryContainer[],
  samples: Map<string, Map<string, Reading[]>>,
  unattributed: Map<string, Array<{ gpuPci: string; usedBytes: number }>>,
): PerformancePersonRow {
  const first = containers[0];
  const cpus = containers.map((container) => cpuFor(container, samples));
  const memories = containers.map((container) => memoryFor(container, samples));
  const gpus = containers.map((container) => gpuFor(container, samples, unattributed));
  const disks = containers.map((container) => diskFor(container, samples));
  const networks = containers.map((container) => networkFor(container.id, samples));
  const cpuUnlimited = containers.some((container) => container.cpuMillis <= 0);
  const memoryUnlimited = memories.some((memory) => memory.limitBytes === null || memory.limitBytes === 0);
  const usageCores = sumNullable(cpus.map((cpu) => cpu.usageCores));
  const limitCores = cpuUnlimited ? null : sumNullable(cpus.map((cpu) => cpu.limitCores));
  const usedMemory = sumNullable(memories.map((memory) => memory.usedBytes));
  const limitMemory = memoryUnlimited ? null : sumNullable(memories.map((memory) => memory.limitBytes));
  const gpuUsed = sumNullable(gpus.map((gpu) => gpu.usedBytes));
  const gpuLimit = sumNullable(gpus.map((gpu) => gpu.limitBytes));
  const diskParts = disks.filter((disk) => disk.usedBytes !== null && disk.sizeBytes !== null && disk.sizeBytes > 0);
  const diskUsed = sumNullable(diskParts.map((disk) => disk.usedBytes));
  const diskSize = sumNullable(diskParts.map((disk) => disk.sizeBytes));
  return {
    userId,
    displayName: first?.displayName ?? '',
    username: first?.username ?? '',
    containerCount: containers.length,
    missingSamples: cpus.filter((cpu) => cpu.usageCores === null).length,
    cpu: {
      usageCores,
      limitCores,
      ratio: limitCores !== null && limitCores > 0 && usageCores !== null ? usageCores / limitCores : null,
    },
    memory: quantity(usedMemory, limitMemory),
    gpu: {
      ...quantity(gpuUsed, gpuLimit),
      cardCount: containers.reduce((sum, container) => sum + container.pciAddresses.length, 0),
    },
    disk: {
      usedBytes: diskUsed,
      sizeBytes: diskSize,
      ratio: diskUsed !== null && diskSize !== null && diskSize > 0 ? diskUsed / diskSize : null,
    },
    network: {
      rxBytesPerSec: sumNullable(networks.map((network) => network.rxBytesPerSec)),
      txBytesPerSec: sumNullable(networks.map((network) => network.txBytesPerSec)),
    },
  };
}

function cpuFor(
  container: InventoryContainer,
  samples: Map<string, Map<string, Reading[]>>,
): PerformanceCpu {
  const usage = one(samples, 'cpu_usage_cores', container.id);
  const kernel = one(samples, 'cpu_limit_cores', container.id);
  const limitCores = cpuLimitCores(container.cpuMillis, kernel?.value ?? null);
  return {
    usageCores: usage?.value ?? null,
    limitCores,
    ratio: usage && limitCores !== null && limitCores > 0 ? usage.value / limitCores : null,
  };
}

function memoryFor(
  container: InventoryContainer,
  samples: Map<string, Map<string, Reading[]>>,
): PerformanceQuantity {
  const used = one(samples, 'mem_used_bytes', container.id);
  const limit = one(samples, 'mem_limit_bytes', container.id);
  const limitBytes = limit?.value ?? null;
  return quantity(used?.value ?? null, limitBytes === 0 ? null : limitBytes);
}

function gpuFor(
  container: InventoryContainer,
  samples: Map<string, Map<string, Reading[]>>,
  unattributed: Map<string, Array<{ gpuPci: string; usedBytes: number }>>,
): PerformanceQuantity {
  const limit = one(samples, 'gpu_limit_bytes', container.id);
  const usedReadings = readings(samples, 'gpu_process_bytes', container.id);
  if (!limit && usedReadings.length === 0) {
    return { usedBytes: null, limitBytes: null, ratio: null };
  }
  const usedBytes = usedReadings.reduce((sum, reading) => sum + reading.value, 0);
  const claimed = new Set(container.pciAddresses);
  const foreign = (unattributed.get(container.serverId) ?? []).some((item) => claimed.has(item.gpuPci));
  if (usedReadings.length === 0 && foreign) {
    return { usedBytes: null, limitBytes: limit?.value ?? null, ratio: null };
  }
  return quantity(usedReadings.length === 0 ? 0 : usedBytes, limit?.value ?? null);
}

function diskFor(
  container: InventoryContainer,
  samples: Map<string, Map<string, Reading[]>>,
) {
  const used = one(samples, 'root_used_bytes', container.id);
  const size = one(samples, 'root_size_bytes', container.id);
  const read = one(samples, 'disk_read_bytes_per_sec', container.id);
  const write = one(samples, 'disk_write_bytes_per_sec', container.id);
  let usedBytes = used?.value ?? null;
  let sizeBytes = size?.value ?? null;
  for (const volume of container.volumes) {
    if (volume.shared) continue;
    const volumeUsed = readings(samples, 'volume_used_bytes', container.id)
      .find((reading) => reading.labels?.volume_id === volume.volumeId);
    const volumeSize = readings(samples, 'volume_size_bytes', container.id)
      .find((reading) => reading.labels?.volume_id === volume.volumeId);
    if (volumeUsed && volumeSize && volumeSize.value > 0) {
      usedBytes = (usedBytes ?? 0) + volumeUsed.value;
      sizeBytes = (sizeBytes ?? 0) + volumeSize.value;
    }
  }
  return {
    usedBytes,
    sizeBytes,
    ratio: usedBytes !== null && sizeBytes !== null && sizeBytes > 0 ? usedBytes / sizeBytes : null,
    readBytesPerSec: read?.value ?? null,
    writeBytesPerSec: write?.value ?? null,
  };
}

function networkFor(containerId: string, samples: Map<string, Map<string, Reading[]>>) {
  return {
    rxBytesPerSec: sumReadings(readings(samples, 'net_rx_bytes_per_sec', containerId)),
    txBytesPerSec: sumReadings(readings(samples, 'net_tx_bytes_per_sec', containerId)),
  };
}

function volumesFor(
  container: InventoryContainer,
  samples: Map<string, Map<string, Reading[]>>,
): PerformanceVolumeUsage[] {
  return container.volumes.filter((volume) => !volume.shared).map((volume) => {
    const used = readings(samples, 'volume_used_bytes', container.id)
      .find((reading) => reading.labels?.volume_id === volume.volumeId);
    const size = readings(samples, 'volume_size_bytes', container.id)
      .find((reading) => reading.labels?.volume_id === volume.volumeId);
    const usedBytes = used?.value ?? null;
    const sizeBytes = size?.value ?? null;
    return {
      volumeId: volume.volumeId,
      name: volume.name,
      usedBytes,
      sizeBytes,
      ratio: usedBytes !== null && sizeBytes !== null && sizeBytes > 0 ? usedBytes / sizeBytes : null,
    };
  });
}

interface LabeledReading extends Reading {
  labels?: Record<string, string>;
}

function indexSamples(samples: readonly ObservedSample[]): Map<string, Map<string, LabeledReading[]>> {
  const indexed = new Map<string, Map<string, LabeledReading[]>>();
  for (const sample of samples) {
    const containerId = sample.labels.container_id;
    if (!containerId || containerId === '__unattributed__') continue;
    const family = indexed.get(sample.family) ?? new Map();
    const list = family.get(containerId) ?? [];
    list.push({ value: sample.value, ts: sample.ts, labels: sample.labels });
    family.set(containerId, list);
    indexed.set(sample.family, family);
  }
  return indexed;
}

function unattributedGpu(samples: readonly ObservedSample[]) {
  const grouped = new Map<string, Map<string, number>>();
  for (const sample of samples) {
    if (sample.family !== 'gpu_process_bytes' || sample.labels.container_id !== '__unattributed__') continue;
    const pci = sample.labels.gpu_pci;
    const serverId = sample.labels.server_id;
    if (!pci || !serverId) continue;
    const server = grouped.get(serverId) ?? new Map();
    server.set(pci, (server.get(pci) ?? 0) + sample.value);
    grouped.set(serverId, server);
  }
  const result = new Map<string, Array<{ gpuPci: string; usedBytes: number }>>();
  for (const [serverId, cards] of grouped) {
    result.set(serverId, [...cards.entries()].map(([gpuPci, usedBytes]) => ({ gpuPci, usedBytes })));
  }
  return result;
}

function one(
  samples: Map<string, Map<string, LabeledReading[]>>,
  family: string,
  containerId: string,
): LabeledReading | null {
  return readings(samples, family, containerId)[0] ?? null;
}

function readings(
  samples: Map<string, Map<string, LabeledReading[]>>,
  family: string,
  containerId: string,
): LabeledReading[] {
  return samples.get(family)?.get(containerId) ?? [];
}

function quantity(usedBytes: number | null, limitBytes: number | null): PerformanceQuantity {
  return {
    usedBytes,
    limitBytes,
    ratio: usedBytes !== null && limitBytes !== null && limitBytes > 0 ? usedBytes / limitBytes : null,
  };
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0);
}

function sumReadings(values: readonly Reading[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, reading) => sum + reading.value, 0);
}

function newestSample(
  serverId: string,
  samples: readonly ObservedSample[],
  scrapeUp: ReadonlyMap<string, Reading>,
): number | null {
  let newest: number | null = scrapeUp.get(serverId)?.ts ?? null;
  for (const sample of samples) {
    if (sample.labels.server_id !== serverId) continue;
    if (newest === null || sample.ts > newest) newest = sample.ts;
  }
  return newest;
}

export function absoluteUsed(
  metric: PerformanceMetric,
  containers: readonly InventoryContainer[],
  series: ReadonlyMap<string, Array<{ ts: number; labels: Record<string, string>; value: number }>>,
  ts: number,
  pci?: string,
): number | null {
  if (metric === 'network') {
    const rx = sumAt(series.get('net_rx_bytes_per_sec') ?? [], containers, ts);
    const tx = sumAt(series.get('net_tx_bytes_per_sec') ?? [], containers, ts);
    if (rx === null && tx === null) return null;
    return (rx ?? 0) + (tx ?? 0);
  }
  if (metric === 'cpu') return sumAt(series.get('cpu_usage_cores') ?? [], containers, ts);
  if (metric === 'memory') return sumAt(series.get('mem_used_bytes') ?? [], containers, ts);
  if (metric === 'disk') {
    const localIds = new Set(containers.flatMap((container) =>
      container.volumes.filter((volume) => !volume.shared).map((volume) => volume.volumeId)));
    const volumeUsed = (series.get('volume_used_bytes') ?? [])
      .filter((point) => localIds.has(point.labels.volume_id ?? ''));
    return sumNullable([
      sumAt(series.get('root_used_bytes') ?? [], containers, ts),
      sumAt(volumeUsed, containers, ts),
    ]);
  }
  const points = (series.get('gpu_process_bytes') ?? [])
    .filter((point) => pci === undefined || point.labels.gpu_pci === pci);
  return sumAt(points, containers, ts);
}

function metricAt(
  metric: PerformanceMetric,
  containers: readonly InventoryContainer[],
  series: ReadonlyMap<string, Array<{ ts: number; labels: Record<string, string>; value: number }>>,
  ts: number,
): number | null {
  if (metric === 'network') {
    const rx = sumAt(series.get('net_rx_bytes_per_sec') ?? [], containers, ts);
    const tx = sumAt(series.get('net_tx_bytes_per_sec') ?? [], containers, ts);
    if (rx === null && tx === null) return null;
    return (rx ?? 0) + (tx ?? 0);
  }
  if (metric === 'cpu') {
    const usage = sumAt(series.get('cpu_usage_cores') ?? [], containers, ts);
    if (containers.some((container) => container.cpuMillis <= 0)) return null;
    const limit = containers.reduce((sum, container) => sum + container.cpuMillis / 1000, 0);
    return usage !== null && limit > 0 ? usage / limit : null;
  }
  if (metric === 'memory') {
    const limits = series.get('mem_limit_bytes') ?? [];
    if (containers.some((container) => {
      const limit = valueAt(limits, container, ts);
      return limit === null || limit <= 0;
    })) return null;
    const used = sumAt(series.get('mem_used_bytes') ?? [], containers, ts);
    const limit = sumAt(limits, containers, ts);
    return used !== null && limit !== null && limit > 0 ? used / limit : null;
  }
  if (metric === 'disk') {
    const localIds = new Set(containers.flatMap((container) =>
      container.volumes.filter((volume) => !volume.shared).map((volume) => volume.volumeId)));
    const volumeUsed = (series.get('volume_used_bytes') ?? [])
      .filter((point) => localIds.has(point.labels.volume_id ?? ''));
    const volumeSize = (series.get('volume_size_bytes') ?? [])
      .filter((point) => localIds.has(point.labels.volume_id ?? ''));
    const used = sumNullable([
      sumAt(series.get('root_used_bytes') ?? [], containers, ts),
      sumAt(volumeUsed, containers, ts),
    ]);
    const size = sumNullable([
      sumAt(series.get('root_size_bytes') ?? [], containers, ts),
      sumAt(volumeSize, containers, ts),
    ]);
    return used !== null && size !== null && size > 0 ? used / size : null;
  }
  const used = sumAt(series.get('gpu_process_bytes') ?? [], containers, ts);
  const limit = sumAt(series.get('gpu_limit_bytes') ?? [], containers, ts);
  if (limit === null || limit <= 0) return null;
  return (used ?? 0) / limit;
}

function sumAt(
  points: readonly { ts: number; labels: Record<string, string>; value: number }[],
  containers: readonly InventoryContainer[],
  ts: number,
): number | null {
  const matched = new Map<string, number>();
  for (const container of containers) {
    const value = valueAt(points, container, ts);
    if (value === null) continue;
    matched.set(container.id, (matched.get(container.id) ?? 0) + value);
  }
  if (matched.size === 0) return null;
  return [...matched.values()].reduce((sum, value) => sum + value, 0);
}

function valueAt(
  points: readonly { ts: number; labels: Record<string, string>; value: number }[],
  container: InventoryContainer,
  ts: number,
): number | null {
  const matched = points.filter((point) =>
    point.ts === ts
    && point.labels.container_id === container.id
    && ownsSample(point.labels.user_id, container.ownerId));
  if (matched.length === 0) return null;
  const bySeries = new Map<string, number>();
  for (const point of matched) {
    const key = [
      point.labels.device ?? '',
      point.labels.volume_id ?? '',
      point.labels.gpu_pci ?? '',
    ].join('\0');
    if (!bySeries.has(key)) bySeries.set(key, point.value);
  }
  return [...bySeries.values()].reduce((sum, value) => sum + value, 0);
}

function ownsSample(userId: string | undefined, ownerId: string): boolean {
  return !userId || userId === '__unknown__' || userId === ownerId;
}

function ownedSamples(
  samples: readonly ObservedSample[],
  containers: readonly InventoryContainer[],
): ObservedSample[] {
  const owners = new Map(containers.map((container) => [container.id, container.ownerId]));
  const grouped = new Map<string, ObservedSample>();
  const rest: ObservedSample[] = [];
  for (const sample of samples) {
    const containerId = sample.labels.container_id;
    if (!containerId || containerId === '__unattributed__') {
      rest.push(sample);
      continue;
    }
    if (!ownsSample(sample.labels.user_id, owners.get(containerId) ?? '')) continue;
    const key = [
      sample.family,
      containerId,
      sample.labels.device ?? '',
      sample.labels.volume_id ?? '',
      sample.labels.gpu_pci ?? '',
    ].join('\0');
    const current = grouped.get(key);
    if (!current || sample.ts >= current.ts) grouped.set(key, sample);
  }
  return [...grouped.values(), ...rest];
}

function lastValue(timeline: readonly number[], read: (ts: number) => number | null): number | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const ts = timeline[index];
    if (ts === undefined) continue;
    const value = read(ts);
    if (value !== null) return value;
  }
  return null;
}

export function seriesPoints(lines: PerformanceSeriesLine[]): PerformanceSeriesPoint[] {
  return lines[0]?.points ?? [];
}
