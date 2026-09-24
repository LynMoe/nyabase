export type PerformanceMetric = 'cpu' | 'memory' | 'disk' | 'gpu' | 'network';
export type PerformanceRange = '15m' | '1h' | '6h' | '24h';

export interface PerformanceQuantity {
  usedBytes: number | null;
  limitBytes: number | null;
  ratio: number | null;
}

export interface PerformanceCpu {
  /** Observed cores from the cgroup counter. */
  usageCores: number | null;
  /** cpu_millis / 1000 when cpu_millis > 0. Not the kernel cpu.max quota. */
  limitCores: number | null;
  ratio: number | null;
}

export interface PerformancePersonRow {
  userId: string;
  displayName: string;
  username: string;
  containerCount: number;
  missingSamples: number;
  cpu: PerformanceCpu;
  memory: PerformanceQuantity;
  gpu: PerformanceQuantity & { cardCount: number };
  disk: { usedBytes: number | null; sizeBytes: number | null; ratio: number | null };
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null };
}

export interface PerformanceHostSnapshot {
  cpuRatio: number | null;
  cpuCount: number | null;
  memory: PerformanceQuantity;
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null };
  disks: Array<{
    id: string;
    name: string;
    usedBytes: number | null;
    sizeBytes: number | null;
    ratio: number | null;
  }>;
  gpus: Array<{
    pci: string;
    index: number | null;
    usedBytes: number | null;
    totalBytes: number | null;
    ratio: number | null;
  }>;
}

export interface PerformanceSparkline {
  t: string[];
  cpu: Array<number | null>;
  memory: Array<number | null>;
  network: Array<{ rx: number | null; tx: number | null }>;
  disks: Array<{ id: string; v: Array<number | null> }>;
  gpus: Array<{ pci: string; v: Array<number | null> }>;
}

export interface PerformanceServerUsage {
  serverId: string;
  serverName: string;
  stale: boolean;
  sampledAt: string | null;
  people: PerformancePersonRow[];
  host: PerformanceHostSnapshot;
  sparkline: PerformanceSparkline | null;
}

export interface PerformanceOwnContainer {
  containerId: string;
  name: string;
  cpu: PerformanceCpu;
  memory: PerformanceQuantity;
  gpu: PerformanceQuantity & { pciAddresses: string[] };
  disk: {
    usedBytes: number | null;
    sizeBytes: number | null;
    ratio: number | null;
    readBytesPerSec: number | null;
    writeBytesPerSec: number | null;
  };
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null };
  volumes: PerformanceVolumeUsage[];
}

export interface PerformanceSelfResponse {
  sampledAt: string | null;
  stale: boolean;
  serverId: string;
  container: PerformanceOwnContainer;
}

export interface PerformanceUsageResponse {
  sampledAt: string | null;
  servers: PerformanceServerUsage[];
  ownContainers?: PerformanceOwnContainer[];
}

export type PerformanceChartUnit = 'cores' | 'bytes' | 'bytes_per_sec';

export interface PerformanceChartSeries {
  unit: PerformanceChartUnit;
  yMax: number | null;
  lines: PerformanceSeriesLine[];
  otherCount: number;
}

export interface PerformanceGpuChartSeries extends PerformanceChartSeries {
  pci: string;
  index: number | null;
}

export interface PerformanceMultiSeriesResponse {
  range: PerformanceRange;
  serverId: string;
  containerId?: string;
  t: string[];
  charts: {
    cpu: PerformanceChartSeries;
    memory: PerformanceChartSeries;
    disk: PerformanceChartSeries;
    network: PerformanceChartSeries;
  };
  gpus: PerformanceGpuChartSeries[];
}

export interface PerformanceVolumeUsage {
  volumeId: string;
  name: string;
  usedBytes: number | null;
  sizeBytes: number | null;
  ratio: number | null;
}

export interface PerformanceContainerRow {
  containerId: string;
  name: string;
  userId: string;
  displayName: string;
  username: string;
  lifecyclePhase: string;
  powerIntent: string;
  cpu: PerformanceCpu;
  memory: PerformanceQuantity;
  gpu: PerformanceQuantity & { pciAddresses: string[] };
  disk: {
    usedBytes: number | null;
    sizeBytes: number | null;
    ratio: number | null;
    readBytesPerSec: number | null;
    writeBytesPerSec: number | null;
  };
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null };
  volumes: PerformanceVolumeUsage[];
}

export interface PerformanceAdminServerUsage extends PerformanceServerUsage {
  containers: PerformanceContainerRow[];
  unattributedGpu: Array<{ gpuPci: string; usedBytes: number }>;
}

export interface PerformanceAdminUsageResponse {
  sampledAt: string | null;
  truncated: boolean;
  servers: PerformanceAdminServerUsage[];
}

export interface PerformanceSeriesPoint {
  t: string;
  v: number | null;
}

export interface PerformanceSeriesLine {
  key: string;
  label: string;
  points: PerformanceSeriesPoint[];
}

export interface PerformanceSeriesResponse {
  metric: PerformanceMetric;
  range: PerformanceRange;
  lines: PerformanceSeriesLine[];
}
