import type {
  HostDiskCapacity,
  HostDiskIo,
  HostNetIo,
  MetricSeries,
} from '@nyabase/common';

export interface HostMetricChartEntry {
  key: string;
  label: string;
  series: MetricSeries;
}

/**
 * Keep ordinary metrics rendering on purpose-safe fields. Physical host paths,
 * block devices, and interface names are optional admin-only metadata.
 */
export function hostDiskCapacityTitle(disk: Pick<HostDiskCapacity, 'displayName'>): string {
  return `磁盘容量 — ${disk.displayName}`;
}

export function hostDiskIoChartEntries(disks: HostDiskIo[]): HostMetricChartEntry[] {
  return disks.map((disk) => ({ key: disk.label, label: disk.label, series: disk.bps }));
}

export function hostNetIoChartEntries(interfaces: HostNetIo[]): HostMetricChartEntry[] {
  return interfaces.map((networkInterface) => ({
    key: networkInterface.label,
    label: networkInterface.label,
    series: networkInterface.bps,
  }));
}
