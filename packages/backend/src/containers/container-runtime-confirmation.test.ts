import { describe, expect, it } from 'vitest';
import {
  ContainerPowerIntent,
  ContainerStatus,
  OperationKind,
  type ContainerSnapshot,
} from '@nyabase/common';
import { ContainerControlService } from './container-control.service.js';

describe('ContainerControlService runtime confirmation', () => {
  it('uses backend full-report receive time instead of agent observedAt clock for confirmation freshness', () => {
    const service = Object.create(ContainerControlService.prototype) as unknown as {
      runtimeConfirmationStatus: (
        lifecycle: unknown,
        snapshot: ContainerSnapshot,
        lastFullReportReceivedAt: number,
      ) => { status: 'pending' | 'confirmed' | 'expired' };
    };
    const startedAt = Date.now();
    const snapshot = makeSnapshot(ContainerStatus.Running);

    const status = service.runtimeConfirmationStatus(
      {
        runtimeConfirmation: {
          operationId: 'op-a',
          kind: OperationKind.ContainerRestart,
          startedAt: new Date(startedAt).toISOString(),
          deadlineAt: new Date(startedAt + 45_000).toISOString(),
          expectedPowerIntent: ContainerPowerIntent.Running,
        },
      },
      snapshot,
      startedAt + 1_000,
    );

    expect(status.status).toBe('confirmed');
  });
});

function makeSnapshot(status: ContainerStatus): ContainerSnapshot {
  return {
    spec: {
      runtimeId: 'runtime-a',
      name: 'container-a',
      ownerId: 'user-a',
      imageId: 'image-a',
      cpuMillis: 1000,
      memBytes: 1024,
      gpuIndices: [],
      ip: '10.0.0.2',
      serverId: 'server-a',
      sshServerEnabled: false,
      dataDirs: [],
      createdAt: new Date().toISOString(),
      specVersion: '1',
    },
    status,
    stats: null,
    sshServer: { enabled: false, status: 'disabled', user: 'root', port: 22 },
    labels: { 'nyabase.container_id': 'container-a' },
  };
}
