import { ContainerStatus, type ContainerDto, type PerformanceOwnContainer } from '@nyabase/common';
import { formatBytesCompact } from './utils.js';

/** The live sample fields shared by the user (`ownContainers`) and admin (`servers[].containers`) usage rows. */
export type ContainerLiveUsage = Pick<PerformanceOwnContainer, 'cpu' | 'memory' | 'gpu' | 'disk' | 'network'>;

/**
 * One "used / allocated" readout. `used` is null when there is no live sample
 * (stopped container, no metrics yet, or no permission); `ratio` is null when
 * there is nothing to draw a bar against.
 */
export type MeterReading = {
  used: string | null;
  total: string | null;
  ratio: number | null;
  /** Text before the readout, e.g. the GPU card count. */
  lead?: string;
  title?: string;
};

/** Cores as people read them: one decimal below 10, whole numbers above. */
export function formatCores(cores: number): string {
  return Math.abs(cores) >= 10 ? cores.toFixed(0) : cores.toFixed(1);
}

/** Cores a container may use as last applied; null until the first reconcile. */
export function allocatedCores(container: Pick<ContainerDto, 'cpuSet'>): number | null {
  return container.cpuSet && container.cpuSet.length > 0 ? container.cpuSet.length : null;
}

/** Drops the used side's unit when both sides share it: "1.2 GiB", "4 GiB" → "1.2", "4 GiB". */
export function sharedUnitPair(used: string, total: string): { used: string; total: string } {
  const usedSpace = used.lastIndexOf(' ');
  const totalSpace = total.lastIndexOf(' ');
  if (usedSpace < 0 || totalSpace < 0) return { used, total };
  if (used.slice(usedSpace + 1) !== total.slice(totalSpace + 1)) return { used, total };
  return { used: used.slice(0, usedSpace), total };
}

/** "1.2 / 4 GiB" when both sides share a unit, otherwise "512 MiB / 4 GiB". */
export function formatBytesPair(used: number, total: number): { used: string; total: string } {
  return sharedUnitPair(formatBytesCompact(used), formatBytesCompact(total));
}

function ratioOf(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.max(0, used / total);
}

/** Only a running container has a meaningful live sample; a stopped one may still carry its last values. */
export function liveSample(
  container: Pick<ContainerDto, 'actual'>,
  usage: ContainerLiveUsage | undefined,
): ContainerLiveUsage | undefined {
  return container.actual.status === ContainerStatus.Running ? usage : undefined;
}

export function cpuReading(container: Pick<ContainerDto, 'cpuSet'>, usage: ContainerLiveUsage | undefined): MeterReading {
  const cores = allocatedCores(container);
  const used = usage?.cpu.usageCores ?? null;
  return {
    used: used === null ? null : formatCores(used),
    total: cores === null ? '待分配' : `${cores} 核`,
    ratio: ratioOf(used, cores),
  };
}

export function memoryReading(container: Pick<ContainerDto, 'memBytes'>, usage: ContainerLiveUsage | undefined): MeterReading {
  const used = usage?.memory.usedBytes ?? null;
  if (used === null) return { used: null, total: formatBytesCompact(container.memBytes), ratio: null };
  const pair = formatBytesPair(used, container.memBytes);
  return { used: pair.used, total: pair.total, ratio: ratioOf(used, container.memBytes) };
}

/** System disk: the live sample first, then the last size the reconciler observed. */
export function rootDiskReading(
  container: Pick<ContainerDto, 'rootSizeBytes' | 'rootUsedBytes'>,
  usage: ContainerLiveUsage | undefined,
): MeterReading {
  const used = usage?.disk.usedBytes ?? container.rootUsedBytes;
  if (used === null) return { used: null, total: formatBytesCompact(container.rootSizeBytes), ratio: null };
  const pair = formatBytesPair(used, container.rootSizeBytes);
  return { used: pair.used, total: pair.total, ratio: ratioOf(used, container.rootSizeBytes) };
}

/** Number of cards the container holds; 0 when it has none. */
export function gpuCardCount(container: Pick<ContainerDto, 'gpu'>): number {
  return container.gpu?.pciAddresses.length ?? 0;
}

/**
 * GPU memory across the container's cards. Null when the container has no
 * cards, so callers can render a plain "—".
 */
export function gpuReading(container: Pick<ContainerDto, 'gpu'>, usage: ContainerLiveUsage | undefined): MeterReading | null {
  const cards = gpuCardCount(container);
  if (cards === 0) return null;
  const lead = `${cards} 卡`;
  const used = usage?.gpu.usedBytes ?? null;
  const limit = usage?.gpu.limitBytes ?? null;
  if (used === null) return { used: null, total: null, ratio: null, lead };
  const ratio = usage?.gpu.ratio ?? ratioOf(used, limit);
  if (limit === null) return { used: formatBytesCompact(used), total: null, ratio, lead, title: `显存已用 ${formatBytesCompact(used)}` };
  const pair = formatBytesPair(used, limit);
  return { used: pair.used, total: pair.total, ratio, lead, title: `显存 ${pair.used} / ${pair.total}` };
}
