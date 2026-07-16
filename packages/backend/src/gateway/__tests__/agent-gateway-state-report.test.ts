import {
  AgentTaskKind,
  ContainerStatus,
  ContainerPhase,
  RemoteFsType,
  ServerStatus,
  LABEL,
  AGENT_BOOTSTRAP_RPC_TIMEOUT_MS,
  AGENT_STEADY_STATE_REPORT_TIMEOUT_MS,
  AGENT_INITIAL_STATE_REPORT_TIMEOUT_MS,
  type ContainerSnapshot,
  type AgentBootstrapResult,
  type DiskInfo,
  type RemoteFsMountSpec,
  type RemoteFsMountStatus,
  type StateReportPayload,
  type TaskExecutePayload,
} from '@nyabase/common';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  AgentGateway,
  MAX_AGENT_PENDING_INBOUND_BYTES_GLOBAL,
} from '../agent-gateway.js';
import { AgentRpcTransportError } from '../agent-session.js';
import { ServerEntity } from '../../entities/server.entity.js';
import { MAX_NETWORK_ADDRESS_CLAIMS_GLOBAL } from '../../common/network-claim-ledger.js';

const HOST_FINGERPRINT = 'a'.repeat(64);
const CONFIG_FINGERPRINT = 'f'.repeat(64);
const TASK_HASH = 'b'.repeat(64);
const RUNTIME_SPEC_HASH = 'c'.repeat(64);

type TestGateway = Pick<AgentGateway, 'stateCache' | 'rpc' | 'notify'> & {
  onHello(server: ServerEntity, payload: unknown, session?: unknown): Promise<void>;
  onStateReport(server: ServerEntity, payload: StateReportPayload, session?: unknown): Promise<void>;
  onContainerEvent(server: ServerEntity, payload: { serverId: string; runtimeId: string; action: string }): Promise<void>;
  handleMessage(
    session: unknown,
    server: ServerEntity,
    raw: string,
    ingress?: { wallMs: number; monotonicMs: number },
  ): Promise<void>;
  handleConnection(ws: unknown, req: unknown): Promise<void>;
  attachToHttpServer(server: unknown): void;
  receiveMessage(session: unknown, server: ServerEntity, raw: string): void;
  bindHostFingerprint(server: ServerEntity, payload: unknown, session?: unknown): Promise<boolean>;
  assertBootstrapReady(expected: RemoteFsMountSpec[], result: AgentBootstrapResult): void;
  dispatchReadyServerIds(): string[];
  sendTask(serverId: string, payload: TaskExecutePayload): void;
  fenceSession(serverId: string, reason: string): Promise<void>;
  runWithSessionFence<T>(serverId: string, reason: string, work: () => Promise<T>): Promise<T>;
};

function makeContainer(runtimeId: string): ContainerSnapshot {
  return {
    runtime: {
      runtimeId,
      ip: '10.0.0.2',
      serverId: 'server-a',
      specGeneration: '1',
      quotaPaths: [
        `/var/lib/docker/overlay2/${runtimeId}/diff`,
        `/var/lib/docker/overlay2/${runtimeId}/work`,
      ],
    },
    status: ContainerStatus.Running,
    sshServer: { enabled: false, status: 'disabled', user: 'root', port: 22 },
    labels: {
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: runtimeId.replace(/^docker-/, 'container-'),
      [LABEL.SERVER_ID]: 'server-a',
      [LABEL.SPEC_GENERATION]: '1',
      [LABEL.RUNTIME_SPEC_HASH]: RUNTIME_SPEC_HASH,
    },
  };
}

function makeReport(overrides: Partial<StateReportPayload> = {}): StateReportPayload {
  const disk: DiskInfo = {
    diskId: 'disk-a',
    mountPoint: '/data-a',
    sourceIdentity: 'local:xfs:00000000-0000-0000-0000-000000000001',
    label: 'data-a',
    totalBytes: 1024,
    usedBytes: 128,
    pquotaEnabled: true,
  };
  const remoteFsMount: RemoteFsMountStatus = {
    id: 'remote-a',
    hostMountPoint: '/mnt/remote-fs/remote-a',
    status: 'mounted',
    lastCheckedAt: 1_780_000_000_000,
    totalBytes: 2048,
    usedBytes: 256,
  };

  return {
    serverId: 'server-a',
    sequence: 1,
    observedAt: 1_780_000_000_000,
    containers: [makeContainer('docker-a')],
    xfsProjects: [
      { numericUserId: 1001, projectId: 11001, usedBytes: 512, hardLimitBytes: 1024 },
      { numericUserId: 9999, projectId: 19999, usedBytes: 64, hardLimitBytes: 128 },
    ],
    dataDirs: [],
    disks: [disk],
    localImages: [],
    remoteFsMounts: [remoteFsMount],
    ...overrides,
  };
}

function makeGateway() {
  const serversRepo = {
    update: vi.fn(),
    findOne: vi.fn().mockResolvedValue(null),
    findOneBy: vi.fn().mockResolvedValue({
      id: 'server-a',
      hostFingerprint: HOST_FINGERPRINT,
      agentConfigFingerprint: CONFIG_FINGERPRINT,
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanReservedIps: [],
      status: ServerStatus.Unknown,
    }),
  };
  const containersRepo = {
    find: vi.fn(async (options: { where?: { id?: { _value?: string[]; value?: string[] } } }) =>
      (options.where?.id?.value ?? options.where?.id?._value ?? []).map((id) => ({
        id,
        serverId: 'server-a',
      }))),
  };
  const containerLifecyclesRepo = {
    find: vi.fn(async (options: { where?: { containerId?: { _value?: string[]; value?: string[] } } }) =>
      (options.where?.containerId?.value ?? options.where?.containerId?._value ?? []).map((containerId) => ({
        containerId,
        phase: ContainerPhase.Active,
        activeTaskId: null,
        boundRuntimeId: containerId.startsWith('container-')
          ? containerId.replace(/^container-/, 'docker-')
          : containerId,
        runtimeSpecHash: RUNTIME_SPEC_HASH,
      }))),
  };
  const containerMountsRepo = { find: vi.fn().mockResolvedValue([]) };
  const metricsWriter = { writeBatch: vi.fn() };
  const execSessionRegistry = {
    setOrphanHandler: vi.fn(),
    clearServer: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
  };
  const usersService = {
    getUserIdsByNumericIds: vi.fn().mockResolvedValue(new Map([[1001, 'user-a']])),
  };
  const taskDispatcher = {
    registerTransport: vi.fn(),
    wake: vi.fn(),
  };
  const taskResults = {
    handle: vi.fn().mockResolvedValue({ taskId: 'task-a', payloadHash: TASK_HASH }),
    quarantineMalformedResult: vi.fn().mockResolvedValue('task-a'),
    quarantineProtocolFault: vi.fn().mockResolvedValue(undefined),
  };
  const remoteFsAssignmentsRepo = { find: vi.fn().mockResolvedValue([]) };
  const remoteFsMountsRepo = { find: vi.fn().mockResolvedValue([]) };
  const agentTasksRepo = {
    find: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    existsBy: vi.fn().mockResolvedValue(false),
  };
  const taskPayloadCodec = {
    forRemoteFsBootstrap: vi.fn((mounts: unknown[]) => mounts),
  };
  const dataDirReconciler = {
    reconcileReport: vi.fn().mockResolvedValue({
      issues: { orphans: [], missing: [] },
      blockingReason: null,
    }),
  };
  const sshRoutes = {
    updateFromStateReport: vi.fn().mockResolvedValue(undefined),
    clearServer: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue(undefined),
  };
  const sshProxyGateway = {
    broadcastSnapshot: vi.fn().mockResolvedValue(undefined),
  };
  const httpProxyGateway = {
    scheduleBroadcast: vi.fn(),
  };
  const sshConvergence = {
    reconcileServer: vi.fn().mockResolvedValue(undefined),
  };
  const runtimeDriftReconciler = {
    reconcile: vi.fn().mockResolvedValue({
      taskIds: [], failedContainerIds: [], claimsChanged: false, quarantineReason: null,
    }),
  };
  const transactionManager = {
    findOneBy: vi.fn(async (entity: unknown, where: unknown) =>
      entity === ServerEntity ? serversRepo.findOneBy(where) : null),
    findOneByOrFail: vi.fn(async (entity: unknown, where: unknown) => {
      if (entity === ServerEntity) {
        const row = await serversRepo.findOneBy(where);
        if (row) return row;
      }
      throw new Error('row not found');
    }),
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn(async (entity: unknown, options?: unknown) => {
      if (entity === ServerEntity) {
        const row = await serversRepo.findOneBy({ id: 'server-a' });
        return row ? [row] : [];
      }
      if ((entity as { name?: string }).name === 'RemoteFsServerAssignmentEntity') {
        return remoteFsAssignmentsRepo.find(options);
      }
      if ((entity as { name?: string }).name === 'RemoteFsMountEntity') {
        return remoteFsMountsRepo.find(options);
      }
      if ((entity as { name?: string }).name === 'AgentTaskEntity') {
        return agentTasksRepo.find(options);
      }
      return [];
    }),
    count: vi.fn().mockResolvedValue(0),
    delete: vi.fn().mockResolvedValue({ affected: 0 }),
    update: vi.fn(async (entity: unknown, criteria: unknown, value: unknown) => {
      if (entity === ServerEntity) return serversRepo.update(criteria, value);
      return { affected: 1 };
    }),
    create: vi.fn((_entity: unknown, value: unknown) => value),
    save: vi.fn(async (_entity: unknown, value: unknown) => value),
  };
  const dataSource = {
    options: { type: 'postgres' },
    transaction: vi.fn(async (...args: unknown[]) => {
      const work = args.at(-1) as (manager: typeof transactionManager) => Promise<unknown>;
      return work(transactionManager);
    }),
  };
  const agentTasks = {
    supersedePendingForResourceInTransaction: vi.fn().mockResolvedValue([]),
    enqueueInTransaction: vi.fn().mockResolvedValue({ taskId: 'task-recovery' }),
  };
  const resourceKeys = {
    container: vi.fn((id: string) => `container:${id}`),
    remoteFsAssignment: vi.fn((serverId: string, id: string) => `remote_fs_assignment:${serverId}:${id}`),
  };
  const failStop = {
    terminate: vi.fn((error: unknown): never => { throw error; }),
  };
  const proxySnapshots = {
    blockServer: vi.fn(),
    blockServerRoutes: vi.fn(),
    currentBlockEpoch: vi.fn(() => 1),
    unblockServerIfEpoch: vi.fn(),
    invalidate: vi.fn(),
    isServerBlocked: vi.fn().mockReturnValue(false),
  };
  const ipReservationsRepo = {
    find: vi.fn(async (options?: { where?: Array<{ ownerId?: { value?: string[]; _value?: string[] } }> }) => {
      const ownerFilter = options?.where?.find((where) => where.ownerId)?.ownerId;
      const ownerIds = ownerFilter?.value ?? ownerFilter?._value ?? [];
      return ownerIds.map((ownerId) => ({
        ownerKind: 'container',
        ownerId,
        address: '10.0.0.2',
        serverId: 'server-a',
        networkKey: '10.0.0.0/24',
        state: 'active',
      }));
    }),
  };

  const gateway = new AgentGateway(
    serversRepo as never,
    containersRepo as never,
    containerLifecyclesRepo as never,
    containerMountsRepo as never,
    metricsWriter as never,
    execSessionRegistry as never,
    usersService as never,
    taskDispatcher as never,
    taskResults as never,
    remoteFsAssignmentsRepo as never,
    remoteFsMountsRepo as never,
    agentTasksRepo as never,
    taskPayloadCodec as never,
    dataSource as never,
    agentTasks as never,
    resourceKeys as never,
    runtimeDriftReconciler as never,
    dataDirReconciler as never,
    sshRoutes as never,
    sshProxyGateway as never,
    httpProxyGateway as never,
    sshConvergence as never,
    failStop as never,
    proxySnapshots as never,
    ipReservationsRepo as never,
  );

  return {
    gateway: gateway as unknown as TestGateway,
    metricsWriter,
    execSessionRegistry,
    usersService,
    taskDispatcher,
    taskResults,
    serversRepo,
    containersRepo,
    containerLifecyclesRepo,
    containerMountsRepo,
    remoteFsAssignmentsRepo,
    remoteFsMountsRepo,
    agentTasksRepo,
    taskPayloadCodec,
    dataDirReconciler,
    transactionManager,
    dataSource,
    agentTasks,
    resourceKeys,
    sshRoutes,
    sshProxyGateway,
    httpProxyGateway,
    sshConvergence,
    runtimeDriftReconciler,
    failStop,
    proxySnapshots,
    ipReservationsRepo,
  };
}

