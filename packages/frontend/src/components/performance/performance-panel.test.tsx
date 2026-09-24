import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PerformanceAdminUsageResponse } from '@nyabase/common';
import { PerformanceView } from './performance-panel.js';

const usage: PerformanceAdminUsageResponse = {
  sampledAt: '2026-09-22T00:00:00.000Z',
  truncated: false,
  servers: [{
    serverId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    serverName: 'lab',
    stale: false,
    sampledAt: '2026-09-22T00:00:00.000Z',
    people: [{
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      displayName: 'Ada',
      username: 'ada',
      containerCount: 1,
      missingSamples: 0,
      cpu: { usageCores: 0.8, limitCores: 2.5, ratio: 0.32 },
      memory: { usedBytes: 100, limitBytes: 200, ratio: 0.5 },
      gpu: { usedBytes: null, limitBytes: null, ratio: null, cardCount: 0 },
      disk: { usedBytes: 12, sizeBytes: 40, ratio: 0.3 },
      network: { rxBytesPerSec: 12000, txBytesPerSec: 3000 },
    }],
    containers: [{
      containerId: '11111111-1111-4111-8111-111111111111',
      name: 'box',
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      displayName: 'Ada',
      username: 'ada',
      lifecyclePhase: 'active',
      powerIntent: 'running',
      cpu: { usageCores: 0.8, limitCores: 2.5, ratio: 0.32 },
      memory: { usedBytes: 100, limitBytes: 200, ratio: 0.5 },
      gpu: { usedBytes: null, limitBytes: null, ratio: null, pciAddresses: [] },
      disk: { usedBytes: 12, sizeBytes: 40, ratio: 0.3, readBytesPerSec: 1, writeBytesPerSec: 2 },
      network: { rxBytesPerSec: 12000, txBytesPerSec: 3000 },
      volumes: [],
    }],
    unattributedGpu: [],
    host: {
      cpuRatio: null,
      cpuCount: null,
      memory: { usedBytes: null, limitBytes: null, ratio: null },
      network: { rxBytesPerSec: null, txBytesPerSec: null },
      disks: [],
      gpus: [],
    },
    sparkline: null,
  }],
};

const handlers = {
  onServerFilter: () => undefined,
  onUserFilter: () => undefined,
  onMetric: () => undefined,
  onRange: () => undefined,
  onChartBy: () => undefined,
  onSelectContainer: () => undefined,
};

afterEach(() => cleanup());

describe('PerformanceView', () => {
  it('shows people and disk in user mode without a container id column', () => {
    render(
      <PerformanceView
        mode="user"
        usage={usage}
        serverFilter="all"
        userFilter="all"
        metric="cpu"
        range="1h"
        chartBy="person"
        selectedContainerId={null}
        {...handlers}
      />,
    );
    expect(screen.getAllByText('用户').length).toBeGreaterThan(0);
    expect(screen.getAllByText('磁盘').length).toBeGreaterThan(0);
    expect(screen.queryByText('11111111')).toBeNull();
    expect(screen.queryByText('读')).toBeNull();
  });

  it('shows read and write columns in admin mode', () => {
    render(
      <PerformanceView
        mode="admin"
        usage={usage}
        serverFilter="all"
        userFilter="all"
        metric="cpu"
        range="1h"
        chartBy="person"
        selectedContainerId={null}
        {...handlers}
      />,
    );
    expect(screen.getByText('读')).toBeTruthy();
    expect(screen.getByText('写')).toBeTruthy();
    expect(screen.getByText('box')).toBeTruthy();
  });
});
