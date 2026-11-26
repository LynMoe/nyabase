import type { PerformanceGpuChartSeries, PerformanceSeriesLine, PerformanceSeriesPoint } from '@nyabase/common';
import {
  OTHER_LINE,
  absoluteChart,
  chartGroups,
  chartPoints,
  idlePoints,
  latestPoint,
  splitRanked,
  type ChartInput,
} from './performance-model.js';

export interface GpuCard {
  pci: string;
  index: number | null;
  totalBytes: number | null;
}

/**
 * Two charts per card: memory bytes per line, and the SM / memory-controller
 * time shares of the same lines. A person is on both charts exactly when they
 * held memory on this card in the window, so a card's charts list only the
 * people (or the container) on it, including those holding it at 0% SM.
 */
export function gpuCardCharts(
  input: Omit<ChartInput, 'metric' | 'pci' | 'gpuFamily'>,
  cards: readonly GpuCard[],
): PerformanceGpuChartSeries[] {
  return cards.map((card) => {
    const base: ChartInput = { ...input, metric: 'gpu', pci: card.pci };
    const memory = absoluteChart({ ...base, hideIdle: true });
    return {
      pci: card.pci,
      index: card.index,
      unit: 'bytes' as const,
      yMax: card.totalBytes,
      otherCount: memory.otherCount,
      lines: memory.lines,
      utilization: utilizationChart(base),
    };
  });
}

function utilizationChart(base: ChartInput): PerformanceGpuChartSeries['utilization'] {
  const smInput: ChartInput = { ...base, gpuFamily: 'gpu_process_sm' };
  const bandwidthInput: ChartInput = { ...base, gpuFamily: 'gpu_process_mem_bw' };
  // Membership follows memory (the memory chart's rule), not SM: memory held at
  // 0% SM is a card taken but idle, which is what this chart should show.
  const holders = base.containerId
    ? chartGroups(base)
    : chartGroups(base).filter((group) => !idlePoints(chartPoints(base, group.containers)));
  const active = holders.map((group) => {
    const sm = chartPoints(smInput, group.containers);
    const memoryBandwidth = chartPoints(bandwidthInput, group.containers);
    return { ...group, sm, memoryBandwidth, rank: (latestPoint(sm) ?? -1) + (latestPoint(memoryBandwidth) ?? -1) / 1000 };
  });
  active.sort((left, right) => right.rank - left.rank || left.label.localeCompare(right.label));
  const { head, restContainers, otherCount } = splitRanked(active);
  const line = (key: string, label: string, points: PerformanceSeriesPoint[]): PerformanceSeriesLine => ({ key, label, points });
  const sm = head.map((group) => line(group.key, group.label, group.sm));
  const memoryBandwidth = head.map((group) => line(group.key, group.label, group.memoryBandwidth));
  if (restContainers.length > 0) {
    sm.push(line(OTHER_LINE.key, OTHER_LINE.label, chartPoints(smInput, restContainers)));
    memoryBandwidth.push(line(OTHER_LINE.key, OTHER_LINE.label, chartPoints(bandwidthInput, restContainers)));
  }
  return { sm, memoryBandwidth, otherCount };
}
