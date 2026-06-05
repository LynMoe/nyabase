import {
  ContainerStatus,
  type ContainerSnapshot,
  type DiskInfo,
  type RemoteFsMountStatus,
  type StateReportPayload,
} from '@nyabase/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentGateway } from '../agent-gateway.js';
import type { ServerEntity } from '../../entities/server.entity.js';

type TestGateway = Pick<AgentGateway, 'stateCache'> & {
  onHello(server: ServerEntity, payload: unknown): Promise<void>;
  onStateReport(server: ServerEntity, payload: StateReportPayload): Promise<void>;
  onContainerEvent(server: ServerEntity, payload: { serverId: string; runtimeId: string; action: string }): Promise<void>;
  handleMessage(session: unknown, server: ServerEntity, raw: string): Promise<void>;
  onOperationProgress(payload: unknown): Promise<void>;
};

function makeContainer(runtimeId: string): ContainerSnapshot {
  return {
    spec: {
      runtimeId,
      name: `${runtimeId}-name`,
      ownerId: 'owner-a',
      imageId: 'image-a',
      cpuMillis: 1000,
      memBytes: 1024,
      gpuIndices: [],
      ip: '10.0.0.2',
      serverId: 'server-a',
      sshServerEnabled: false,
      dataDirs: [],
      createdAt: '2026-06-03T00:00:00.000Z',
      specVersion: '1',
    },
    status: ContainerStatus.Running,
    stats: null,
    sshServer: { enabled: false, status: 'disabled', user: 'root', port: 22 },
    labels: { 'nyabase.container_id': 'container-a' },
  };
}

function makeReport(overrides: Partial<StateReportPayload> = {}): StateReportPayload {
  const disk: DiskInfo = {
    diskId: 'disk-a',
    mountPoint: '/data-a',
    label: 'data-a',
    totalBytes: 1024,
    usedBytes: 128,
    pquotaEnabled: true,
  };
  const remoteFsMount: RemoteFsMountStatus = {
    id: 'remote-a',
    hostMountPoint: '/mnt/remote-a',
    status: 'mounted',
    lastCheckedAt: 1_780_000_000_000,
    totalBytes: 2048,
    usedBytes: 256,
  };

  return {
    serverId: 'server-a',
    containers: [makeContainer('docker-a')],
    xfsProjects: [
      { numericUserId: 1001, projectId: 11, usedBytes: 512, hardLimitBytes: 1024 },
      { numericUserId: 9999, projectId: 12, usedBytes: 64, hardLimitBytes: 128 },
    ],
    disks: [disk],
    remoteFsMounts: [remoteFsMount],
    incremental: false,
    ...overrides,
  };
}

function makeGateway() {
  const serversRepo = { update: vi.fn() };
  const metricsWriter = { writeBatch: vi.fn() };
  const execSessionRegistry = { setOrphanHandler: vi.fn() };
  const usersService = {
    getUserIdsByNumericIds: vi.fn().mockResolvedValue(new Map([[1001, 'user-a']])),
  };
  const operationOrchestrator = {
    recordProgress: vi.fn().mockResolvedValue(undefined),
  };
  const dataDirReconciler = {
    reconcile: vi.fn().mockResolvedValue(undefined),
  };

  const gateway = new AgentGateway(
    serversRepo as never,
    metricsWriter as never,
    execSessionRegistry as never,
    usersService as never,
    operationOrchestrator as never,
    dataDirReconciler as never,
  );

  return {
    gateway: gateway as unknown as TestGateway,
    usersService,
    operationOrchestrator,
    dataDirReconciler,
  };
}