function makeSession(serverId = 'server-a') {
  const reportSequences = new Map<string, number>();
  const session = {
    id: `session-${Math.random()}`,
    serverId,
    ws: { close: vi.fn(), terminate: vi.fn(), readyState: WebSocket.OPEN as number },
    send: vi.fn(),
    rpc: vi.fn().mockResolvedValue({ remoteFsMounts: [] }),
    beginHello: vi.fn().mockReturnValue(true),
    hasReceivedHello: true,
    bootstrapReady: false,
    dispatchReady: false,
    markBootstrapReady: vi.fn(),
    markDispatchReady: vi.fn(),
    rejectAll: vi.fn(),
    resolveAck: vi.fn(),
    markInbound: vi.fn(),
    markFullReportReceived: vi.fn(),
    inboundExpired: vi.fn().mockReturnValue(false),
    initializationExpired: vi.fn().mockReturnValue(false),
    fullReportExpired: vi.fn().mockReturnValue(false),
    acceptReportSequence: vi.fn((kind: string, sequence: number) => {
      const previous = reportSequences.get(kind);
      if (previous !== undefined && sequence <= previous) return false;
      reportSequences.set(kind, sequence);
      return true;
    }),
  };
  session.markDispatchReady.mockImplementation(() => {
    session.dispatchReady = true;
  });
  session.markBootstrapReady.mockImplementation(() => {
    session.bootstrapReady = true;
  });
  return session;
}

function activeSession(gateway: TestGateway, serverId = 'server-a') {
  const session = makeSession(serverId);
  (gateway as unknown as { sessions: Map<string, unknown> }).sessions.set(serverId, session);
  if (!gateway.stateCache.get(serverId)) {
    const snapshot = (gateway as unknown as {
      emptySnapshot(id: string, sessionId: string, now: number): ReturnType<TestGateway['stateCache']['get']>;
    }).emptySnapshot(serverId, session.id, Date.now());
    gateway.stateCache.set(serverId, {
      ...snapshot!,
      helloAt: Date.now(),
      dockerRoot: '/var/lib/docker',
    });
  }
  return session;
}

function wsMessage(kind: string, payload: unknown): string {
  return JSON.stringify({ ts: Date.now(), kind, payload });
}

function helloPayload(
  hostFingerprint = HOST_FINGERPRINT,
  configFingerprint = CONFIG_FINGERPRINT,
) {
  return {
    serverId: 'server-a',
    hostFingerprint,
    configFingerprint,
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
  };
}

