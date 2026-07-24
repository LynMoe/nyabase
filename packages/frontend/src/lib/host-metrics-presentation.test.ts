import { describe, expect, it } from 'vitest';
import type { HostMetricsDto, MetricSeries } from '@nyabase/common';

import {
  hostDiskCapacityTitle,
  hostDiskIoChartEntries,
  hostNetIoChartEntries,
} from './host-metrics-presentation.js';

const series: MetricSeries = { step: 60, points: [{ t: 1, v: 2 }] };

describe('ordinary host metrics presentation', () => {
  it('renders without admin-only physical identifiers', () => {
    const metrics = {
      cpu: series,
      memUsed: series,
      memTotal: series,
      load1: series,
      disks: [{ diskId: 'disk-1', displayName: 'Research data', used: series, total: series }],
      diskIo: [{ label: 'All disks', bps: series }],
      netIo: [{ label: 'All interfaces', bps: series }],
    } satisfies HostMetricsDto;

    expect(hostDiskCapacityTitle(metrics.disks[0])).toBe('磁盘容量 — Research data');
    expect(hostDiskIoChartEntries(metrics.diskIo)).toEqual([
      { key: 'All disks', label: 'All disks', series },
    ]);
    expect(hostNetIoChartEntries(metrics.netIo)).toEqual([
      { key: 'All interfaces', label: 'All interfaces', series },
    ]);
  });
});