describe('AgentGateway state cache runtime readiness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hello initializes a snapshot but does not mark runtime ready', async () => {
    const { gateway } = makeGateway();
    const server = { id: 'server-a', name: 'server-a', dockerRoot: null } as ServerEntity;

    await gateway.onHello(server, {
      serverId: 'server-a',
      hostname: 'host-a',
      kernelVersion: '6.0',
      cpuCores: 8,
      totalMemBytes: 1024,
      disks: [],
      gpus: [],
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanIface: 'eth0',
      dockerRoot: '/var/lib/docker',
      dockerSocket: '/var/run/docker.sock',
      agentVersion: '0.1.0',
      localImages: [],
    });

    const snapshot = gateway.stateCache.get('server-a');
    expect(snapshot?.runtimeReady).toBe(false);
    expect(snapshot?.helloAt).toEqual(expect.any(Number));
    expect(snapshot?.agentVersion).toBe('0.1.0');
  });

  it('first full state report marks ready and stores only stateCache runtime data', async () => {
    const { gateway, usersService } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const report = makeReport({ observedAt: 1_780_000_000_000 });

    await gateway.onStateReport(server, report);

    expect(usersService.getUserIdsByNumericIds).toHaveBeenCalledWith([1001, 9999]);
    const snapshot = gateway.stateCache.get('server-a');
    expect(snapshot?.runtimeReady).toBe(true);
    expect(snapshot?.lastFullReportAt).toBe(1_780_000_000_000);
    expect(snapshot?.lastFullReportReceivedAt).toEqual(expect.any(Number));
    expect(snapshot?.containers.get('docker-a')).toEqual(report.containers[0]);
    expect(snapshot?.xfsProjects).toEqual([
      { userId: 'user-a', projectId: 11, usedBytes: 512, hardLimitBytes: 1024 },
    ]);
    expect(snapshot?.disks).toEqual(report.disks);
    expect(snapshot?.remoteFsMounts).toEqual(report.remoteFsMounts);
  });

  it('ignores incremental state reports before the first full report', async () => {
    const { gateway } = makeGateway();
    await gateway.onStateReport(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      makeReport({ incremental: true, containers: [makeContainer('incremental-a')] }),
    );

    const snapshot = gateway.stateCache.get('server-a');
    expect(snapshot?.runtimeReady).toBe(false);
    expect(snapshot?.containers.size).toBe(0);
    expect(snapshot?.lastIncrementalReportAt).toBeNull();
  });

  it('dataDir, remote-fs, docker daemon messages do not mark runtime ready', async () => {
    const { gateway, dataDirReconciler } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;

    await gateway.handleMessage({ ws: { close: vi.fn() } }, server, JSON.stringify({
      ts: Date.now(),
      kind: 'dataDirReport',
      payload: { serverId: 'server-a', dirs: [{ sourceKind: 'local', sourceId: 'disk-a', name: 'project', hostPath: '/data/project' }] },
    }));
    await gateway.handleMessage({ ws: { close: vi.fn() } }, server, JSON.stringify({
      ts: Date.now(),
      kind: 'remoteFsMountStatus',
      payload: { id: 'remote-a', hostMountPoint: '/mnt/remote-a', status: 'mounted', lastCheckedAt: 1 },
    }));
    await gateway.handleMessage({ ws: { close: vi.fn() } }, server, JSON.stringify({
      ts: Date.now(),
      kind: 'dockerDaemonStatus',
      payload: {
        serverId: 'server-a',
        state: 'active',
        unitFileInSync: true,
        enabled: true,
        active: true,
        pid: 123,
        dockerRoot: '/var/lib/docker',
        socketPath: '/var/run/docker.sock',
        serverVersion: '1',
        storageDriver: 'overlay2',
        lastError: null,
        checkedAt: 1,
      },
    }));

    expect(dataDirReconciler.reconcile).toHaveBeenCalledWith('server-a');
    expect(gateway.stateCache.isRuntimeReady('server-a')).toBe(false);
  });

  it('forwards operation progress to the operation orchestrator', async () => {
    const { gateway, operationOrchestrator } = makeGateway();
    await gateway.onOperationProgress({
      operationId: 'operation-a',
      commandId: 'command-a',
      status: 'running',
      step: 'docker-start',
      ts: Date.now(),
    });
    expect(operationOrchestrator.recordProgress).toHaveBeenCalledWith({
      operationId: 'operation-a',
      commandId: 'command-a',
      status: 'running',
      step: 'docker-start',
      ts: expect.any(Number),
    });
  });
});