describe('AgentGateway state cache runtime readiness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hello initializes a snapshot but does not mark runtime ready', async () => {
    const { gateway } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;

    await gateway.onHello(server, helloPayload());

    const snapshot = gateway.stateCache.get('server-a');
    expect(snapshot?.runtimeReady).toBe(false);
    expect(snapshot?.helloAt).toEqual(expect.any(Number));
    expect(snapshot?.agentVersion).toBe('0.1.0');
  });

  it('resolves bootstrap acknowledgements outside the serialized hello queue', () => {
    const { gateway } = makeGateway();
    const session = activeSession(gateway, 'server-a');
    const never = new Promise<void>(() => undefined);
    (gateway as unknown as { serverWorkTails: Map<string, Promise<void>> })
      .serverWorkTails.set('server-a', never);

    gateway.receiveMessage(
      session,
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      wsMessage('commandAck', {
        commandId: 'bootstrap-command-a',
        ok: true,
        data: { remoteFsMounts: [] },
      }),
    );

    expect(session.resolveAck).toHaveBeenCalledWith(
      'bootstrap-command-a',
      true,
      undefined,
      { remoteFsMounts: [] },
    );
  });

  it('coalesces bootstrap heartbeats into socket liveness without queue growth', () => {
    const { gateway, taskResults } = makeGateway();
    const session = activeSession(gateway, 'server-a');
    session.bootstrapReady = false;
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;

    for (let index = 0; index < 256; index += 1) {
      gateway.receiveMessage(session, server, wsMessage('heartbeat', {
        serverId: 'server-a',
        uptime: index,
      }));
    }

    expect(session.markInbound).toHaveBeenCalledTimes(256);
    expect((gateway as unknown as { inboundWorkDepth: Map<string, number> })
      .inboundWorkDepth.has('server-a')).toBe(false);
    expect(taskResults.quarantineProtocolFault).not.toHaveBeenCalled();
    expect(session.ws.terminate).not.toHaveBeenCalled();
  });

  it('consumes heartbeat persistence failures and fences only that connection', async () => {
    const { gateway, proxySnapshots } = makeGateway();
    const session = activeSession(gateway, 'server-a');
    session.bootstrapReady = true;
    (gateway as unknown as { onHeartbeat: ReturnType<typeof vi.fn> }).onHeartbeat =
      vi.fn().mockRejectedValue(new Error('temporary database failure'));

    gateway.receiveMessage(
      session,
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      wsMessage('heartbeat', { serverId: 'server-a', uptime: 1 }),
    );
    await vi.waitFor(() => expect(session.ws.terminate).toHaveBeenCalledTimes(1));

    expect(session.rejectAll).toHaveBeenCalledWith('Agent heartbeat persistence failed');
    expect(proxySnapshots.blockServer).not.toHaveBeenCalledWith(
      'server-a',
      'Agent inbound work limit exceeded',
    );
    expect((gateway as unknown as { pendingHeartbeatServers: Set<string> })
      .pendingHeartbeatServers.has('server-a')).toBe(false);
  });

  it('keeps owned console output off the authoritative inbound queue', () => {
    const { gateway, execSessionRegistry, taskResults, proxySnapshots } = makeGateway();
    const session = activeSession(gateway, 'server-a');
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    execSessionRegistry.get.mockReturnValue({ serverId: 'server-a' });
    const tracker = (gateway as unknown as {
      logChunkTracker: { dispatch: ReturnType<typeof vi.fn> };
    }).logChunkTracker;
    tracker.dispatch = vi.fn();
    (gateway as unknown as { serverWorkTails: Map<string, Promise<void>> })
      .serverWorkTails.set('server-a', new Promise<void>(() => undefined));

    for (let index = 0; index < 256; index += 1) {
      gateway.receiveMessage(session, server, wsMessage('logChunk', {
        sessionId: 'exec-a',
        data: `line-${index}`,
        eof: false,
      }));
    }

    expect(tracker.dispatch).toHaveBeenCalledTimes(256);
    expect((gateway as unknown as { inboundWorkDepth: Map<string, number> })
      .inboundWorkDepth.has('server-a')).toBe(false);
    expect(proxySnapshots.blockServer).not.toHaveBeenCalled();
    expect(taskResults.quarantineProtocolFault).not.toHaveBeenCalled();
    expect(session.ws.terminate).not.toHaveBeenCalled();
  });

  it('reconnects one session without durable quarantine at the global inbound budget', () => {
    const { gateway, proxySnapshots, taskResults } = makeGateway();
    const session = activeSession(gateway, 'server-a');
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    (gateway as unknown as { inboundWorkBytesTotal: number }).inboundWorkBytesTotal =
      MAX_AGENT_PENDING_INBOUND_BYTES_GLOBAL;

    gateway.receiveMessage(session, server, wsMessage('stateReport', makeReport()));

    expect(proxySnapshots.blockServerRoutes).toHaveBeenCalledWith(
      'server-a',
      'Backend Agent inbound global capacity reached',
    );
    expect(proxySnapshots.blockServer).not.toHaveBeenCalledWith(
      'server-a',
      'Agent inbound work limit exceeded',
    );
    expect(session.rejectAll).toHaveBeenCalledWith(
      'Backend Agent inbound global capacity reached',
    );
    expect(session.ws.terminate).toHaveBeenCalledOnce();
    expect(taskResults.quarantineProtocolFault).not.toHaveBeenCalled();
  });

  it('drops console output for an exec session owned by another server', () => {
    const { gateway, execSessionRegistry } = makeGateway();
    const session = activeSession(gateway, 'server-a');
    execSessionRegistry.get.mockReturnValue({ serverId: 'server-b' });
    const tracker = (gateway as unknown as {
      logChunkTracker: { dispatch: ReturnType<typeof vi.fn> };
    }).logChunkTracker;
    tracker.dispatch = vi.fn();

    gateway.receiveMessage(
      session,
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      wsMessage('logChunk', { sessionId: 'foreign-exec', data: 'secret', eof: false }),
    );

    expect(tracker.dispatch).not.toHaveBeenCalled();
    expect((gateway as unknown as { inboundWorkDepth: Map<string, number> })
      .inboundWorkDepth.has('server-a')).toBe(false);
  });

  it('keeps the report watchdog beyond the longest normal image task', () => {
    const { gateway } = makeGateway();
    const session = activeSession(gateway, 'server-a');
    session.bootstrapReady = true;
    session.dispatchReady = true;

    (gateway as unknown as { expireSilentSessions(now: number): void })
      .expireSilentSessions(1_000);

    expect(session.fullReportExpired).toHaveBeenCalledWith(
      1_000,
      AGENT_STEADY_STATE_REPORT_TIMEOUT_MS,
    );
    expect(AGENT_STEADY_STATE_REPORT_TIMEOUT_MS).toBeGreaterThan(30 * 60_000);
    expect(session.ws.terminate).not.toHaveBeenCalled();
  });

  it('allows bounded Backend apply time after the Agent initial inventory deadline', () => {
    const { gateway } = makeGateway();
    const session = activeSession(gateway, 'server-a');
    session.bootstrapReady = true;
    session.dispatchReady = false;

    (gateway as unknown as { expireSilentSessions(now: number): void })
      .expireSilentSessions(121_000);

    expect(session.initializationExpired).toHaveBeenCalledWith(
      121_000,
      AGENT_INITIAL_STATE_REPORT_TIMEOUT_MS,
    );
    expect(AGENT_INITIAL_STATE_REPORT_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(session.ws.terminate).not.toHaveBeenCalled();
  });

  it('quarantines only an explicit pre-hello Agent initialization failure close', async () => {
    const { gateway, serversRepo } = makeGateway();
    const session = makeSession();
    session.hasReceivedHello = false;
    const quarantine = gateway as unknown as {
      quarantineIncompleteInitialization(
        value: typeof session,
        serverId: string,
        reason: string,
        closeCode?: number,
      ): Promise<void>;
    };

    await quarantine.quarantineIncompleteInitialization(
      session,
      'server-a',
      'ordinary network loss',
      1006,
    );
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
    }));

    await quarantine.quarantineIncompleteInitialization(
      session,
      'server-a',
      'Agent initialization failed',
      4501,
    );
    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
      quarantineMessage: 'Agent pre-hello initialization failed',
    }));
  });

  it('reconnects after post-hello disconnects and quarantines only an explicit inventory fault', async () => {
    const { gateway, serversRepo } = makeGateway();
    const initializing = makeSession();
    const quarantine = gateway as unknown as {
      quarantineIncompleteInitialization(
        value: typeof initializing,
        serverId: string,
        reason: string,
        closeCode?: number,
      ): Promise<void>;
    };

    await quarantine.quarantineIncompleteInitialization(
      initializing,
      'server-a',
      'initial state report deadline exceeded',
    );
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
    }));

    serversRepo.update.mockClear();
    initializing.markDispatchReady();
    await quarantine.quarantineIncompleteInitialization(
      initializing,
      'server-a',
      'ordinary ready-session disconnect',
      1006,
    );
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
    }));

    await quarantine.quarantineIncompleteInitialization(
      initializing,
      'server-a',
      'authoritative inventory failed',
      4502,
    );
    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
      quarantineMessage: 'Agent reported an authoritative inventory failure',
    }));
  });

  it('first full state report marks ready and stores only stateCache runtime data', async () => {
    const { gateway, usersService, sshRoutes, sshConvergence } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const report = makeReport({ observedAt: 1_780_000_000_000 });

    await gateway.onStateReport(server, report);

    expect(usersService.getUserIdsByNumericIds).toHaveBeenCalledWith([1001, 9999]);
    const snapshot = gateway.stateCache.get('server-a');
    expect(snapshot?.runtimeReady).toBe(true);
    expect(snapshot?.lastFullReportAt).toBe(1_780_000_000_000);
    expect(snapshot?.lastUpdated).toBe(1_780_000_000_000);
    expect(snapshot?.lastFullReportReceivedAt).toEqual(expect.any(Number));
    expect(snapshot?.containers.get('docker-a')).toEqual(report.containers[0]);
    expect(snapshot?.dataDirs).toEqual(report.dataDirs);
    expect(snapshot?.xfsProjects).toEqual([
      { userId: 'user-a', projectId: 11001, usedBytes: 512, hardLimitBytes: 1024 },
    ]);
    expect(snapshot?.unknownXfsNumericIds).toEqual([9999]);
    expect(snapshot?.disks).toEqual(report.disks);
    expect(snapshot?.remoteFsMounts).toEqual(report.remoteFsMounts);
    expect(sshRoutes.updateFromStateReport).toHaveBeenCalledWith(
      'server-a',
      expect.any(Array),
      expect.any(Number),
    );
    expect(sshConvergence.reconcileServer).toHaveBeenCalledWith('server-a');
  });

  it('keeps a committed Agent inventory authoritative when an independent SSH snapshot fails', async () => {
    const { gateway, sshProxyGateway, serversRepo, taskResults } = makeGateway();
    const session = activeSession(gateway, 'server-a');
    session.bootstrapReady = true;
    sshProxyGateway.broadcastSnapshot.mockRejectedValueOnce(new Error('snapshot capacity fault'));
    const loggerError = vi.fn();
    (gateway as unknown as { logger: { error: typeof loggerError } }).logger.error = loggerError;

    await expect(gateway.onStateReport(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      makeReport({ remoteFsMounts: [] }),
      session as never,
    )).resolves.toBeUndefined();

    expect(gateway.stateCache.get('server-a')?.runtimeReady).toBe(true);
    expect(session.ws.terminate).not.toHaveBeenCalled();
    expect(taskResults.quarantineProtocolFault).not.toHaveBeenCalled();
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
    }));
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('snapshot capacity fault'));
  });

  it('does not expose a half-applied state report when projection building fails', async () => {
    const { gateway, usersService } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    await gateway.onStateReport(server, makeReport({
      containers: [makeContainer('stable-runtime')],
      xfsProjects: [],
    }));
    usersService.getUserIdsByNumericIds.mockRejectedValueOnce(new Error('identity lookup failed'));

    await expect(gateway.onStateReport(server, makeReport({
      sequence: 2,
      containers: [makeContainer('partial-runtime')],
    }))).rejects.toThrow('identity lookup failed');

    expect([...gateway.stateCache.get('server-a')!.containers.keys()]).toEqual(['stable-runtime']);
  });

  it('refreshes local images from full state reports', async () => {
    const { gateway } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;

    await gateway.onStateReport(server, makeReport({
      localImages: [
        { id: 'sha256:image-a', repoTags: ['alpine:3.20'], size: 1024, createdAt: 1_780_000_000_000 },
      ],
    }));

    expect(gateway.stateCache.hasImage('server-a', 'alpine:3.20')).toBe(true);
  });

  it('summarizes unknown XFS numeric user ids and only warns again for new ids', async () => {
    const { gateway } = makeGateway();
    const warn = vi.fn();
    (gateway as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;

    await gateway.onStateReport(server, makeReport({
      xfsProjects: [
        { numericUserId: 1001, projectId: 11001, usedBytes: 512, hardLimitBytes: 1024 },
        { numericUserId: 42, projectId: 10042, usedBytes: 64, hardLimitBytes: 128 },
        { numericUserId: 41, projectId: 10041, usedBytes: 64, hardLimitBytes: 128 },
      ],
    }));
    await gateway.onStateReport(server, makeReport({
      xfsProjects: [
        { numericUserId: 1001, projectId: 11001, usedBytes: 512, hardLimitBytes: 1024 },
        { numericUserId: 41, projectId: 10041, usedBytes: 64, hardLimitBytes: 128 },
        { numericUserId: 42, projectId: 10042, usedBytes: 64, hardLimitBytes: 128 },
      ],
    }));
    await gateway.onStateReport(server, makeReport({
      xfsProjects: [
        { numericUserId: 1001, projectId: 11001, usedBytes: 512, hardLimitBytes: 1024 },
        { numericUserId: 41, projectId: 10041, usedBytes: 64, hardLimitBytes: 128 },
        { numericUserId: 43, projectId: 10043, usedBytes: 64, hardLimitBytes: 128 },
      ],
    }));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      '[StateReport] Unknown XFS numericUserIds from server server-a — skipping new=41,42 reportUnknownCount=2',
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      '[StateReport] Unknown XFS numericUserIds from server server-a — skipping new=43 reportUnknownCount=2',
    );
    expect(gateway.stateCache.get('server-a')?.unknownXfsNumericIds).toEqual([41, 43]);
  });

  it('docker daemon messages do not mark runtime ready', async () => {
    const { gateway } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a');

    await gateway.handleMessage(session, server, JSON.stringify({
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

    expect(gateway.stateCache.isRuntimeReady('server-a')).toBe(false);
  });

  it('rejects reports that arrive out of sequence within one session', async () => {
    const { gateway } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a');

    await gateway.handleMessage(session, server, wsMessage('stateReport', makeReport({
      sequence: 2,
      containers: [makeContainer('runtime-new')],
      remoteFsMounts: [],
    })));
    await gateway.handleMessage(session, server, wsMessage('stateReport', makeReport({
      sequence: 1,
      containers: [makeContainer('runtime-old')],
      remoteFsMounts: [],
    })));

    const snapshot = gateway.stateCache.get('server-a');
    expect(snapshot?.containers.has('runtime-new')).toBe(true);
    expect(snapshot?.containers.has('runtime-old')).toBe(false);

  });

  it('accepts structurally valid unknown runtime inventory for durable drift reconciliation', async () => {
    const { gateway, runtimeDriftReconciler } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a');

    const report = makeReport({ remoteFsMounts: [] });
    await gateway.handleMessage(session, server, wsMessage('stateReport', report));

    expect(session.ws.terminate).not.toHaveBeenCalled();
    expect(runtimeDriftReconciler.reconcile).toHaveBeenCalledWith(
      'server-a',
      report.containers,
      expect.any(String),
    );
    expect(gateway.stateCache.get('server-a')?.runtimeReady).toBe(true);
  });

  it.each([
    ['outside Docker root', ['/etc/unsafe-upper', '/etc/unsafe-work']],
    ['duplicate paths', ['/var/lib/docker/overlay2/shared', '/var/lib/docker/overlay2/shared']],
  ])('rejects a full report with %s writable-layer evidence', async (_caseName, quotaPaths) => {
    const { gateway, runtimeDriftReconciler } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a');
    const container = makeContainer('runtime-unsafe');
    container.runtime.quotaPaths = quotaPaths;

    await gateway.handleMessage(
      session,
      server,
      wsMessage('stateReport', makeReport({ containers: [container], remoteFsMounts: [] })),
    );

    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
    expect(runtimeDriftReconciler.reconcile).not.toHaveBeenCalled();
  });

  it('rejects a runtime address outside the server macvlan CIDR', async () => {
    const { gateway, runtimeDriftReconciler } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a');
    const container = makeContainer('runtime-foreign-network');
    container.runtime.ip = '192.168.10.2';

    await gateway.handleMessage(
      session,
      server,
      wsMessage('stateReport', makeReport({ containers: [container], remoteFsMounts: [] })),
    );

    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
    expect(runtimeDriftReconciler.reconcile).not.toHaveBeenCalled();
  });

  it('retires the session when authoritative runtime reconciliation cannot commit', async () => {
    const {
      gateway,
      runtimeDriftReconciler,
      serversRepo,
      proxySnapshots,
    } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a');
    runtimeDriftReconciler.reconcile.mockRejectedValueOnce(new Error('database unavailable'));

    await gateway.handleMessage(
      session,
      server,
      wsMessage('stateReport', makeReport({ remoteFsMounts: [] })),
    );

    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
    expect(gateway.stateCache.get('server-a')).toBeUndefined();
    expect(gateway.dispatchReadyServerIds()).toEqual([]);
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
    }));
    expect(proxySnapshots.blockServer).not.toHaveBeenCalledWith(
      'server-a',
      'authoritative Agent inventory failed on server-a',
    );
  });

  it('quarantines before promotion when the atomic data-directory inventory cannot reconcile', async () => {
    const { gateway, dataDirReconciler, serversRepo } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a');
    dataDirReconciler.reconcileReport.mockResolvedValueOnce({
      issues: { orphans: [{ kind: 'orphan' }], missing: [] },
      blockingReason: 'Authoritative data directory inventory has 1 orphan and 0 missing/failed entries',
    });

    await gateway.handleMessage(
      session,
      server,
      wsMessage('stateReport', makeReport({
        dataDirs: [{
          sourceKind: 'local',
          sourceId: 'disk-a',
          resourceId: 'data-dir-orphan',
          hostPath: '/data-a/.nyabase/dirs/data-dir-orphan/data',
        }],
        remoteFsMounts: [],
      })),
    );

    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
      quarantineCode: 'AGENT_INVENTORY_FAULT',
      quarantineMessage: expect.stringContaining('data directory inventory'),
    }));
    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
    expect(gateway.stateCache.get('server-a')).toBeUndefined();
  });

  it('drops an expired queued report without quarantine and accepts the next fresh report', async () => {
    const { gateway, runtimeDriftReconciler, serversRepo } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a');

    await gateway.handleMessage(
      session,
      server,
      wsMessage('stateReport', makeReport({ remoteFsMounts: [] })),
      { wallMs: 1, monotonicMs: -1_000_000_000 },
    );

    expect(runtimeDriftReconciler.reconcile).not.toHaveBeenCalled();
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
    }));
    expect(session.ws.terminate).not.toHaveBeenCalled();

    await gateway.handleMessage(
      session,
      server,
      wsMessage('stateReport', makeReport({ remoteFsMounts: [] })),
    );
    expect(runtimeDriftReconciler.reconcile).toHaveBeenCalledOnce();
    expect(session.ws.terminate).not.toHaveBeenCalled();
  });

  it('accepts duplicate product claimants so the durable reconciler can clean the extra runtime', async () => {
    const { gateway, runtimeDriftReconciler } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a');
    const canonical = makeContainer('docker-a');
    const extra = makeContainer('docker-extra');
    extra.labels = { ...extra.labels, [LABEL.CONTAINER_ID]: 'container-a' };
    const report = makeReport({ containers: [extra, canonical], remoteFsMounts: [] });

    await gateway.handleMessage(session, server, wsMessage('stateReport', report));

    expect(session.ws.terminate).not.toHaveBeenCalled();
    expect(runtimeDriftReconciler.reconcile).toHaveBeenCalledWith(
      'server-a',
      [extra, canonical],
      expect.any(String),
    );
  });

  it('rejects metrics batches whose serverId does not match the authenticated session', async () => {
    const { gateway, metricsWriter } = makeGateway();
    const warn = vi.fn();
    (gateway as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;

    await gateway.handleMessage(activeSession(gateway, 'server-a'), server, wsMessage('metricsBatch', {
      serverId: 'server-b',
      points: [
        { name: 'nyabase_test_metric', labels: { server: 'server-b' }, value: 1, ts: 1_780_000_000_000 },
      ],
    }));

    expect(metricsWriter.writeBatch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('metricsBatch serverId mismatch: payload=server-b connection=server-a, ignoring');
  });

  it('writes metrics batches whose serverId matches the authenticated session', async () => {
    const { gateway, metricsWriter } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const points = [
      { name: 'nyabase_test_metric', labels: { server: 'server-a' }, value: 1, ts: 1_780_000_000_000 },
    ];

    await gateway.handleMessage(activeSession(gateway, 'server-a'), server, wsMessage('metricsBatch', {
      serverId: 'server-a',
      points,
    }));

    expect(metricsWriter.writeBatch).toHaveBeenCalledWith('server-a', points);
  });

  it('drops malformed lossy metrics without quarantining the authoritative Agent', async () => {
    const { gateway, metricsWriter, taskResults } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;

    await gateway.handleMessage(session, server, wsMessage('metricsBatch', {
      serverId: 'server-a',
      points: [{ name: 'forged\nmetric', labels: {}, value: 1, ts: 1 }],
    }));

    expect(metricsWriter.writeBatch).not.toHaveBeenCalled();
    expect(taskResults.quarantineProtocolFault).not.toHaveBeenCalled();
    expect(session.ws.terminate).not.toHaveBeenCalled();
  });

  it('keeps the Agent session when the lossy metrics sink is unavailable', async () => {
    const { gateway, metricsWriter, taskResults } = makeGateway();
    metricsWriter.writeBatch.mockRejectedValue(new Error('metrics database unavailable'));
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;

    await gateway.handleMessage(session, server, wsMessage('metricsBatch', {
      serverId: 'server-a',
      points: [{ name: 'safe_metric', labels: {}, value: 1, ts: 1 }],
    }));

    expect(metricsWriter.writeBatch).toHaveBeenCalledOnce();
    expect(taskResults.quarantineProtocolFault).not.toHaveBeenCalled();
    expect(session.ws.terminate).not.toHaveBeenCalled();
  });

  it('commits a durable task result through the authenticated session', async () => {
    const { gateway, taskResults, taskDispatcher } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;
    await expect(gateway.handleMessage(session, server, wsMessage('task.result.v1', {
      taskId: 'task-a',
      payloadHash: TASK_HASH,
      status: 'succeeded',
      result: { runtimeId: 'runtime-a' },
    }))).resolves.toBeUndefined();
    expect(taskResults.handle).toHaveBeenCalledWith('server-a', expect.objectContaining({
      taskId: 'task-a',
      status: 'succeeded',
    }));
    expect(session.send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'task.accepted.v1',
      payload: { taskId: 'task-a', payloadHash: TASK_HASH },
    }));
    expect(taskDispatcher.wake).toHaveBeenCalledTimes(1);
  });

  it('keeps a route-blocked recovery session after a safe task result', async () => {
    const { gateway, taskResults, proxySnapshots, serversRepo } = makeGateway();
    proxySnapshots.isServerBlocked.mockReturnValue(true);
    serversRepo.findOneBy.mockResolvedValue({
      id: 'server-a',
      status: ServerStatus.Online,
    });
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;

    await gateway.handleMessage(session, server, wsMessage('task.result.v1', {
      taskId: 'task-a',
      payloadHash: TASK_HASH,
      status: 'succeeded',
      result: { runtimeId: 'runtime-a' },
    }));

    expect(taskResults.handle).toHaveBeenCalledOnce();
    expect(session.send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'task.accepted.v1',
    }));
    expect(session.ws.terminate).not.toHaveBeenCalled();
  });

  it('does not acknowledge a nonterminal incomplete task result', async () => {
    const { gateway, taskResults, taskDispatcher } = makeGateway();
    taskResults.handle.mockResolvedValue(null);
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;

    await gateway.handleMessage(session, server, wsMessage('task.result.v1', {
      taskId: 'task-a',
      payloadHash: TASK_HASH,
      status: 'incomplete',
      error: { code: 'INTERRUPTED', message: 'retry the immutable task' },
    }));

    expect(taskResults.handle).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: 'incomplete',
    }));
    expect(session.send).not.toHaveBeenCalled();
    expect(taskDispatcher.wake).toHaveBeenCalledTimes(1);
  });

  it('durably quarantines a malformed task result before retiring the connection', async () => {
    const { gateway, taskResults } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;
    const malformed = {
      taskId: 'task-a',
      payloadHash: TASK_HASH,
      status: 'failed',
      error: { code: 'unsafe', message: 'missing observed evidence' },
    };

    await gateway.handleMessage(
      session,
      server,
      wsMessage('task.result.v1', malformed),
    );

    expect(taskResults.quarantineMalformedResult).toHaveBeenCalledWith(
      'server-a',
      malformed,
      expect.anything(),
    );
    expect(taskResults.handle).not.toHaveBeenCalled();
    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
  });

  it('durably quarantines an invalid outer envelope before retiring the connection', async () => {
    const { gateway, taskResults } = makeGateway();
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;

    await gateway.handleMessage(
      session,
      server,
      JSON.stringify({
        kind: 'task.result.v1',
        payload: { taskId: 'task-a', payloadHash: TASK_HASH, status: 'succeeded', result: null },
      }),
    );

    expect(taskResults.quarantineProtocolFault).toHaveBeenCalledWith(
      'server-a',
      expect.anything(),
    );
    expect(taskResults.handle).not.toHaveBeenCalled();
    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    'AUTHORITATIVE_INVENTORY_FAILED',
    'AUTHORITATIVE_INVENTORY_TOO_LARGE',
  ] as const)('durably records %s before retiring the session', async (code) => {
    const { gateway, serversRepo, proxySnapshots } = makeGateway();
    const durable = {
      id: 'server-a',
      status: ServerStatus.Unknown,
      quarantineCode: null as string | null,
      quarantineMessage: null as string | null,
    };
    serversRepo.findOneBy.mockImplementation(async () => durable);
    serversRepo.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(durable, patch);
    });
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;

    await gateway.handleMessage(session, server, wsMessage('inventoryFault', {
      serverId: 'server-a',
      code,
      message: 'foreign immutable runtime labels',
      observedAt: Date.now(),
    }));

    expect(durable).toMatchObject({
      status: ServerStatus.AgentQuarantined,
      quarantineCode: 'AGENT_INVENTORY_FAULT',
      quarantineMessage: 'foreign immutable runtime labels',
    });
    expect(proxySnapshots.blockServer).toHaveBeenCalledWith(
      'server-a',
      'authoritative Agent inventory failed on server-a',
    );
    expect(session.ws.terminate).toHaveBeenCalledTimes(1);

    await (gateway as unknown as {
      quarantineIncompleteInitialization(
        value: typeof session,
        serverId: string,
        reason: string,
        closeCode?: number,
      ): Promise<void>;
    }).quarantineIncompleteInitialization(
      session,
      'server-a',
      'inventory fault close fallback',
      4502,
    );
    expect(durable.quarantineMessage).toBe('foreign immutable runtime labels');
  });

  it('retires the connection when terminal evidence is rejected so Agent re-executes', async () => {
    const { gateway, taskResults } = makeGateway();
    taskResults.handle.mockRejectedValue(new Error('invalid terminal safety evidence'));
    const server = { id: 'server-a', name: 'server-a' } as ServerEntity;
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;

    await gateway.handleMessage(session, server, wsMessage('task.result.v1', {
      taskId: 'task-a',
      payloadHash: TASK_HASH,
      status: 'failed',
      error: { code: 'unsafe', message: 'unsafe terminal evidence' },
      observed: { exists: false },
    }));

    expect(session.send).not.toHaveBeenCalled();
    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('AgentGateway authenticated bootstrap readiness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hydrates active RemoteFS desired state before making a session dispatch-ready', async () => {
    const {
      gateway,
      taskDispatcher,
      remoteFsAssignmentsRepo,
      remoteFsMountsRepo,
      agentTasksRepo,
      serversRepo,
      taskPayloadCodec,
    } = makeGateway();
    remoteFsAssignmentsRepo.find.mockResolvedValue([{
      remoteFsMountId: 'remote-a',
      serverId: 'server-a',
      desiredState: 'active',
      lastTaskId: 'task-remote-a',
    }]);
    agentTasksRepo.find.mockResolvedValue([{
      id: 'task-remote-a',
      kind: 'remote_fs.ensure',
      status: 'succeeded',
      serverId: 'server-a',
      resourceType: 'remote_fs_mount',
      resourceId: 'remote-a',
    }]);
    remoteFsMountsRepo.find.mockResolvedValue([{
      id: 'remote-a',
      hostMountPoint: '/mnt/remote-fs/remote-a',
      options: 'ro',
      params: { type: 'nfs', nfsServer: 'nfs.internal', exportPath: '/export', version: '4.2' },
    }]);
    taskPayloadCodec.forRemoteFsBootstrap.mockReturnValue([{
      id: 'remote-a',
      hostMountPoint: '/mnt/remote-fs/remote-a',
      options: 'ro',
      params: { type: 'nfs', nfsServer: 'nfs.internal', exportPath: '/export', version: '4.2' },
    }]);
    const session = makeSession();
    session.rpc.mockResolvedValue({
      remoteFsMounts: [{
        id: 'remote-a',
        hostMountPoint: '/mnt/remote-fs/remote-a',
        status: 'mounted',
        lastCheckedAt: 1,
      }],
    });
    (gateway as unknown as { sessions: Map<string, unknown> }).sessions.set('server-a', session);

    await gateway.onHello(
      { id: 'server-a', name: 'server-a', hostFingerprint: HOST_FINGERPRINT, agentConfigFingerprint: CONFIG_FINGERPRINT } as ServerEntity,
      helloPayload(),
      session,
    );

    expect(session.rpc).toHaveBeenCalledWith('agent.bootstrap.v1', {
      remoteFsMounts: [{
        id: 'remote-a',
        hostMountPoint: '/mnt/remote-fs/remote-a',
        options: 'ro',
        params: { type: 'nfs', nfsServer: 'nfs.internal', exportPath: '/export', version: '4.2' },
      }],
    }, AGENT_BOOTSTRAP_RPC_TIMEOUT_MS);
    expect(session.markDispatchReady).not.toHaveBeenCalled();
    expect(taskDispatcher.wake).not.toHaveBeenCalled();
    expect(gateway.dispatchReadyServerIds()).toEqual([]);
    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentStateUnready,
    }));
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.Online,
    }));

    await gateway.onStateReport(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      makeReport(),
    );

    expect(session.markDispatchReady).toHaveBeenCalledTimes(1);
    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.Online,
    }));
    expect(taskDispatcher.wake).toHaveBeenCalledTimes(1);
    expect(gateway.dispatchReadyServerIds()).toEqual(['server-a']);
    expect(gateway.stateCache.getRemoteFsMountStatus('server-a', 'remote-a')).toEqual(
      expect.objectContaining({ id: 'remote-a', status: 'mounted' }),
    );
  });

  it('dispatches quarantined recovery work before a later full report unblocks routes', async () => {
    const {
      gateway,
      agentTasksRepo,
      taskDispatcher,
      proxySnapshots,
    } = makeGateway();
    proxySnapshots.isServerBlocked.mockReturnValue(true);
    agentTasksRepo.existsBy
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;
    session.bootstrapReady = true;

    await gateway.onStateReport(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      makeReport(),
      session,
    );

    expect(proxySnapshots.unblockServerIfEpoch).not.toHaveBeenCalled();
    expect(session.markDispatchReady).toHaveBeenCalledTimes(1);
    expect(taskDispatcher.wake).toHaveBeenCalledTimes(1);
    expect(gateway.dispatchReadyServerIds()).toEqual(['server-a']);

    gateway.sendTask('server-a', {
      taskId: 'task-recovery',
      kind: AgentTaskKind.ImageEnsurePresent,
      payloadHash: TASK_HASH,
      payload: { dockerRef: 'example.invalid/recovery:latest' },
    });
    expect(session.send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'task.execute.v1',
      payload: expect.objectContaining({ taskId: 'task-recovery' }),
    }));

    await gateway.onStateReport(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      makeReport({ sequence: 2 }),
      session,
    );

    expect(proxySnapshots.unblockServerIfEpoch).toHaveBeenCalledTimes(1);
    expect(proxySnapshots.unblockServerIfEpoch).toHaveBeenCalledWith(
      'server-a',
      1,
      'authoritative agent state report',
    );
  });

  it('establishes a route-only block when a full report discovers safety work', async () => {
    const { gateway, agentTasksRepo, proxySnapshots } = makeGateway();
    agentTasksRepo.existsBy.mockResolvedValue(true);
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;
    session.bootstrapReady = true;

    await gateway.onStateReport(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      makeReport(),
      session,
    );

    expect(proxySnapshots.blockServerRoutes).toHaveBeenCalledWith(
      'server-a',
      'Agent safety recovery is pending',
    );
    expect(proxySnapshots.blockServer).not.toHaveBeenCalled();
    expect(session.ws.terminate).not.toHaveBeenCalled();
  });

  it('durably quarantines a failed bootstrap instead of reconnecting forever', async () => {
    const { gateway, taskDispatcher, serversRepo, proxySnapshots } = makeGateway();
    const durable = {
      id: 'server-a',
      hostFingerprint: HOST_FINGERPRINT,
      agentConfigFingerprint: CONFIG_FINGERPRINT,
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanReservedIps: [],
      status: ServerStatus.Unknown,
      quarantineCode: null as string | null,
      quarantineMessage: null as string | null,
    };
    serversRepo.findOneBy.mockImplementation(async () => durable);
    serversRepo.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(durable, patch);
    });
    const server = {
      id: 'server-a',
      name: 'server-a',
      hostFingerprint: HOST_FINGERPRINT,
      agentConfigFingerprint: CONFIG_FINGERPRINT,
    } as ServerEntity;
    const failed = makeSession();
    failed.rpc.mockRejectedValue(new Error('mount verification failed'));
    const maps = gateway as unknown as {
      sessions: Map<string, unknown>;
    };
    maps.sessions.set('server-a', failed);

    await gateway.onHello(server, helloPayload(), failed);

    expect(failed.markDispatchReady).not.toHaveBeenCalled();
    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentStateUnready,
    }));
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.Online,
    }));
    expect(failed.ws.terminate).toHaveBeenCalledTimes(1);
    expect(durable).toMatchObject({
      status: ServerStatus.AgentQuarantined,
      quarantineCode: 'AGENT_INVENTORY_FAULT',
      quarantineMessage: 'Agent bootstrap failed: mount verification failed',
    });
    expect(proxySnapshots.blockServer).toHaveBeenCalledWith(
      'server-a',
      'authoritative Agent inventory failed on server-a',
    );
    expect(taskDispatcher.wake).not.toHaveBeenCalled();
    expect(gateway.dispatchReadyServerIds()).toEqual([]);

    const reconnect = makeSession();
    maps.sessions.delete('server-a');
    maps.sessions.set('server-a', reconnect);
    await gateway.onHello(
      { ...server } as ServerEntity,
      helloPayload(),
      reconnect,
    );

    expect(reconnect.ws.terminate).toHaveBeenCalledTimes(1);
    expect(reconnect.rpc).not.toHaveBeenCalled();
    expect(reconnect.markDispatchReady).not.toHaveBeenCalled();
    expect(gateway.dispatchReadyServerIds()).toEqual([]);
    expect(taskDispatcher.wake).not.toHaveBeenCalled();
  });

  it('retires bootstrap transport loss without inventing inventory quarantine and reconnects', async () => {
    const { gateway, serversRepo, proxySnapshots } = makeGateway();
    const durable = {
      id: 'server-a',
      hostFingerprint: HOST_FINGERPRINT,
      agentConfigFingerprint: CONFIG_FINGERPRINT,
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanReservedIps: [],
      status: ServerStatus.Unknown,
      quarantineCode: null as string | null,
      quarantineMessage: null as string | null,
    };
    serversRepo.findOneBy.mockImplementation(async () => durable);
    serversRepo.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(durable, patch);
    });
    const server = {
      id: 'server-a',
      name: 'server-a',
      hostFingerprint: HOST_FINGERPRINT,
      agentConfigFingerprint: CONFIG_FINGERPRINT,
    } as ServerEntity;
    const disconnected = makeSession();
    disconnected.rpc.mockImplementation(async () => {
      disconnected.ws.readyState = WebSocket.CLOSED;
      throw new AgentRpcTransportError('Agent disconnected');
    });
    const maps = gateway as unknown as { sessions: Map<string, unknown> };
    maps.sessions.set('server-a', disconnected);

    await gateway.onHello(server, helloPayload(), disconnected);

    expect(durable.status).not.toBe(ServerStatus.AgentQuarantined);
    expect(durable.quarantineCode).toBeNull();
    expect(proxySnapshots.blockServer).not.toHaveBeenCalledWith(
      'server-a',
      'authoritative Agent inventory failed on server-a',
    );

    const reconnect = makeSession();
    maps.sessions.set('server-a', reconnect);
    await gateway.onHello(server, helloPayload(), reconnect);
    expect(reconnect.rpc).toHaveBeenCalledWith(
      'agent.bootstrap.v1',
      { remoteFsMounts: [] },
      AGENT_BOOTSTRAP_RPC_TIMEOUT_MS,
    );
    expect(reconnect.markBootstrapReady).toHaveBeenCalledOnce();
    expect(reconnect.ws.terminate).not.toHaveBeenCalled();
  });

  it('durably quarantines an open-socket bootstrap timeout as a bounded initialization failure', async () => {
    const { gateway, serversRepo } = makeGateway();
    const durable = {
      id: 'server-a',
      hostFingerprint: HOST_FINGERPRINT,
      agentConfigFingerprint: CONFIG_FINGERPRINT,
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanReservedIps: [],
      status: ServerStatus.Unknown,
      quarantineCode: null as string | null,
      quarantineMessage: null as string | null,
    };
    serversRepo.findOneBy.mockImplementation(async () => durable);
    serversRepo.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(durable, patch);
    });
    const session = makeSession();
    session.rpc.mockRejectedValue(new Error('Agent RPC timeout: agent.bootstrap.v1'));
    (gateway as unknown as { sessions: Map<string, unknown> }).sessions.set('server-a', session);

    await gateway.onHello(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      helloPayload(),
      session,
    );

    expect(durable).toMatchObject({
      status: ServerStatus.AgentQuarantined,
      quarantineCode: 'AGENT_INVENTORY_FAULT',
      quarantineMessage: 'Agent bootstrap failed: Agent RPC timeout: agent.bootstrap.v1',
    });
    expect(session.ws.terminate).toHaveBeenCalledOnce();
  });

  it('accepts an error observation and opens the gate for durable recovery tasks', async () => {
    const {
      gateway,
      taskDispatcher,
      remoteFsAssignmentsRepo,
      remoteFsMountsRepo,
      agentTasksRepo,
      taskPayloadCodec,
      transactionManager,
      agentTasks,
    } = makeGateway();
    remoteFsAssignmentsRepo.find.mockResolvedValue([{
      remoteFsMountId: 'remote-a',
      serverId: 'server-a',
      desiredState: 'active',
      lastTaskId: 'task-remote-a',
    }]);
    agentTasksRepo.find.mockResolvedValue([{
      id: 'task-remote-a',
      kind: 'remote_fs.ensure',
      status: 'succeeded',
      serverId: 'server-a',
      resourceType: 'remote_fs_mount',
      resourceId: 'remote-a',
    }]);
    remoteFsMountsRepo.find.mockResolvedValue([{
      id: 'remote-a',
      hostMountPoint: '/mnt/remote-fs/remote-a',
      options: '',
      params: { type: 'nfs', nfsServer: 'nfs.internal', exportPath: '/data', version: '4.2' },
    }]);
    taskPayloadCodec.forRemoteFsBootstrap.mockReturnValue([{
      id: 'remote-a',
      hostMountPoint: '/mnt/remote-fs/remote-a',
      options: '',
      params: { type: 'nfs', nfsServer: 'nfs.internal', exportPath: '/data', version: '4.2' },
    }]);
    transactionManager.findOne.mockImplementation(async (entity: { name?: string }) => {
      if (entity.name === 'RemoteFsServerAssignmentEntity') {
        return {
          id: 'assignment-a',
          remoteFsMountId: 'remote-a',
          serverId: 'server-a',
          desiredState: 'active',
          generation: 1,
        };
      }
      if (entity.name === 'RemoteFsMountEntity') {
        return {
          id: 'remote-a',
          name: 'remote-a',
          displayName: null,
          description: null,
          type: 'nfs',
          hostMountPoint: '/mnt/remote-fs/remote-a',
          options: '',
          params: { type: 'nfs', nfsServer: 'nfs.internal', exportPath: '/data', version: '4.2' },
          desiredState: 'active',
          generation: 1,
        };
      }
      return null;
    });
    const session = makeSession();
    session.rpc.mockResolvedValue({
      remoteFsMounts: [{
        id: 'remote-a',
        hostMountPoint: '/mnt/remote-fs/remote-a',
        status: 'error',
        error: 'wrong source mounted',
        lastCheckedAt: 1,
      }],
    });
    (gateway as unknown as { sessions: Map<string, unknown> }).sessions.set('server-a', session);

    await gateway.onHello(
      { id: 'server-a', name: 'server-a', hostFingerprint: HOST_FINGERPRINT, agentConfigFingerprint: CONFIG_FINGERPRINT } as ServerEntity,
      helloPayload(),
      session,
    );

    expect(session.markBootstrapReady).toHaveBeenCalledTimes(1);
    expect(session.markDispatchReady).not.toHaveBeenCalled();
    expect(taskDispatcher.wake).not.toHaveBeenCalled();
    expect(session.ws.close).not.toHaveBeenCalled();
    expect(gateway.dispatchReadyServerIds()).toEqual([]);

    await gateway.onStateReport(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      makeReport({
        remoteFsMounts: [{
          id: 'remote-a',
          hostMountPoint: '/mnt/remote-fs/remote-a',
          status: 'error',
          error: 'wrong source mounted',
          lastCheckedAt: 2,
        }],
      }),
    );
    expect(session.markDispatchReady).toHaveBeenCalledTimes(1);
    expect(taskDispatcher.wake).toHaveBeenCalledTimes(1);
    expect(agentTasks.enqueueInTransaction).toHaveBeenCalledWith(
      transactionManager,
      expect.objectContaining({
        kind: AgentTaskKind.RemoteFsEnsure,
        resourceId: 'remote-a',
        request: expect.objectContaining({ reason: 'state_report_recovery' }),
      }),
    );
  });

  it('durably stops running consumers before repairing a lost RemoteFS mount', async () => {
    const {
      gateway,
      remoteFsAssignmentsRepo,
      remoteFsMountsRepo,
      agentTasksRepo,
      containerMountsRepo,
      transactionManager,
      agentTasks,
    } = makeGateway();
    remoteFsAssignmentsRepo.find.mockResolvedValue([{
      remoteFsMountId: 'remote-a',
      serverId: 'server-a',
      desiredState: 'active',
      lastTaskId: 'task-remote-a',
    }]);
    agentTasksRepo.find.mockResolvedValue([{
      id: 'task-remote-a',
      kind: AgentTaskKind.RemoteFsEnsure,
      status: 'succeeded',
      serverId: 'server-a',
      resourceType: 'remote_fs_mount',
      resourceId: 'remote-a',
    }]);
    remoteFsMountsRepo.find.mockResolvedValue([{
      id: 'remote-a',
      name: 'remote-a',
      displayName: null,
      description: null,
      type: 'nfs',
      hostMountPoint: '/mnt/remote-fs/remote-a',
      options: '',
      params: { type: 'nfs', nfsServer: 'nfs.internal', exportPath: '/data', version: '4.2' },
      desiredState: 'active',
      generation: 1,
    }]);
    const ref = {
      serverId: 'server-a',
      containerId: 'container-a',
      sourceKind: 'remote',
      sourceId: 'remote-a',
    };
    containerMountsRepo.find.mockResolvedValue([ref]);
    transactionManager.findOneBy.mockImplementation(async (entity: unknown) => {
      const typed = entity as { name?: string };
      if (typed.name === 'ContainerEntity') {
        return { id: 'container-a', serverId: 'server-a' };
      }
      return null;
    });
    transactionManager.findOne.mockImplementation(async (entity: { name?: string }) => {
      if (entity.name === 'ContainerLifecycleEntity') {
        return {
          containerId: 'container-a',
          boundRuntimeId: 'docker-a',
          runtimeSpecHash: RUNTIME_SPEC_HASH,
          phase: ContainerPhase.Active,
        };
      }
      if (entity.name === 'RemoteFsServerAssignmentEntity') {
        return {
          id: 'assignment-a',
          remoteFsMountId: 'remote-a',
          serverId: 'server-a',
          desiredState: 'active',
          generation: 1,
        };
      }
      if (entity.name === 'RemoteFsMountEntity') {
        return {
          id: 'remote-a',
          name: 'remote-a',
          displayName: null,
          description: null,
          type: 'nfs',
          hostMountPoint: '/mnt/remote-fs/remote-a',
          options: '',
          params: { type: 'nfs', nfsServer: 'nfs.internal', exportPath: '/data', version: '4.2' },
          desiredState: 'active',
          generation: 1,
        };
      }
      return null;
    });
    transactionManager.find.mockImplementation(async (entity: unknown) => {
      const typed = entity as { name?: string };
      if (typed.name === 'ContainerMountEntity') return [ref];
      if (typed.name === 'RemoteFsServerAssignmentEntity') {
        return remoteFsAssignmentsRepo.find();
      }
      if (typed.name === 'RemoteFsMountEntity') return remoteFsMountsRepo.find();
      if (typed.name === 'AgentTaskEntity') return agentTasksRepo.find();
      return [];
    });
    agentTasks.enqueueInTransaction
      .mockResolvedValueOnce({ taskId: 'task-safety-stop' })
      .mockResolvedValueOnce({ taskId: 'task-mount-repair' });
    const session = makeSession();
    session.bootstrapReady = true;
    (gateway as unknown as { sessions: Map<string, unknown> }).sessions.set('server-a', session);
    const remoteError: RemoteFsMountStatus = {
      id: 'remote-a',
      hostMountPoint: '/mnt/remote-fs/remote-a',
      status: 'error',
      error: 'mount missing after reboot',
      lastCheckedAt: 1,
    };

    await gateway.onStateReport(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      makeReport({ remoteFsMounts: [remoteError] }),
    );

    expect(agentTasks.enqueueInTransaction).toHaveBeenCalledTimes(1);
    expect(agentTasks.enqueueInTransaction).toHaveBeenLastCalledWith(
      transactionManager,
      expect.objectContaining({
        kind: AgentTaskKind.ContainerStop,
        resourceId: 'container-a',
        payload: expect.objectContaining({ runtimeId: 'docker-a' }),
      }),
    );

    containerMountsRepo.find.mockResolvedValue([]);
    await gateway.onStateReport(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      makeReport({
        sequence: 2,
        containers: [{ ...makeContainer('docker-a'), status: ContainerStatus.Exited }],
        remoteFsMounts: [remoteError],
      }),
    );

    expect(agentTasks.enqueueInTransaction).toHaveBeenCalledTimes(2);
    expect(agentTasks.enqueueInTransaction).toHaveBeenLastCalledWith(
      transactionManager,
      expect.objectContaining({
        kind: AgentTaskKind.RemoteFsEnsure,
        resourceId: 'remote-a',
      }),
    );
  });

  it('closes when an active assignment has no corresponding active mount row', async () => {
    const {
      gateway,
      taskDispatcher,
      remoteFsAssignmentsRepo,
      remoteFsMountsRepo,
      agentTasksRepo,
      serversRepo,
    } = makeGateway();
    remoteFsAssignmentsRepo.find.mockResolvedValue([{
      remoteFsMountId: 'remote-missing',
      serverId: 'server-a',
      desiredState: 'active',
      lastTaskId: 'task-remote-missing',
    }]);
    agentTasksRepo.find.mockResolvedValue([{
      id: 'task-remote-missing',
      kind: 'remote_fs.ensure',
      status: 'succeeded',
      serverId: 'server-a',
      resourceType: 'remote_fs_mount',
      resourceId: 'remote-missing',
    }]);
    remoteFsMountsRepo.find.mockResolvedValue([]);
    const session = makeSession();
    (gateway as unknown as { sessions: Map<string, unknown> }).sessions.set('server-a', session);

    await gateway.onHello(
      { id: 'server-a', name: 'server-a', hostFingerprint: HOST_FINGERPRINT, agentConfigFingerprint: CONFIG_FINGERPRINT } as ServerEntity,
      helloPayload(),
      session,
    );

    expect(session.rpc).not.toHaveBeenCalled();
    expect(session.markDispatchReady).not.toHaveBeenCalled();
    expect(taskDispatcher.wake).not.toHaveBeenCalled();
    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
      quarantineMessage: expect.stringContaining(
        'Backend bootstrap state invalid: RemoteFS bootstrap has an active assignment without one active mount',
      ),
    }));
  });

  it('retries after a Backend bootstrap repository failure without blaming Agent inventory', async () => {
    const {
      gateway,
      remoteFsAssignmentsRepo,
      serversRepo,
      proxySnapshots,
    } = makeGateway();
    remoteFsAssignmentsRepo.find.mockRejectedValueOnce(
      new Error('bootstrap database temporarily unavailable'),
    );
    const session = makeSession();
    (gateway as unknown as { sessions: Map<string, unknown> }).sessions.set('server-a', session);

    await gateway.onHello(
      { id: 'server-a', name: 'server-a' } as ServerEntity,
      helloPayload(),
      session,
    );

    expect(session.rpc).not.toHaveBeenCalled();
    expect(session.ws.terminate).toHaveBeenCalledOnce();
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
    }));
    expect(proxySnapshots.blockServer).not.toHaveBeenCalledWith(
      'server-a',
      'authoritative Agent inventory failed on server-a',
    );
  });

  it.each([
    {
      label: 'a missing desired id',
      expected: [remoteSpec('remote-a')],
      result: { remoteFsMounts: [] },
    },
    {
      label: 'a duplicate result id',
      expected: [remoteSpec('remote-a'), remoteSpec('remote-b')],
      result: {
        remoteFsMounts: [mountedStatus('remote-a'), mountedStatus('remote-a')],
      },
    },
    {
      label: 'an unexpected result id',
      expected: [remoteSpec('remote-a')],
      result: { remoteFsMounts: [mountedStatus('remote-b')] },
    },
    {
      label: 'a host path mismatch',
      expected: [remoteSpec('remote-a')],
      result: {
        remoteFsMounts: [{ ...mountedStatus('remote-a'), hostMountPoint: '/mnt/wrong' }],
      },
    },
  ])('rejects bootstrap result with $label', ({ expected, result }) => {
    const { gateway } = makeGateway();
    expect(() => gateway.assertBootstrapReady(expected, result as AgentBootstrapResult)).toThrow();
  });

  it('blocks public rpc and notify until bootstrap readiness is explicit', async () => {
    const { gateway } = makeGateway();
    const session = makeSession();
    (gateway as unknown as { sessions: Map<string, unknown> }).sessions.set('server-a', session);

    await expect(gateway.rpc('server-a', 'selfCheck', {}))
      .rejects.toThrow('Agent offline, initializing, or quarantined');
    gateway.notify('server-a', 'reconcile', { serverId: 'server-a' });
    expect(session.rpc).not.toHaveBeenCalled();
    expect(session.send).not.toHaveBeenCalled();
    expect(() => (gateway.notify as unknown as (
      serverId: string,
      kind: string,
      payload: unknown,
    ) => void)('server-a', 'selfCheck', {})).toThrow('is not allowed');

    session.markDispatchReady();
    session.rpc.mockResolvedValue({ running: true });
    await expect(gateway.rpc('server-a', 'selfCheck', {}))
      .resolves.toEqual({ running: true });
    gateway.notify('server-a', 'reconcile', { serverId: 'server-a' });
    expect(session.rpc).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reconcile' }));
  });

  it('does not let a conflicting host fingerprint replace the active session', async () => {
    const { gateway, taskDispatcher } = makeGateway();
    const active = makeSession();
    active.dispatchReady = true;
    const conflicting = makeSession();
    const maps = gateway as unknown as {
      sessions: Map<string, unknown>;
    };
    maps.sessions.set('server-a', active);

    await gateway.onHello(
      { id: 'server-a', name: 'server-a', hostFingerprint: HOST_FINGERPRINT, agentConfigFingerprint: CONFIG_FINGERPRINT } as ServerEntity,
      helloPayload('b'.repeat(64)),
      conflicting,
    );

    expect(conflicting.ws.terminate).toHaveBeenCalledTimes(1);
    expect(conflicting.rpc).not.toHaveBeenCalled();
    expect(active.ws.close).not.toHaveBeenCalled();
    expect(maps.sessions.get('server-a')).toBe(active);
    expect(taskDispatcher.wake).not.toHaveBeenCalled();
  });

  it('rejects a static configuration change for a bound server', async () => {
    const { gateway, serversRepo, proxySnapshots } = makeGateway();
    const session = makeSession();

    const accepted = await gateway.bindHostFingerprint(
      {
        id: 'server-a',
        hostFingerprint: HOST_FINGERPRINT,
        agentConfigFingerprint: CONFIG_FINGERPRINT,
      } as ServerEntity,
      helloPayload(HOST_FINGERPRINT, 'e'.repeat(64)),
      session,
    );

    expect(accepted).toBe(false);
    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
      quarantineCode: 'AGENT_INVENTORY_FAULT',
      quarantineMessage: 'Agent static configuration identity mismatch',
    }));
    expect(proxySnapshots.blockServer).toHaveBeenCalledWith(
      'server-a',
      'authoritative Agent inventory failed on server-a',
    );
  });

  it.each([
    ['server id', { serverId: 'server-b' }, 'Agent server identity mismatch'],
    ['network identity', { macvlanCidr: '10.0.0.1/24' }, 'Agent network identity is invalid'],
  ])('durably quarantines a deterministic %s fault', async (_label, override, message) => {
    const { gateway, serversRepo } = makeGateway();
    const session = makeSession();

    const accepted = await gateway.bindHostFingerprint(
      {
        id: 'server-a',
        hostFingerprint: HOST_FINGERPRINT,
        agentConfigFingerprint: CONFIG_FINGERPRINT,
      } as ServerEntity,
      { ...helloPayload(), ...override },
      session,
    );

    expect(accepted).toBe(false);
    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
      quarantineCode: 'AGENT_INVENTORY_FAULT',
      quarantineMessage: message,
    }));
    expect(session.ws.terminate).toHaveBeenCalledOnce();
  });

  it('retires a database binding failure without misclassifying it as Agent identity evidence', async () => {
    const { gateway, serversRepo, proxySnapshots } = makeGateway();
    const session = makeSession();
    serversRepo.findOneBy.mockRejectedValueOnce(new Error('database temporarily unavailable'));

    const accepted = await gateway.bindHostFingerprint(
      { id: 'server-a' } as ServerEntity,
      helloPayload(),
      session,
    );

    expect(accepted).toBe(false);
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
    }));
    expect(proxySnapshots.blockServer).not.toHaveBeenCalledWith(
      'server-a',
      'authoritative Agent inventory failed on server-a',
    );
    expect(session.ws.terminate).toHaveBeenCalledOnce();
  });

  it('retires global network-ledger pressure without quarantining valid Agent identity', async () => {
    const {
      gateway,
      serversRepo,
      proxySnapshots,
      transactionManager,
    } = makeGateway();
    const session = makeSession();
    transactionManager.count.mockResolvedValue(MAX_NETWORK_ADDRESS_CLAIMS_GLOBAL);

    const accepted = await gateway.bindHostFingerprint(
      { id: 'server-a' } as ServerEntity,
      helloPayload(),
      session,
    );

    expect(accepted).toBe(false);
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
    }));
    expect(proxySnapshots.blockServer).not.toHaveBeenCalledWith(
      'server-a',
      'authoritative Agent inventory failed on server-a',
    );
    expect(session.ws.terminate).toHaveBeenCalledOnce();
  });

  it('accepts only one winner in a concurrent first-bind compare-and-set race', async () => {
    const { gateway, serversRepo } = makeGateway();
    let persisted: string | null = null;
    let persistedConfig: string | null = null;
    serversRepo.update.mockImplementation(async (criteria: unknown, update: unknown) => {
      if (
        criteria && typeof criteria === 'object'
        && 'hostFingerprint' in criteria
        && update && typeof update === 'object'
        && 'hostFingerprint' in update
      ) {
        if (persisted === null) {
          persisted = String(update.hostFingerprint);
          persistedConfig = String((update as unknown as { agentConfigFingerprint: unknown }).agentConfigFingerprint);
          return { affected: 1 };
        }
        return { affected: 0 };
      }
      return { affected: 1 };
    });
    serversRepo.findOneBy.mockImplementation(async () => ({
      id: 'server-a',
      hostFingerprint: persisted,
      agentConfigFingerprint: persistedConfig,
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanReservedIps: [],
      status: ServerStatus.Unknown,
    }));
    const firstSession = makeSession();
    const secondSession = makeSession();

    const [first, second] = await Promise.all([
      gateway.bindHostFingerprint(
        { id: 'server-a', hostFingerprint: null, agentConfigFingerprint: null } as ServerEntity,
        helloPayload('c'.repeat(64)),
        firstSession,
      ),
      gateway.bindHostFingerprint(
        { id: 'server-a', hostFingerprint: null, agentConfigFingerprint: null } as ServerEntity,
        helloPayload('d'.repeat(64)),
        secondSession,
      ),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(persisted).toBe('c'.repeat(64));
    expect(firstSession.ws.close).not.toHaveBeenCalled();
    expect(secondSession.ws.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('AgentGateway explicit session fencing', () => {
  it('does not invent inventory quarantine when a post-hello pre-report socket is retired', async () => {
    const { gateway, serversRepo } = makeGateway();
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;
    expect(session.hasReceivedHello).toBe(true);
    expect(session.dispatchReady).toBe(false);

    await gateway.fenceSession('server-a', 'bootstrap transport lost');

    expect(session.ws.terminate).toHaveBeenCalledOnce();
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
      quarantineCode: 'AGENT_INVENTORY_FAULT',
    }));
    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.Offline,
    }));
  });

  it('writes Offline itself instead of relying on the ignored close callback', async () => {
    const { gateway, serversRepo } = makeGateway();
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;
    session.markDispatchReady();

    await gateway.fenceSession('server-a', 'credential rotated');

    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.Offline,
      lastSeenAt: expect.any(Date),
    }));
    expect((gateway as unknown as { sessions: Map<string, unknown> }).sessions.has('server-a')).toBe(false);
  });

  it('never clears a durable invalid-result quarantine while retiring the socket', async () => {
    const { gateway, serversRepo } = makeGateway();
    serversRepo.findOneBy.mockResolvedValue({
      id: 'server-a',
      status: ServerStatus.AgentQuarantined,
    });
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;
    session.markDispatchReady();

    await gateway.fenceSession('server-a', 'invalid terminal evidence');

    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
    expect(serversRepo.update).not.toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.Offline,
    }));
  });

  it('terminates the Agent first and republishes an offline snapshot when route deletion fails', async () => {
    const {
      gateway,
      serversRepo,
      sshRoutes,
      sshProxyGateway,
      httpProxyGateway,
    } = makeGateway();
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;
    session.markDispatchReady();
    sshRoutes.clearServer.mockRejectedValueOnce(new Error('route database unavailable'));

    await expect(gateway.fenceSession('server-a', 'credential rotated'))
      .rejects.toThrow('route revocation was only partially applied');

    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
    expect(serversRepo.update).toHaveBeenCalledWith('server-a', expect.objectContaining({
      status: ServerStatus.Offline,
    }));
    expect(httpProxyGateway.scheduleBroadcast).toHaveBeenCalledWith('agent_session_retired');
    expect(sshProxyGateway.broadcastSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not renew stale proxy leases when neither offline status nor route deletion commits', async () => {
    const {
      gateway,
      serversRepo,
      sshRoutes,
      sshProxyGateway,
      httpProxyGateway,
      failStop,
    } = makeGateway();
    const session = activeSession(gateway, 'server-a') as ReturnType<typeof makeSession>;
    session.markDispatchReady();
    serversRepo.update.mockRejectedValueOnce(new Error('server status database unavailable'));
    sshRoutes.clearServer.mockRejectedValueOnce(new Error('route database unavailable'));

    await expect(gateway.fenceSession('server-a', 'credential rotated'))
      .rejects.toThrow('route revocation failed completely');

    expect(session.ws.terminate).toHaveBeenCalledTimes(1);
    expect(httpProxyGateway.scheduleBroadcast).not.toHaveBeenCalled();
    expect(sshProxyGateway.broadcastSnapshot).not.toHaveBeenCalled();
    expect(failStop.terminate).toHaveBeenCalledTimes(1);
  });

  it('releases only its own admission fence when retirement fails before work starts', async () => {
    const { gateway, sshRoutes } = makeGateway();
    const session = activeSession(gateway, 'server-a');
    session.markDispatchReady();
    sshRoutes.clearServer.mockRejectedValueOnce(new Error('route database unavailable'));
    const firstWork = vi.fn().mockResolvedValue('first');

    await expect(gateway.runWithSessionFence('server-a', 'first fence', firstWork))
      .rejects.toThrow('route revocation was only partially applied');
    expect(firstWork).not.toHaveBeenCalled();

    const secondWork = vi.fn().mockResolvedValue('recovered');
    await expect(gateway.runWithSessionFence('server-a', 'second fence', secondWork))
      .resolves.toBe('recovered');
    expect(secondWork).toHaveBeenCalledTimes(1);
  });
});

