import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import {
  AgentTaskKind,
  canonicalJson,
  LABEL,
  RemoteFsType,
  MAX_AGENT_WS_FRAME_BYTES,
  MAX_MANAGED_CONTAINERS_PER_AGENT,
  type AgentToBackendMessage,
  type TaskExecutePayload,
} from '@nyabase/common';
import {
  AgentApplication,
  AUTHORITATIVE_INVENTORY_DEADLINE_MS,
  AUTHORITATIVE_INVENTORY_FAIL_STOP_GRACE_MS,
  STATE_REPORT_CONTAINER_CONCURRENCY,
  STATE_REPORT_CONTAINER_WORST_CASE_MS,
  mapWithConcurrency,
  taskExecBarrierRuntimeId,
} from './app.js';
import { AgentTaskHandlerRegistry } from './tasks/task-handler.js';
import { AgentTaskRunner } from './tasks/task-runner.js';

const quiesceDocker = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./docker/startup-mutation-barrier.js', () => ({
  quiesceDockerBeforeAgentStartup: quiesceDocker,
}));

describe('AgentApplication connection readiness', () => {
  it('completes local stateless recovery before validation or opening a Backend socket', async () => {
    vi.useFakeTimers();
    try {
      let releaseRecovery!: () => void;
      const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
      const order: string[] = [];
      const wsStart = vi.fn(() => { order.push('ws-start'); });
      const app = Object.create(AgentApplication.prototype) as AgentApplication;
      Object.defineProperties(app, {
        config: { value: { metricsIntervalMs: 10_000 } },
        gpuActive: { value: false, writable: true },
        wsClient: { value: {
          on: vi.fn(),
          start: wsStart,
          connected: false,
        } },
        ensureRuntimeBootstrap: { value: vi.fn(async () => {
          order.push('stateless-recovery');
          await recoveryGate;
        }) },
        validateLocalDataSources: { value: vi.fn(async () => {
          order.push('validate-local-storage');
        }) },
        startDockerEventListener: { value: vi.fn(async () => {
          order.push('docker-event-listener');
        }) },
      });

      const starting = app.start();
      await Promise.resolve();
      expect(order).toEqual(['stateless-recovery']);
      expect(wsStart).not.toHaveBeenCalled();

      releaseRecovery();
      await starting;
      expect(order).toEqual([
        'stateless-recovery',
        'validate-local-storage',
        'docker-event-listener',
        'ws-start',
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not start any observer or socket when local stateless recovery fails', async () => {
    const recoveryError = new Error('managed runtime could not be proved stopped');
    const validateLocalDataSources = vi.fn();
    const startDockerEventListener = vi.fn();
    const wsStart = vi.fn();
    const app = Object.create(AgentApplication.prototype) as AgentApplication;
    Object.defineProperties(app, {
      ensureRuntimeBootstrap: { value: vi.fn().mockRejectedValue(recoveryError) },
      validateLocalDataSources: { value: validateLocalDataSources },
      startDockerEventListener: { value: startDockerEventListener },
      wsClient: { value: { start: wsStart } },
    });

    await expect(app.start()).rejects.toBe(recoveryError);
    expect(validateLocalDataSources).not.toHaveBeenCalled();
    expect(startDockerEventListener).not.toHaveBeenCalled();
    expect(wsStart).not.toHaveBeenCalled();
  });

  it('fences every exact-runtime task that can mutate or rollback its container', () => {
    expect(taskExecBarrierRuntimeId(
      AgentTaskKind.ContainerStop,
      { runtimeId: 'runtime-a' },
    )).toBe('runtime-a');
    expect(taskExecBarrierRuntimeId(
      AgentTaskKind.ContainerSshEnsure,
      { runtimeId: 'runtime-a' },
    )).toBe('runtime-a');
    expect(taskExecBarrierRuntimeId(
      AgentTaskKind.ContainerCreate,
      { runtimeId: 'runtime-a' },
    )).toBeNull();
  });

  it('keeps the maximum legal container inventory inside the report deadline budget', () => {
    const batches = Math.ceil(
      MAX_MANAGED_CONTAINERS_PER_AGENT / STATE_REPORT_CONTAINER_CONCURRENCY,
    );
    // Docker list + all per-container reads + parallel trailing inventory
    // leave explicit time for local scans and serialization.
    const boundedReadBudget = 10_000
      + (batches * STATE_REPORT_CONTAINER_WORST_CASE_MS)
      + 10_000;
    expect(boundedReadBudget).toBeLessThan(AUTHORITATIVE_INVENTORY_DEADLINE_MS);
  });

  it('sends only read-only hello before Backend-granted network/bootstrap convergence', async () => {
    const networkError = new Error('macvlan identity mismatch');
    const ensureMacvlanNetwork = vi.fn().mockRejectedValue(networkError);
    const quiesceManagedContainersForStatelessRecovery = vi.fn().mockResolvedValue(undefined);
    const sendHello = vi.fn();
    const app = Object.create(AgentApplication.prototype) as AgentApplication;
    Object.defineProperties(app, {
      config: { value: { serverId: 'server-a' } },
      daemonManager: { value: { reconcile: vi.fn().mockResolvedValue(undefined) } },
      docker: { value: {
        ensureMacvlanNetwork,
        quiesceManagedContainersForStatelessRecovery,
      } },
      storageIdentity: { value: { assertCurrent: vi.fn() } },
      direct: { value: { waitForIdle: vi.fn().mockResolvedValue(undefined) } },
      taskRunner: { value: { waitForIdle: vi.fn().mockResolvedValue(undefined) } },
      wsClient: { value: { connectionGeneration: 7 } },
      sendHello: { value: sendHello },
    });

    const connection = app as unknown as {
      onConnect(generation: number): Promise<void>;
      ensurePhysicalBootstrap(): Promise<void>;
    };
    await expect(connection.onConnect(7)).resolves.toBeUndefined();
    expect(sendHello).toHaveBeenCalledWith(7);
    expect(ensureMacvlanNetwork).not.toHaveBeenCalled();

    await expect(connection.ensurePhysicalBootstrap()).rejects.toBe(networkError);
    expect(quiesceManagedContainersForStatelessRecovery).toHaveBeenCalledOnce();
    expect(ensureMacvlanNetwork).toHaveBeenCalledOnce();
  });

  it('waits for an old connection mutation before reconnect network convergence and hello', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waitForIdle = vi.fn(() => gate);
    const ensureMacvlanNetwork = vi.fn().mockResolvedValue(undefined);
    const quiesceManagedContainersForStatelessRecovery = vi.fn().mockResolvedValue(undefined);
    const sendHello = vi.fn().mockResolvedValue(undefined);
    const assertCurrent = vi.fn();
    const app = Object.create(AgentApplication.prototype) as AgentApplication;
    Object.defineProperties(app, {
      config: { value: { serverId: 'server-a' } },
      daemonManager: { value: { reconcile: vi.fn().mockResolvedValue(undefined) } },
      docker: { value: {
        ensureMacvlanNetwork,
        quiesceManagedContainersForStatelessRecovery,
      } },
      storageIdentity: { value: { assertCurrent } },
      taskRunner: { value: { waitForIdle } },
      sendHello: { value: sendHello },
    });

    const reconnect = (app as unknown as { ensurePhysicalBootstrap(): Promise<void> }).ensurePhysicalBootstrap();
    await Promise.resolve();
    expect(ensureMacvlanNetwork).not.toHaveBeenCalled();

    release();
    await reconnect;
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(quiesceManagedContainersForStatelessRecovery).toHaveBeenCalledOnce();
    expect(ensureMacvlanNetwork).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledTimes(7);
    expect(sendHello).not.toHaveBeenCalled();
  });

  it('does not start hello/bootstrap deadlines until old-generation work is idle', async () => {
    let release!: () => void;
    const idle = new Promise<void>((resolve) => { release = resolve; });
    const sendHello = vi.fn().mockResolvedValue(undefined);
    const app = Object.create(AgentApplication.prototype) as AgentApplication;
    Object.defineProperties(app, {
      storageIdentity: { value: { assertCurrent: vi.fn() } },
      direct: { value: { waitForIdle: vi.fn().mockResolvedValue(undefined) } },
      taskRunner: { value: { waitForIdle: vi.fn(() => idle) } },
      wsClient: { value: { connectionGeneration: 12 } },
      sendHello: { value: sendHello },
      helloGeneration: { value: 0, writable: true },
    });

    const connect = (app as unknown as { onConnect(generation: number): Promise<void> })
      .onConnect(12);
    await Promise.resolve();
    expect(sendHello).not.toHaveBeenCalled();

    release();
    await connect;
    expect(sendHello).toHaveBeenCalledWith(12);
    expect((app as unknown as { helloGeneration: number }).helloGeneration).toBe(12);
  });

  it('does not advertise hello while an old interactive close is still converging', async () => {
    let release!: () => void;
    const closeIdle = new Promise<void>((resolve) => { release = resolve; });
    const sendHello = vi.fn().mockResolvedValue(undefined);
    const app = Object.create(AgentApplication.prototype) as AgentApplication;
    Object.defineProperties(app, {
      storageIdentity: { value: { assertCurrent: vi.fn() } },
      direct: { value: { waitForIdle: vi.fn(() => closeIdle) } },
      taskRunner: { value: { waitForIdle: vi.fn().mockResolvedValue(undefined) } },
      wsClient: { value: { connectionGeneration: 13 } },
      sendHello: { value: sendHello },
      helloGeneration: { value: 0, writable: true },
    });

    const connect = (app as unknown as { onConnect(generation: number): Promise<void> })
      .onConnect(13);
    await Promise.resolve();
    expect(sendHello).not.toHaveBeenCalled();

    release();
    await connect;
    expect(sendHello).toHaveBeenCalledWith(13);
  });

  it('retries a completed Docker bootstrap failure without overlapping attempts', async () => {
    quiesceDocker.mockClear();
    quiesceDocker.mockResolvedValue(undefined);
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('transient systemd failure'))
      .mockResolvedValueOnce(undefined);
    const quiesceManagedContainersForStatelessRecovery = vi.fn().mockResolvedValue(undefined);
    const app = Object.create(AgentApplication.prototype) as AgentApplication;
    Object.defineProperties(app, {
      config: { value: { serverId: 'server-a' } },
      daemonManager: { value: { reconcile } },
      docker: { value: { quiesceManagedContainersForStatelessRecovery } },
      storageIdentity: { value: { assertCurrent: vi.fn() } },
    });
    const bootstrap = app as unknown as { ensureRuntimeBootstrap(): Promise<void> };

    await expect(bootstrap.ensureRuntimeBootstrap()).rejects.toThrow('transient systemd failure');
    await expect(bootstrap.ensureRuntimeBootstrap()).resolves.toBeUndefined();

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(quiesceDocker).toHaveBeenCalledTimes(2);
    expect(quiesceManagedContainersForStatelessRecovery).toHaveBeenCalledOnce();
  });

  it('does not resolve runtime bootstrap before stateless container quiescence', async () => {
    quiesceDocker.mockClear();
    const order: string[] = [];
    quiesceDocker.mockImplementation(async () => { order.push('old-mutation-domain'); });
    const reconcile = vi.fn(async () => { order.push('daemon-reconcile'); });
    let releaseManaged!: () => void;
    const managedGate = new Promise<void>((resolve) => { releaseManaged = resolve; });
    const quiesceManagedContainersForStatelessRecovery = vi.fn(async () => {
      order.push('managed-container-quiesce');
      await managedGate;
    });
    const app = Object.create(AgentApplication.prototype) as AgentApplication;
    Object.defineProperties(app, {
      config: { value: { serverId: 'server-a' } },
      daemonManager: { value: { reconcile } },
      docker: { value: { quiesceManagedContainersForStatelessRecovery } },
      storageIdentity: { value: { assertCurrent: vi.fn() } },
    });
    const bootstrapper = app as unknown as { ensureRuntimeBootstrap(): Promise<void> };
    const bootstrap = bootstrapper.ensureRuntimeBootstrap();
    let settled = false;
    void bootstrap.then(() => { settled = true; });

    await vi.waitFor(() => expect(quiesceManagedContainersForStatelessRecovery).toHaveBeenCalledOnce());
    expect(order).toEqual([
      'old-mutation-domain',
      'daemon-reconcile',
      'managed-container-quiesce',
    ]);
    expect(settled).toBe(false);

    releaseManaged();
    await bootstrap;
    expect(settled).toBe(true);
    await expect(bootstrapper.ensureRuntimeBootstrap()).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(quiesceManagedContainersForStatelessRecovery).toHaveBeenCalledOnce();
    expect(quiesceDocker).toHaveBeenCalledOnce();
    quiesceDocker.mockResolvedValue(undefined);
  });

  it('sends a delayed full state report before a later task mutates and reports success', async () => {
    let releaseCollection!: () => void;
    const collectionGate = new Promise<void>((resolve) => { releaseCollection = resolve; });
    const order: string[] = [];
    const ensure = vi.fn(async () => {
      order.push('task:physical');
      return { started: true };
    });
    const taskRunner = new AgentTaskRunner(
      new AgentTaskHandlerRegistry([{
        kinds: [AgentTaskKind.RemoteFsEnsure],
        ensure,
        verify: vi.fn(async () => undefined),
      }]),
      () => { order.push('task:result'); },
    );
    const send = vi.fn((message: AgentToBackendMessage) => {
      if (message.kind === 'stateReport') order.push('report:send');
      return true;
    });
    const listNyabaseContainers = vi.fn(async () => {
      order.push('report:collect');
      await collectionGate;
      return [];
    });
    const app = Object.create(AgentApplication.prototype) as AgentApplication;
    Object.defineProperties(app, {
      config: { value: { serverId: 'server-a' } },
      docker: {
        value: {
          listNyabaseContainers,
          listImages: vi.fn(async () => []),
        },
      },
      quota: { value: { getAllUsages: vi.fn(async () => []) } },
      dataDirs: { value: {
        getLocalDiskInfos: vi.fn(() => []),
        listAllDirs: vi.fn(async () => [{
          sourceKind: 'local',
          sourceId: 'disk-a',
          resourceId: '00000000-0000-0000-0000-000000000001',
          hostPath: '/data/.nyabase/dirs/00000000-0000-0000-0000-000000000001/data',
        }]),
      } },
      remoteFsMounter: { value: { getAllStatuses: vi.fn(() => []) } },
      storageIdentity: { value: { assertCurrent: vi.fn() } },
      wsClient: { value: { connected: true, connectionGeneration: 3, send } },
      taskRunner: { value: taskRunner },
      reportingGeneration: { value: 3, writable: true },
      stateReportSequence: { value: 0, writable: true },
    });
    const reports = app as unknown as { sendStateReport(): Promise<void> };
    const payload = {
      id: 'remote-a',
      hostMountPoint: '/mnt/remote-fs/remote-a',
      options: 'rw',
      params: {
        type: RemoteFsType.Nfs,
        nfsServer: '10.0.0.1',
        exportPath: '/project',
        version: '4.2',
      },
    };
    const task: TaskExecutePayload = {
      taskId: 'task-a',
      kind: AgentTaskKind.RemoteFsEnsure,
      payloadHash: createHash('sha256')
        .update(canonicalJson({ kind: AgentTaskKind.RemoteFsEnsure, payload }))
        .digest('hex'),
      payload,
    };

    const report = reports.sendStateReport();
    const execution = taskRunner.execute(task);
    await vi.waitFor(() => expect(order).toEqual(['report:collect']));
    expect(ensure).not.toHaveBeenCalled();

    releaseCollection();
    await Promise.all([report, execution]);

    expect(order).toEqual([
      'report:collect',
      'report:send',
      'task:physical',
      'task:result',
    ]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'stateReport',
      payload: expect.objectContaining({
        dataDirs: [expect.objectContaining({ sourceId: 'disk-a' })],
      }),
    }), 3);
  });

  it('refuses a full report instead of hiding a managed runtime with incomplete identity labels', async () => {
    const send = vi.fn((_message: AgentToBackendMessage, _generation?: number) => true);
    const retireGeneration = vi.fn(() => true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = Object.create(AgentApplication.prototype) as AgentApplication;
      Object.defineProperties(app, {
        config: { value: { serverId: 'server-a' } },
        docker: {
          value: {
            listNyabaseContainers: vi.fn(async () => [{
              Id: 'runtime-malformed',
              Labels: { 'nyabase.managed': 'true' },
            }]),
            inspectContainer: vi.fn(async () => ({
              Id: 'runtime-malformed',
              Config: { Labels: { 'nyabase.managed': 'true' } },
            })),
            parseContainerRuntimeObservation: vi.fn(() => null),
          },
        },
        storageIdentity: { value: { assertCurrent: vi.fn() } },
        wsClient: { value: { connected: true, connectionGeneration: 5, send, retireGeneration } },
        taskRunner: {
          value: {
            enqueueObservation: vi.fn((_kind: string, work: () => Promise<void>) => work()),
          },
        },
        reportingGeneration: { value: 5, writable: true },
        stateReportSequence: { value: 0, writable: true },
      });
      const reports = app as unknown as { sendStateReport(): Promise<void> };

      await reports.sendStateReport();

      expect(send.mock.calls.some((call) =>
        (call as unknown as Array<{ kind?: string }>)[0]?.kind === 'stateReport')).toBe(false);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'inventoryFault',
        payload: expect.objectContaining({
          serverId: 'server-a',
          code: 'AUTHORITATIVE_INVENTORY_FAILED',
          message: expect.stringContaining('runtime-malformed'),
        }),
      }), 5);
      expect(warning).toHaveBeenCalledWith(
        '[Agent] Failed to send stateReport:',
        expect.objectContaining({
          message: expect.stringContaining('runtime-malformed'),
        }),
      );
      expect(retireGeneration).toHaveBeenCalledWith(5, 4502, 'Authoritative inventory failed');
    } finally {
      warning.mockRestore();
    }
  });

  it('reports an inventory fault and retires the generation when Docker image inventory fails', async () => {
    const imageError = new Error('image inventory unavailable');
    const send = vi.fn((_message: AgentToBackendMessage, _generation?: number) => true);
    const retireGeneration = vi.fn(() => true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = Object.create(AgentApplication.prototype) as AgentApplication;
      Object.defineProperties(app, {
        config: { value: { serverId: 'server-a' } },
        docker: { value: {
          listNyabaseContainers: vi.fn(async () => []),
          listImages: vi.fn().mockRejectedValue(imageError),
        } },
        quota: { value: { getAllUsages: vi.fn(async () => []) } },
        dataDirs: { value: {
          getLocalDiskInfos: vi.fn(() => []),
          listAllDirs: vi.fn(async () => []),
        } },
        remoteFsMounter: { value: { getAllStatuses: vi.fn(() => []) } },
        storageIdentity: { value: { assertCurrent: vi.fn() } },
        wsClient: { value: {
          connected: true,
          connectionGeneration: 12,
          send,
          retireGeneration,
        } },
        taskRunner: {
          value: { enqueueObservation: vi.fn((_kind: string, work: () => Promise<void>) => work()) },
        },
        reportingGeneration: { value: 12, writable: true },
        stateReportSequence: { value: 0, writable: true },
      });

      await (app as unknown as { sendStateReport(): Promise<void> }).sendStateReport();

      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls.some(([message]) => message.kind === 'stateReport')).toBe(false);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'inventoryFault',
        payload: expect.objectContaining({
          serverId: 'server-a',
          code: 'AUTHORITATIVE_INVENTORY_FAILED',
          message: 'image inventory unavailable',
        }),
      }), 12);
      expect(retireGeneration).toHaveBeenCalledWith(12, 4502, 'Authoritative inventory failed');
    } finally {
      warning.mockRestore();
    }
  });

  it('reconnects without inventory quarantine when a valid full report hits transport backpressure', async () => {
    const send = vi.fn((message: AgentToBackendMessage) => message.kind !== 'stateReport');
    const retireGeneration = vi.fn(() => true);
    const app = Object.create(AgentApplication.prototype) as AgentApplication;
    Object.defineProperties(app, {
      config: { value: { serverId: 'server-a' } },
      docker: { value: {
        listNyabaseContainers: vi.fn(async () => []),
        listImages: vi.fn(async () => []),
      } },
      quota: { value: { getAllUsages: vi.fn(async () => []) } },
      dataDirs: { value: {
        getLocalDiskInfos: vi.fn(() => []),
        listAllDirs: vi.fn(async () => []),
      } },
      remoteFsMounter: { value: { getAllStatuses: vi.fn(() => []) } },
      storageIdentity: { value: { assertCurrent: vi.fn() } },
      wsClient: { value: {
        connected: true,
        connectionGeneration: 15,
        send,
        retireGeneration,
      } },
      taskRunner: {
        value: { enqueueObservation: vi.fn((_kind: string, work: () => Promise<void>) => work()) },
      },
      reportingGeneration: { value: 15, writable: true },
      stateReportSequence: { value: 0, writable: true },
    });

    await (app as unknown as { sendStateReport(): Promise<void> }).sendStateReport();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stateReport' }), 15);
    expect(send.mock.calls.some(([message]) => message.kind === 'inventoryFault')).toBe(false);
    expect(retireGeneration).toHaveBeenCalledWith(
      15,
      1011,
      'Authoritative inventory transport unavailable',
    );
    expect((app as unknown as { reportingGeneration: number }).reportingGeneration).toBe(0);
  });

  it('does not let a stale report transport failure retire a newer connection generation', async () => {
    const retireGeneration = vi.fn(() => true);
    const app = Object.create(AgentApplication.prototype) as AgentApplication;
    const wsClient = {
      connected: true,
      connectionGeneration: 21,
      send: vi.fn(() => {
        wsClient.connectionGeneration = 22;
        (app as unknown as { reportingGeneration: number }).reportingGeneration = 22;
        return false;
      }),
      retireGeneration,
    };
    Object.defineProperties(app, {
      config: { value: { serverId: 'server-a' } },
      docker: { value: {
        listNyabaseContainers: vi.fn(async () => []),
        listImages: vi.fn(async () => []),
      } },
      quota: { value: { getAllUsages: vi.fn(async () => []) } },
      dataDirs: { value: {
        getLocalDiskInfos: vi.fn(() => []),
        listAllDirs: vi.fn(async () => []),
      } },
      remoteFsMounter: { value: { getAllStatuses: vi.fn(() => []) } },
      storageIdentity: { value: { assertCurrent: vi.fn() } },
      wsClient: { value: wsClient },
      taskRunner: {
        value: { enqueueObservation: vi.fn((_kind: string, work: () => Promise<void>) => work()) },
      },
      reportingGeneration: { value: 21, writable: true },
      stateReportSequence: { value: 0, writable: true },
    });

    await (app as unknown as { sendStateReport(): Promise<void> }).sendStateReport();

    expect(retireGeneration).not.toHaveBeenCalled();
    expect((app as unknown as { reportingGeneration: number }).reportingGeneration).toBe(22);
  });

  it('sends a durable inventory fault before retiring an oversized full report', async () => {
    const send = vi.fn(() => true);
    const retireGeneration = vi.fn(() => true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = Object.create(AgentApplication.prototype) as AgentApplication;
      Object.defineProperties(app, {
        config: { value: { serverId: 'server-a' } },
        docker: { value: {
          listNyabaseContainers: vi.fn(async () => []),
          listImages: vi.fn(async () => []),
        } },
        quota: { value: { getAllUsages: vi.fn(async () => []) } },
        dataDirs: { value: {
          getLocalDiskInfos: vi.fn(() => []),
          listAllDirs: vi.fn(async () => [{
            sourceKind: 'local',
            sourceId: 'disk-a',
            resourceId: '00000000-0000-0000-0000-000000000001',
            hostPath: `/data/${'x'.repeat(MAX_AGENT_WS_FRAME_BYTES)}`,
          }]),
        } },
        remoteFsMounter: { value: { getAllStatuses: vi.fn(() => []) } },
        storageIdentity: { value: { assertCurrent: vi.fn() } },
        wsClient: { value: { connected: true, connectionGeneration: 9, send, retireGeneration } },
        taskRunner: {
          value: { enqueueObservation: vi.fn((_kind: string, work: () => Promise<void>) => work()) },
        },
        reportingGeneration: { value: 9, writable: true },
        stateReportSequence: { value: 0, writable: true },
      });

      await (app as unknown as { sendStateReport(): Promise<void> }).sendStateReport();

      expect(send.mock.calls.some((call) =>
        (call as unknown as Array<{ kind?: string }>)[0]?.kind === 'stateReport')).toBe(false);
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'inventoryFault',
        payload: expect.objectContaining({
          code: 'AUTHORITATIVE_INVENTORY_TOO_LARGE',
          message: expect.stringContaining('maximum'),
        }),
      }), 9);
      expect(retireGeneration).toHaveBeenCalledWith(9, 4502, 'Authoritative inventory too large');
    } finally {
      warning.mockRestore();
    }
  });

  it('sends an inventory fault before the Backend watchdog when collection stalls', async () => {
    vi.useFakeTimers();
    const send = vi.fn((_message: AgentToBackendMessage, _generation?: number) => true);
    const retireGeneration = vi.fn(() => true);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let releaseCollection!: () => void;
    const collectionGate = new Promise<void>((resolve) => { releaseCollection = resolve; });
    try {
      const listNyabaseContainers = vi.fn(async () => {
        await collectionGate;
        return [];
      });
      const app = Object.create(AgentApplication.prototype) as AgentApplication;
      Object.defineProperties(app, {
        config: { value: { serverId: 'server-a' } },
        docker: { value: {
          listNyabaseContainers,
          listImages: vi.fn(async () => []),
        } },
        quota: { value: { getAllUsages: vi.fn(async () => []) } },
        dataDirs: { value: {
          getLocalDiskInfos: vi.fn(() => []),
          listAllDirs: vi.fn(async () => []),
        } },
        remoteFsMounter: { value: { getAllStatuses: vi.fn(() => []) } },
        storageIdentity: { value: { assertCurrent: vi.fn() } },
        wsClient: { value: {
          connected: true,
          connectionGeneration: 11,
          send,
          retireGeneration,
        } },
        taskRunner: {
          value: { enqueueObservation: vi.fn((_kind: string, work: () => Promise<void>) => work()) },
        },
        reportingGeneration: { value: 11, writable: true },
        stateReportSequence: { value: 0, writable: true },
      });

      const report = (app as unknown as { sendStateReport(): Promise<void> }).sendStateReport();
      await vi.advanceTimersByTimeAsync(0);
      expect(listNyabaseContainers).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(AUTHORITATIVE_INVENTORY_DEADLINE_MS);

      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'inventoryFault',
        payload: expect.objectContaining({
          code: 'AUTHORITATIVE_INVENTORY_FAILED',
          message: expect.stringContaining('exceeded'),
        }),
      }), 11);
      expect(retireGeneration).toHaveBeenCalledWith(
        11,
        4502,
        'Authoritative inventory failed',
      );
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(AUTHORITATIVE_INVENTORY_FAIL_STOP_GRACE_MS - 1);
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');

      releaseCollection();
      await report;
      expect(send.mock.calls.filter(([message]) =>
        (message as AgentToBackendMessage).kind === 'stateReport')).toHaveLength(0);
    } finally {
      releaseCollection?.();
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('freezes a stable fresh-inspect identity and canonical writable-layer paths in a full report', async () => {
    const immutableLabels = {
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: 'container-a',
      [LABEL.SERVER_ID]: 'server-a',
      [LABEL.SPEC_GENERATION]: '7',
      [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
    };
    const inspectedLabels = {
      ...immutableLabels,
      'external.untrusted-noise': 'x'.repeat(256 * 1024),
    };
    const inspected = {
      Id: 'runtime-a',
      Config: { Labels: inspectedLabels },
      State: { Status: 'running', Running: true },
      NetworkSettings: { Networks: { nyabase_net: { IPAddress: '10.0.0.2' } } },
    };
    const send = vi.fn(() => true);
    const inspectContainer = vi.fn().mockResolvedValue(inspected);
    const parseContainerRuntimeObservation = vi.fn((
      _labels: Record<string, string>,
      observation: { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } },
    ) => ({
      ip: observation.NetworkSettings?.Networks?.nyabase_net?.IPAddress ?? '',
      serverId: 'server-a',
      specGeneration: '7',
    }));
    const getGraphDriverDirs = vi.fn().mockResolvedValue({
      upperDir: '/var/lib/nyabase-docker/overlay2/layer-a/diff',
      workDir: '/var/lib/nyabase-docker/overlay2/layer-a/work',
    });
    const app = Object.create(AgentApplication.prototype) as AgentApplication;
    Object.defineProperties(app, {
      config: { value: { serverId: 'server-a', dockerRoot: '/var/lib/nyabase-docker' } },
      docker: { value: {
        listNyabaseContainers: vi.fn(async () => [{
          Id: 'runtime-a', Labels: inspectedLabels, State: 'running',
          NetworkSettings: { Networks: { nyabase_net: { IPAddress: '10.0.0.99' } } },
        }]),
        inspectContainer,
        getGraphDriverDirs,
        parseContainerRuntimeObservation,
        listImages: vi.fn(async () => []),
      } },
      dropbearManager: { value: { inspectContainerSshState: vi.fn(async () => ({
        enabled: false, status: 'disabled', user: 'root', port: 22,
      })) } },
      quota: { value: { getAllUsages: vi.fn(async () => []) } },
      dataDirs: { value: {
        getLocalDiskInfos: vi.fn(() => []),
        listAllDirs: vi.fn(async () => []),
      } },
      remoteFsMounter: { value: { getAllStatuses: vi.fn(() => []) } },
      storageIdentity: { value: { assertCurrent: vi.fn() } },
      wsClient: { value: { connected: true, connectionGeneration: 6, send } },
      taskRunner: { value: { enqueueObservation: vi.fn((_kind: string, work: () => Promise<void>) => work()) } },
      reportingGeneration: { value: 6, writable: true },
      stateReportSequence: { value: 0, writable: true },
    });

    await (app as unknown as { sendStateReport(): Promise<void> }).sendStateReport();

    expect(inspectContainer).toHaveBeenCalledTimes(3);
    expect(getGraphDriverDirs).toHaveBeenCalledTimes(3);
    expect(parseContainerRuntimeObservation).toHaveBeenCalledTimes(3);
    expect(parseContainerRuntimeObservation.mock.calls.every(([, observation]) =>
      observation === inspected)).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'stateReport',
      payload: expect.objectContaining({
        containers: [expect.objectContaining({
          runtime: expect.objectContaining({
            runtimeId: 'runtime-a',
            ip: '10.0.0.2',
            specGeneration: '7',
            quotaPaths: [
              '/var/lib/nyabase-docker/overlay2/layer-a/diff',
              '/var/lib/nyabase-docker/overlay2/layer-a/work',
            ],
          }),
          labels: immutableLabels,
        })],
      }),
    }), 6);
  });

  it('rejects a full report when container power changes during SSH observation', async () => {
    const immutableLabels = {
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: 'container-a',
      [LABEL.SERVER_ID]: 'server-a',
      [LABEL.SPEC_GENERATION]: '1',
      [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
    };
    const observed = {
      Id: 'runtime-a',
      Config: { Labels: immutableLabels },
      State: { Status: 'running', Running: true },
      NetworkSettings: { Networks: { nyabase_net: { IPAddress: '10.0.0.2' } } },
    };
    const stopped = { ...observed, State: { Status: 'exited', Running: false } };
    const send = vi.fn((_message: AgentToBackendMessage, _generation?: number) => true);
    const retireGeneration = vi.fn(() => true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = Object.create(AgentApplication.prototype) as AgentApplication;
      Object.defineProperties(app, {
        config: { value: { serverId: 'server-a', dockerRoot: '/var/lib/nyabase-docker' } },
        docker: { value: {
          listNyabaseContainers: vi.fn(async () => [{ Id: 'runtime-a' }]),
          inspectContainer: vi.fn()
            .mockResolvedValueOnce(observed)
            .mockResolvedValueOnce(observed)
            .mockResolvedValueOnce(stopped),
          getGraphDriverDirs: vi.fn(async () => ({
            upperDir: '/var/lib/nyabase-docker/overlay2/layer-a/diff',
            workDir: '/var/lib/nyabase-docker/overlay2/layer-a/work',
          })),
          parseContainerRuntimeObservation: vi.fn((
            _labels: Record<string, string>,
            observation: typeof observed,
          ) => ({
            ip: observation.NetworkSettings.Networks.nyabase_net.IPAddress,
            serverId: 'server-a',
            specGeneration: '1',
          })),
        } },
        dropbearManager: { value: { inspectContainerSshState: vi.fn(async () => ({
          enabled: false, status: 'disabled', user: 'root', port: 22,
        })) } },
        storageIdentity: { value: { assertCurrent: vi.fn() } },
        wsClient: { value: {
          connected: true,
          connectionGeneration: 13,
          send,
          retireGeneration,
        } },
        taskRunner: {
          value: { enqueueObservation: vi.fn((_kind: string, work: () => Promise<void>) => work()) },
        },
        reportingGeneration: { value: 13, writable: true },
        stateReportSequence: { value: 0, writable: true },
      });

      await (app as unknown as { sendStateReport(): Promise<void> }).sendStateReport();

      expect(send.mock.calls.some(([message]) => message.kind === 'stateReport')).toBe(false);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'inventoryFault',
        payload: expect.objectContaining({
          code: 'AUTHORITATIVE_INVENTORY_FAILED',
          message: expect.stringContaining('changed power state'),
        }),
      }), 13);
      expect(retireGeneration).toHaveBeenCalledWith(13, 4502, 'Authoritative inventory failed');
    } finally {
      warning.mockRestore();
    }
  });

  it('rejects a full report when the managed runtime IP changes between exact inspects', async () => {
    const immutableLabels = {
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: 'container-a',
      [LABEL.SERVER_ID]: 'server-a',
      [LABEL.SPEC_GENERATION]: '1',
      [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
    };
    const observed = (ip: string) => ({
      Id: 'runtime-a',
      Config: { Labels: immutableLabels },
      State: { Status: 'running', Running: true },
      NetworkSettings: { Networks: { nyabase_net: { IPAddress: ip } } },
    });
    const send = vi.fn((_message: AgentToBackendMessage, _generation?: number) => true);
    const retireGeneration = vi.fn(() => true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = Object.create(AgentApplication.prototype) as AgentApplication;
      Object.defineProperties(app, {
        config: { value: { serverId: 'server-a', dockerRoot: '/var/lib/nyabase-docker' } },
        docker: { value: {
          listNyabaseContainers: vi.fn(async () => [{ Id: 'runtime-a' }]),
          inspectContainer: vi.fn()
            .mockResolvedValueOnce(observed('10.0.0.2'))
            .mockResolvedValueOnce(observed('10.0.0.3')),
          getGraphDriverDirs: vi.fn(async () => ({
            upperDir: '/var/lib/nyabase-docker/overlay2/layer-a/diff',
            workDir: '/var/lib/nyabase-docker/overlay2/layer-a/work',
          })),
          parseContainerRuntimeObservation: vi.fn((
            _labels: Record<string, string>,
            observation: ReturnType<typeof observed>,
          ) => ({
            ip: observation.NetworkSettings.Networks.nyabase_net.IPAddress,
            serverId: 'server-a',
            specGeneration: '1',
          })),
        } },
        storageIdentity: { value: { assertCurrent: vi.fn() } },
        wsClient: { value: {
          connected: true,
          connectionGeneration: 14,
          send,
          retireGeneration,
        } },
        taskRunner: {
          value: { enqueueObservation: vi.fn((_kind: string, work: () => Promise<void>) => work()) },
        },
        reportingGeneration: { value: 14, writable: true },
        stateReportSequence: { value: 0, writable: true },
      });

      await (app as unknown as { sendStateReport(): Promise<void> }).sendStateReport();

      expect(send.mock.calls.some(([message]) => message.kind === 'stateReport')).toBe(false);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'inventoryFault',
        payload: expect.objectContaining({
          code: 'AUTHORITATIVE_INVENTORY_FAILED',
          message: expect.stringContaining('changed identity'),
        }),
      }), 14);
      expect(retireGeneration).toHaveBeenCalledWith(14, 4502, 'Authoritative inventory failed');
    } finally {
      warning.mockRestore();
    }
  });

  it('does not send a partial full report when writable-layer paths escape dockerRoot', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi.fn(() => true);
    const retireGeneration = vi.fn(() => true);
    try {
      const immutableLabels = {
        [LABEL.MANAGED]: 'true',
        [LABEL.CONTAINER_ID]: 'container-a',
        [LABEL.SERVER_ID]: 'server-a',
        [LABEL.SPEC_GENERATION]: '1',
        [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
      };
      const app = Object.create(AgentApplication.prototype) as AgentApplication;
      Object.defineProperties(app, {
        config: { value: { serverId: 'server-a', dockerRoot: '/var/lib/nyabase-docker' } },
        docker: { value: {
          listNyabaseContainers: vi.fn(async () => [{ Id: 'runtime-a', Labels: immutableLabels }]),
          inspectContainer: vi.fn(async () => ({
            Id: 'runtime-a', Config: { Labels: immutableLabels }, State: { Status: 'running', Running: true },
          })),
          parseContainerRuntimeObservation: vi.fn(() => ({
            ip: '', serverId: 'server-a', specGeneration: '1',
          })),
          getGraphDriverDirs: vi.fn(async () => ({ upperDir: '/etc/unsafe', workDir: '/etc/unsafe-work' })),
        } },
        storageIdentity: { value: { assertCurrent: vi.fn() } },
        wsClient: { value: { connected: true, connectionGeneration: 8, send, retireGeneration } },
        taskRunner: { value: { enqueueObservation: vi.fn((_kind: string, work: () => Promise<void>) => work()) } },
        reportingGeneration: { value: 8, writable: true },
        stateReportSequence: { value: 0, writable: true },
      });

      await (app as unknown as { sendStateReport(): Promise<void> }).sendStateReport();

      expect(send.mock.calls.some((call) =>
        (call as unknown as Array<{ kind?: string }>)[0]?.kind === 'stateReport')).toBe(false);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'inventoryFault',
        payload: expect.objectContaining({
          serverId: 'server-a',
          code: 'AUTHORITATIVE_INVENTORY_FAILED',
          message: expect.stringContaining('non-canonical writable-layer paths'),
        }),
      }), 8);
      expect(warning).toHaveBeenCalledWith(
        '[Agent] Failed to send stateReport:',
        expect.objectContaining({ message: expect.stringContaining('non-canonical writable-layer paths') }),
      );
      expect(retireGeneration).toHaveBeenCalledWith(8, 4502, 'Authoritative inventory failed');
    } finally {
      warning.mockRestore();
    }
  });

  it('reconnects a closed Docker event stream without keeping the stale generation active', async () => {
    vi.useFakeTimers();
    try {
      const first = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      const second = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      const openContainerEventStream = vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const app = Object.create(AgentApplication.prototype) as AgentApplication;
      Object.defineProperties(app, {
        docker: { value: { openContainerEventStream } },
        dockerEventListenerGeneration: { value: 0, writable: true },
        sendStateReport: { value: vi.fn() },
      });
      const listener = app as unknown as { startDockerEventListener(): Promise<void> };

      await listener.startDockerEventListener();
      first.emit('close');
      await vi.advanceTimersByTimeAsync(1_000);

      expect(openContainerEventStream).toHaveBeenCalledTimes(2);
      expect(first.listenerCount('data')).toBe(0);
      expect(first.destroy).toHaveBeenCalledOnce();
      expect(second.listenerCount('data')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds full-report SSH observation concurrency while preserving inventory order', async () => {
    let active = 0;
    let peak = 0;
    const values = Array.from({ length: 25 }, (_, index) => index);
    const mapped = await mapWithConcurrency(values, 4, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return value * 2;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(mapped).toEqual(values.map((value) => value * 2));
  });
});
