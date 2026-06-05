import { Logger } from '@nestjs/common';
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
    sshServer: {
      enabled: false,
      status: 'disabled',
      user: 'root',
      port: 22,
    },
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
  const observationWriter = {
    persistHello: vi.fn().mockResolvedValue(undefined),
    persistStateReport: vi.fn().mockResolvedValue(undefined),
    persistDataDirReport: vi.fn().mockResolvedValue(undefined),
    persistContainerEvent: vi.fn().mockResolvedValue(undefined),
    persistRemoteFsMountStatus: vi.fn().mockResolvedValue(undefined),
    persistDockerDaemonStatus: vi.fn().mockResolvedValue(undefined),
  };
  const operationOrchestrator = {
    recordProgress: vi.fn().mockResolvedValue(undefined),
  };

  const gateway = new AgentGateway(
    serversRepo as never,
    metricsWriter as never,
    execSessionRegistry as never,
    usersService as never,
    observationWriter as never,
    operationOrchestrator as never,
  );

  return {
    gateway: gateway as unknown as TestGateway,
    usersService,
    observationWriter,
    operationOrchestrator,
  };
}

describe('AgentGateway report and progress ingestion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps StateCache transport-local while full reports persist observations and enqueue durable hook work', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const setImmediateSpy = vi.spyOn(global, 'setImmediate');
    const { gateway, usersService, observationWriter } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const report = makeReport();

    expect('registerOnStateReport' in gateway).toBe(false);
    expect('registerOnConnect' in gateway).toBe(false);
    expect('registerOnContainerStart' in gateway).toBe(false);
    expect('registerOnDataDirReport' in gateway).toBe(false);

    await expect(gateway.onStateReport(server, report)).resolves.toBeUndefined();

    expect(observationWriter.persistStateReport).toHaveBeenCalledWith('server-a', report);
    expect(usersService.getUserIdsByNumericIds).toHaveBeenCalledWith([1001, 9999]);
    expect(setImmediateSpy).not.toHaveBeenCalled();

    const snapshot = gateway.stateCache.get('server-a');
    expect(snapshot).toBeDefined();
    expect(snapshot?.containers.get('docker-a')).toEqual(report.containers[0]);
    expect(snapshot?.xfsProjects).toEqual([
      { userId: 'user-a', projectId: 11, usedBytes: 512, hardLimitBytes: 1024 },
    ]);
    expect(snapshot?.disks).toEqual(report.disks);
    expect(snapshot?.remoteFsMounts).toEqual(report.remoteFsMounts);
  });

  it('enqueues reconnect, container-running, data-dir report, and operation progress work durably', async () => {
    const { gateway, observationWriter, operationOrchestrator } = makeGateway();
    const server = { id: 'server-a', name: 'server-a', dockerRoot: null } as ServerEntity;

    await gateway.onHello(server, {
      serverId: 'server-a',
      hostname: 'host-a',
      kernelVersion: '6.0',
      cpuCores: 8,
      totalMemBytes: 1024,
      disks: [],
      gpus: [],
      xfsProjects: [],
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanIface: 'eth0',
      dockerRoot: '/var/lib/docker',
      dockerSocket: '/var/run/docker.sock',
      agentVersion: '0.1.0',
      localImages: [],
    });
    expect(observationWriter.persistHello).toHaveBeenCalledWith('server-a', expect.any(Object));

    await gateway.onContainerEvent(server, {
      serverId: 'server-a',
      runtimeId: 'docker-a',
      action: 'start',
    });
    expect(observationWriter.persistContainerEvent).toHaveBeenCalledWith('server-a', 'docker-a', 'start');

    await gateway.handleMessage(
      { ws: { close: vi.fn() } },
      server,
      JSON.stringify({
        ts: Date.now(),
        kind: 'dataDirReport',
        payload: { serverId: 'server-a', dirs: [] },
      }),
    );
    expect(observationWriter.persistDataDirReport).toHaveBeenCalledWith('server-a', {
      serverId: 'server-a',
      dirs: [],
    });

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

  it('does not enqueue full-report hooks when observation persistence fails', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { gateway, observationWriter } = makeGateway();
    observationWriter.persistStateReport.mockRejectedValueOnce(new Error('writer failed'));

    await expect(gateway.onStateReport(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      makeReport(),
    )).resolves.toBeUndefined();

    expect(observationWriter.persistStateReport).toHaveBeenCalled();
  });
});