describe('AgentGateway durable invalid-result quarantine admission', () => {
  it('retains the admission slot after socket close until authentication I/O settles', async () => {
    const { gateway, serversRepo } = makeGateway();
    let release!: (value: null) => void;
    serversRepo.findOne.mockImplementationOnce(() => new Promise<null>((resolve) => {
      release = resolve;
    }));
    const server = new EventEmitter();
    gateway.attachToHttpServer(server as never);
    const wss = (gateway as unknown as { wss: EventEmitter }).wss;
    const ws = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN as number,
      terminate: vi.fn(),
      close: vi.fn(),
    });

    wss.emit('connection', ws, {
      url: '/ws/agent',
      headers: { authorization: 'Bearer pending-token' },
    });
    await vi.waitFor(() => expect(serversRepo.findOne).toHaveBeenCalled());
    const initializing = (gateway as unknown as {
      initializingSockets: Set<typeof ws>;
    }).initializingSockets;
    expect(initializing.has(ws)).toBe(true);

    ws.readyState = WebSocket.CLOSED;
    ws.emit('close');
    expect(initializing.has(ws)).toBe(true);

    release(null);
    await vi.waitFor(() => expect(initializing.has(ws)).toBe(false));
  });

  it('rejects reconnects while the server remains quarantined', async () => {
    const { gateway, serversRepo } = makeGateway();
    const rawToken = 'raw-token';
    const quarantined = {
      id: 'server-a',
      name: 'server-a',
      agentTokenHash: createHash('sha256').update(rawToken).digest('hex'),
      status: ServerStatus.AgentQuarantined,
    };
    serversRepo.findOne.mockResolvedValue(quarantined);
    serversRepo.findOneBy.mockResolvedValue(quarantined);
    const ws = {
      close: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    await gateway.handleConnection(ws, {
      headers: { authorization: `Bearer ${rawToken}` },
    });

    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.close).not.toHaveBeenCalled();
    expect(ws.on).toHaveBeenCalledWith('message', expect.any(Function));
  });
});

function remoteSpec(id: string): RemoteFsMountSpec {
  return {
    id,
    hostMountPoint: `/mnt/remote-fs/${id}`,
    options: '',
    params: {
      type: RemoteFsType.Nfs,
      nfsServer: 'nfs.internal',
      exportPath: '/export',
      version: '4.2',
    },
  };
}

function mountedStatus(id: string): RemoteFsMountStatus {
  return {
    id,
    hostMountPoint: `/mnt/remote-fs/${id}`,
    status: 'mounted',
    lastCheckedAt: 1,
  };
}
