import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs';
import { AgentCommandKind, type BackendToAgentMessage, type AgentToBackendMessage, type ContainerMountSpec } from '@nyabase/common';
import { CommandDispatcher } from './dispatcher.js';
import type { AgentConfig } from '../config.js';
import type { DockerClient } from '../docker/docker-client.js';
import type { XfsQuotaManager } from '../quota/xfs-quota.js';
import type { DataDirsManager } from '../datadirs/data-dirs.js';
import type { RemoteFsMounter } from '../fs/remote-fs-mounter.js';
import type { AgentWsClient } from '../ws/client.js';
import type { DropbearManager } from '../dropbear/dropbear-manager.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

const execFileMock = vi.mocked(execFile);
const existsSyncMock = vi.mocked(fs.existsSync);

type ExecFileCallback = (
  err: Error | null,
  result?: { stdout: string; stderr: string },
) => void;
type TestExecHandles = { kill: () => void; resize: (c: number, r: number) => void; write: (data: string) => void };

type ExecFileCallExpectation = {
  cmd: string;
  args: readonly string[];
  stdout?: string;
  stderr?: string;
  error?: Error;
};

function makeConfig(): AgentConfig {
  return {
    backendUrl: 'ws://localhost',
    agentToken: 'tok',
    serverId: 'srv-1',
    dockerRoot: '/var/lib/nyabase-docker',
    parentIface: 'eth0',
    macvlanCidr: '10.0.0.0/24',
    macvlanGateway: '10.0.0.1',
    metricsIntervalMs: 10_000,
    mountHelperPath: '/usr/local/bin/mount-helper',
    agentVersion: '0.1.0',
    isGpuServer: false,
  };
}

function makeWs(): AgentWsClient {
  return { send: vi.fn(), emit: vi.fn(), connected: true } as unknown as AgentWsClient;
}

function makeDispatcher(overrides: Partial<{
  docker: DockerClient;
  quota: XfsQuotaManager;
  dataDirs: DataDirsManager;
  remoteFsMounter: RemoteFsMounter;
  ws: AgentWsClient;
  dropbearManager: DropbearManager;
  getGpuMemUsedMiB: (runtimeId: string) => Promise<Record<string, number>>;
}> = {}) {
  const docker = overrides.docker ?? ({} as unknown as DockerClient);
  const quota = overrides.quota ?? ({} as unknown as XfsQuotaManager);
  const dataDirs = overrides.dataDirs ?? ({} as unknown as DataDirsManager);
  const remoteFsMounter = overrides.remoteFsMounter ?? ({} as unknown as RemoteFsMounter);
  const ws = overrides.ws ?? makeWs();
  const dropbearManager = overrides.dropbearManager ?? ({
    reconcileContainerSsh: vi.fn().mockResolvedValue({
      enabled: true,
      status: 'running',
      user: 'root',
      port: 22,
    }),
  } as unknown as DropbearManager);
  return {
    dispatcher: new CommandDispatcher(
      makeConfig(),
      docker,
      quota,
      dataDirs,
      remoteFsMounter,
      ws,
      dropbearManager,
      undefined,
      overrides.getGpuMemUsedMiB,
    ),
    ws,
    dropbearManager,
  };
}

const DIRECT_COMMAND_KINDS = new Set([
  'execStream',
  'execResize',
  'execInput',
  'execClose',
  'reconcile',
  'fetchContainerStats',
  'checkDisk',
  'selfCheck',
  'reconcileDockerDaemon',
]);

function directMsg(kind: string, payload: unknown, id = 'cmd-1'): BackendToAgentMessage {
  return { id, ts: Date.now(), kind, payload } as BackendToAgentMessage;
}

function msg(kind: string, payload: unknown, id = 'cmd-1'): BackendToAgentMessage {
  if (DIRECT_COMMAND_KINDS.has(kind)) return directMsg(kind, payload, id);
  return {
    id,
    ts: Date.now(),
    kind: 'agentCommand',
    payload: {
      operationId: `operation-${id || 'none'}`,
      commandId: id,
      commandKind: kind,
      idempotencyKey: `idempotency-${id || 'none'}`,
      resourceKey: `resource-${id || 'none'}`,
      desiredGeneration: null,
      payload,
    },
  } as BackendToAgentMessage;
}

function getSentAck(ws: AgentWsClient): AgentToBackendMessage {
  const send = ws.send as ReturnType<typeof vi.fn>;
  const acks = send.mock.calls
    .map((call) => call[0] as AgentToBackendMessage)
    .filter((sent) => sent.kind === 'commandAck');
  return acks[acks.length - 1];
}

function getSentProgress(ws: AgentWsClient): AgentToBackendMessage[] {
  const send = ws.send as ReturnType<typeof vi.fn>;
  return send.mock.calls
    .map((call) => call[0] as AgentToBackendMessage)
    .filter((sent) => sent.kind === 'operationProgress');
}

function getExecCallback(args: unknown[]): ExecFileCallback {
  const callback = args[args.length - 1];
  if (typeof callback !== 'function') {
    throw new Error('expected execFile callback');
  }
  return callback as ExecFileCallback;
}

function mockStatFs(fsType: string): void {
  execFileMock.mockImplementation(((cmd: string, args: readonly string[], ...rest: unknown[]) => {
    expect(cmd).toBe('stat');
    expect(args).toEqual(['-f', '-c', '%T', expect.any(String)]);
    getExecCallback(rest)(null, { stdout: `${fsType}\n`, stderr: '' });
  }) as typeof execFile);
}

function mockExecFileSequence(calls: ExecFileCallExpectation[]): () => void {
  const pending = [...calls];
  execFileMock.mockImplementation(((cmd: string, args: readonly string[], ...rest: unknown[]) => {
    const expected = pending.shift();
    if (!expected) {
      throw new Error(`unexpected execFile call: ${cmd} ${args.join(' ')}`);
    }
    expect(cmd).toBe(expected.cmd);
    expect(args).toEqual(expected.args);
    const callback = getExecCallback(rest);
    if (expected.error) {
      callback(expected.error);
      return;
    }
    callback(null, { stdout: expected.stdout ?? '', stderr: expected.stderr ?? '' });
  }) as typeof execFile);

  return () => {
    expect(pending).toEqual([]);
  };
}

function containerMount(overrides: Partial<ContainerMountSpec> = {}): ContainerMountSpec {
  return {
    sourceKind: 'remote',
    sourceId: 'remote-1',
    userId: 'user-1',
    dirName: 'project-a',
    containerPath: '/mnt/nfs',
    hostPath: '/mnt/nyabase-nfs/project-a',
    ...overrides,
  };
}

function dockerWithInspect(status: string, pid: number): DockerClient {
  return {
    inspectContainer: vi.fn().mockResolvedValue({
      State: { Status: status, Pid: pid },
    }),
  } as unknown as DockerClient;
}

function mockRealpaths(overrides: Record<string, string | Error> = {}): void {
  vi.spyOn(fs.promises, 'realpath').mockImplementation((async (filePath: unknown) => {
    const key = String(filePath);
    const value = overrides[key] ?? key;
    if (value instanceof Error) throw value;
    return value;
  }) as unknown as typeof fs.promises.realpath);
}

function mockProcMounts(content: string): void {
  vi.spyOn(fs.promises, 'readFile').mockImplementation((async (filePath: unknown) => {
    if (String(filePath) !== '/proc/mounts') {
      throw new Error(`unexpected readFile path: ${String(filePath)}`);
    }
    return content;
  }) as unknown as typeof fs.promises.readFile);
}

beforeEach(() => {
  vi.clearAllMocks();
  execFileMock.mockReset();
  existsSyncMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CommandDispatcher ack behaviour', () => {
  it('sends ok=true ack after successful runtime.container.power start', async () => {
    const docker = {
      startContainer: vi.fn().mockResolvedValue(undefined),
    } as unknown as DockerClient;
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerPower, { runtimeId: 'abc', action: 'start' }));

    const ack = getSentAck(ws);
    expect(ack.kind).toBe('commandAck');
    expect((ack.payload as { ok: boolean; commandId: string }).ok).toBe(true);
    expect((ack.payload as { commandId: string }).commandId).toBe('cmd-1');
    expect(getSentProgress(ws).map((event) => event.payload)).toEqual([
      expect.objectContaining({
        operationId: 'operation-cmd-1',
        commandId: 'cmd-1',
        status: 'accepted',
        step: AgentCommandKind.RuntimeContainerPower,
      }),
      expect.objectContaining({
        operationId: 'operation-cmd-1',
        commandId: 'cmd-1',
        status: 'running',
        step: AgentCommandKind.RuntimeContainerPower,
      }),
      expect.objectContaining({
        operationId: 'operation-cmd-1',
        commandId: 'cmd-1',
        status: 'succeeded',
        step: AgentCommandKind.RuntimeContainerPower,
      }),
    ]);
  });

  it.each([
    ['start', 'startContainer'],
    ['restart', 'restartContainer'],
  ] as const)('re-applies mounts and Dropbear SSH after runtime.container.power %s', async (action, dockerMethod) => {
    const docker = {
      startContainer: vi.fn().mockResolvedValue(undefined),
      restartContainer: vi.fn().mockResolvedValue(undefined),
      inspectContainer: vi.fn().mockResolvedValue({ State: { Status: 'running', Pid: 4242 } }),
    } as unknown as DockerClient;
    const dropbearManager = {
      reconcileContainerSsh: vi.fn().mockResolvedValue({ enabled: true, status: 'running', user: 'root', port: 22 }),
    } as unknown as DropbearManager;
    const restoreExec = mockExecFileSequence([
      { cmd: '/usr/local/bin/mount-helper', args: ['list', '--pid', '4242'], stdout: '[]' },
      { cmd: '/usr/local/bin/mount-helper', args: ['mount', '--pid', '4242', '--src', '/mnt/nyabase-nfs/project-a', '--dst', '/mnt/nfs'], stdout: '' },
      { cmd: '/usr/local/bin/mount-helper', args: ['list', '--pid', '4242'], stdout: JSON.stringify([{ src: '/mnt/nyabase-nfs/project-a', dst: '/mnt/nfs' }]) },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker, dropbearManager });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerPower, {
      runtimeId: 'docker-power',
      action,
      mounts: [containerMount()],
      sshServerEnabled: true,
      sshPublicKeys: ['ssh-ed25519 AAAA user@example'],
    }));

    restoreExec();
    expect(docker[dockerMethod]).toHaveBeenCalledWith(
      'docker-power',
      ...(dockerMethod === 'restartContainer' ? [undefined] : []),
    );
    expect(docker.inspectContainer).toHaveBeenCalledWith('docker-power');
    expect(dropbearManager.reconcileContainerSsh).toHaveBeenCalledWith({
      runtimeId: 'docker-power',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
    });
    expect((getSentAck(ws).payload as { ok: boolean }).ok).toBe(true);
  });

  it('sends ok=false ack when command throws', async () => {
    const docker = {
      startContainer: vi.fn().mockRejectedValue(new Error('container not found')),
    } as unknown as DockerClient;
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerPower, { runtimeId: 'bad', action: 'start' }));

    const ack = getSentAck(ws);
    expect(ack.kind).toBe('commandAck');
    const p = ack.payload as { ok: boolean; error: string };
    expect(p.ok).toBe(false);
    expect(p.error).toContain('container not found');
  });

  it('rejects direct lifecycle commands before primitive routing', async () => {
    const docker = {
      startContainer: vi.fn().mockResolvedValue(undefined),
    } as unknown as DockerClient;
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(directMsg('startContainer', { runtimeId: 'abc' }) as BackendToAgentMessage);

    expect(docker.startContainer).not.toHaveBeenCalled();
    const ack = getSentAck(ws);
    expect(ack.payload).toMatchObject({
      commandId: 'cmd-1',
      ok: false,
      error: 'Direct command startContainer is disabled; lifecycle commands must use agentCommand',
    });
  });

  it('buffers exec input and resize that arrive before Docker exec handles are ready', async () => {
    let resolveExec!: (handles: TestExecHandles) => void;
    const execPromise = new Promise<TestExecHandles>((resolve) => {
      resolveExec = resolve;
    });
    const handles: TestExecHandles = {
      kill: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const docker = {
      exec: vi.fn().mockReturnValue(execPromise),
    } as unknown as DockerClient;
    const { dispatcher } = makeDispatcher({ docker });

    await dispatcher.handle(directMsg('execStream', {
      sessionId: 'session-race',
      runtimeId: 'docker-a',
      cmd: ['/bin/sh'],
      tty: true,
    }));
    await dispatcher.handle(directMsg('execInput', { sessionId: 'session-race', data: 'Zmlyc3Q=' }));
    await dispatcher.handle(directMsg('execResize', { sessionId: 'session-race', cols: 120, rows: 40 }));
    await dispatcher.handle(directMsg('execInput', { sessionId: 'session-race', data: 'c2Vjb25k' }));

    expect(handles.write).not.toHaveBeenCalled();
    resolveExec(handles);
    await Promise.resolve();

    expect(handles.resize).toHaveBeenCalledWith(120, 40);
    expect(handles.write).toHaveBeenNthCalledWith(1, 'Zmlyc3Q=');
    expect(handles.write).toHaveBeenNthCalledWith(2, 'c2Vjb25k');
  });

  it('honors exec close that arrives before Docker exec handles are ready', async () => {
    let resolveExec!: (handles: TestExecHandles) => void;
    const execPromise = new Promise<TestExecHandles>((resolve) => {
      resolveExec = resolve;
    });
    const handles: TestExecHandles = {
      kill: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const docker = {
      exec: vi.fn().mockReturnValue(execPromise),
    } as unknown as DockerClient;
    const { dispatcher } = makeDispatcher({ docker });

    await dispatcher.handle(directMsg('execStream', {
      sessionId: 'session-close',
      runtimeId: 'docker-a',
      cmd: ['/bin/sh'],
      tty: true,
    }));
    await dispatcher.handle(directMsg('execInput', { sessionId: 'session-close', data: 'ZHJvcA==' }));
    await dispatcher.handle(directMsg('execClose', { sessionId: 'session-close' }));

    resolveExec(handles);
    await Promise.resolve();

    expect(handles.kill).toHaveBeenCalledTimes(1);
    expect(handles.write).not.toHaveBeenCalled();
  });

  it('sends ok=false ack when payload fails Zod validation', async () => {
    const { dispatcher, ws } = makeDispatcher();

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerPower, { bad: 'field' }));

    const ack = getSentAck(ws);
    expect(ack.kind).toBe('commandAck');
    expect((ack.payload as { ok: boolean }).ok).toBe(false);
  });

  it('emits dataDirChanged after datadir.apply', async () => {
    const dataDirs = {
      createDir: vi.fn().mockResolvedValue('/mnt/disk/mydir'),
      getSource: vi.fn().mockReturnValue({ quotaEnabled: false }),
    } as unknown as DataDirsManager;
    const { dispatcher, ws } = makeDispatcher({ dataDirs });

    await dispatcher.handle(msg(AgentCommandKind.DataDirApply, { diskId: 'd1', name: 'mydir', uid: 1001, numericUserId: 1 }));

    expect((ws.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('dataDirChanged');
  });

  it('assigns created local quota-enabled data dirs to the owner project', async () => {
    const addPathToProject = vi.fn().mockResolvedValue(undefined);
    const quota = {
      addPathToProject,
    } as unknown as XfsQuotaManager;
    const dataDirs = {
      createDir: vi.fn().mockResolvedValue('/mnt/local/project-a'),
      getSource: vi.fn().mockReturnValue({ kind: 'local', id: 'local-1', root: '/mnt/local', quotaEnabled: true }),
    } as unknown as DataDirsManager;
    const { dispatcher, ws } = makeDispatcher({ dataDirs, quota });

    await dispatcher.handle(msg(AgentCommandKind.DataDirApply, {
      diskId: 'local-1',
      name: 'project-a',
      uid: 1001,
      numericUserId: 42,
    }));

    expect(addPathToProject).toHaveBeenCalledWith(42, '/mnt/local/project-a');
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
  });

  it('does not assign remote or local no-quota data dirs to XFS projects', async () => {
    const addPathToProject = vi.fn();
    const quota = {
      addPathToProject,
    } as unknown as XfsQuotaManager;
    const dataDirs = {
      createDir: vi
        .fn()
        .mockResolvedValueOnce('/mnt/nfs/project-a')
        .mockResolvedValueOnce('/mnt/local-noquota/project-b'),
      getSource: vi
        .fn()
        .mockReturnValueOnce({ kind: 'remote', id: 'remote-1', root: '/mnt/nfs', quotaEnabled: false })
        .mockReturnValueOnce({ kind: 'local', id: 'local-2', root: '/mnt/local-noquota', quotaEnabled: false }),
    } as unknown as DataDirsManager;
    const { dispatcher, ws } = makeDispatcher({ dataDirs, quota });

    await dispatcher.handle(msg(AgentCommandKind.DataDirApply, {
      diskId: 'remote-1',
      name: 'project-a',
      uid: 1001,
      numericUserId: 42,
    }, 'cmd-remote'));
    await dispatcher.handle(msg(AgentCommandKind.DataDirApply, {
      diskId: 'local-2',
      name: 'project-b',
      uid: 1001,
      numericUserId: 42,
    }, 'cmd-local-noquota'));

    expect(addPathToProject).not.toHaveBeenCalled();
    const send = ws.send as ReturnType<typeof vi.fn>;
    const acks = send.mock.calls
      .map((call) => call[0] as AgentToBackendMessage)
      .filter((sent) => sent.kind === 'commandAck');
    expect(acks).toHaveLength(2);
    expect(acks[0].payload).toMatchObject({ ok: true });
    expect(acks[1].payload).toMatchObject({ ok: true });
  });

  it('rejects disk.apply when XFS project quota enforcement is off', async () => {
    existsSyncMock.mockReturnValue(true);
    mockStatFs('xfs');
    const dataDirs = {
      addSource: vi.fn(),
    } as unknown as DataDirsManager;
    const quota = {
      checkProjectQuotaEnforcement: vi.fn().mockResolvedValue({
        accounting: true,
        enforcement: false,
        output: 'Accounting: ON\nEnforcement: OFF',
      }),
    } as unknown as XfsQuotaManager;
    const { dispatcher, ws } = makeDispatcher({ dataDirs, quota });

    await dispatcher.handle(msg(AgentCommandKind.DiskApply, { diskId: 'disk-1', mountPoint: '/data' }));

    expect(dataDirs.addSource).not.toHaveBeenCalled();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; error: string }).ok).toBe(false);
    expect((ack.payload as { error: string }).error).toContain(
      '未启用 XFS project quota enforcement (accounting=on, enforcement=off)',
    );
  });

  it('adds a local data source when disk.apply verifies accounting and enforcement', async () => {
    existsSyncMock.mockReturnValue(true);
    mockStatFs('xfs');
    const dataDirs = {
      addSource: vi.fn(),
    } as unknown as DataDirsManager;
    const quota = {
      checkProjectQuotaEnforcement: vi.fn().mockResolvedValue({
        accounting: true,
        enforcement: true,
        output: 'Accounting: ON\nEnforcement: ON',
      }),
    } as unknown as XfsQuotaManager;
    const { dispatcher, ws } = makeDispatcher({ dataDirs, quota });

    await dispatcher.handle(msg(AgentCommandKind.DiskApply, { diskId: 'disk-1', mountPoint: '/data', label: 'data' }));

    expect(dataDirs.addSource).toHaveBeenCalledWith({
      kind: 'local',
      id: 'disk-1',
      root: '/data',
      quotaEnabled: true,
    });
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; data: { diskId: string } }).ok).toBe(true);
    expect((ack.payload as { data: { diskId: string } }).data.diskId).toBe('disk-1');
  });

  it('emits reconcile event for reconcile command (no ack)', async () => {
    const { dispatcher, ws } = makeDispatcher();

    await dispatcher.handle({ id: 'x', ts: Date.now(), kind: 'reconcile', payload: { serverId: 'srv-1' } } as BackendToAgentMessage);

    expect((ws.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('reconcile');
    // reconcile does not send an ack
    expect((ws.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('dispatches runtime.container.ssh.apply to the Dropbear manager and acks its status', async () => {
    const dropbearManager = {
      reconcileContainerSsh: vi.fn().mockResolvedValue({
        enabled: true,
        status: 'running',
        user: 'root',
        port: 22,
        pid: 44,
        keyHash: 'hash',
      }),
    } as unknown as DropbearManager;
    const { dispatcher, ws } = makeDispatcher({ dropbearManager });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerSshApply, {
      runtimeId: 'docker-ssh',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
      expectedKeyHash: 'hash',
      sshPubKeys: ['legacy'],
    }));

    expect(dropbearManager.reconcileContainerSsh).toHaveBeenCalledWith({
      runtimeId: 'docker-ssh',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
      expectedKeyHash: 'hash',
    });
    const ack = getSentAck(ws);
    expect(ack.kind).toBe('commandAck');
    expect(ack.payload).toMatchObject({
      ok: true,
      data: {
        enabled: true,
        status: 'running',
        user: 'root',
        port: 22,
        pid: 44,
      },
    });
  });
});

describe('CommandDispatcher runtime.container.create compensation', () => {
  const basePayload = {
    containerId: 'container-a',
    specGeneration: 1,
    ownerId: 'u-1', numericOwnerId: 1000, imageDockerRef: 'nginx:latest',
    imageId: 'img-1', name: 'c1', cpuMillis: 1000, memBytes: 1024,
    runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
    sshServerEnabled: false,
    createDirs: [], reservedIps: [], gpuIndices: [],
    ipCidr: '10.0.0.0/24', gateway: '10.0.0.1',
  };

  it('passes sshServerEnabled to Docker create and reconciles Dropbear during runtime.container.create', async () => {
    const removeContainer = vi.fn().mockResolvedValue(undefined);
    const docker = {
      allocateNextIp: vi.fn().mockResolvedValue('10.0.0.2'),
      createContainer: vi.fn().mockResolvedValue('docker-id-123'),
      startContainer: vi.fn().mockResolvedValue(undefined),
      getGraphDriverDirs: vi.fn().mockResolvedValue({
        upperDir: '/var/lib/docker/upper',
        workDir: '/var/lib/docker/work',
      }),
      removeContainer,
    } as unknown as DockerClient;

    const quota = {
      ensureProjectForUser: vi.fn().mockResolvedValue(10001),
      addPathToProject: vi.fn().mockResolvedValue(undefined),
      removePathFromProject: vi.fn(),
    } as unknown as XfsQuotaManager;

    const dropbearManager = {
      reconcileContainerSsh: vi.fn().mockResolvedValue({ enabled: true, status: 'running', user: 'root', port: 22 }),
    } as unknown as DropbearManager;
    const { dispatcher, ws } = makeDispatcher({ docker, quota, dropbearManager });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerCreate, { ...basePayload, sshServerEnabled: true, sshPublicKeys: ['ssh-ed25519 AAAA user@example'] }));

    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
    expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      sshServerEnabled: true,
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      ip: '10.0.0.2',
      serverId: 'srv-1',
    }));
    expect(dropbearManager.reconcileContainerSsh).toHaveBeenCalledWith({
      runtimeId: 'docker-id-123',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
    });
    expect(removeContainer).not.toHaveBeenCalled();
  });

  it('rolls back container creation when writable-layer discovery fails', async () => {
    const removeContainer = vi.fn().mockResolvedValue(undefined);
    const removePathFromProject = vi.fn();
    const docker = {
      allocateNextIp: vi.fn().mockResolvedValue('10.0.0.2'),
      createContainer: vi.fn().mockResolvedValue('docker-id-xyz'),
      startContainer: vi.fn().mockResolvedValue(undefined),
      getGraphDriverDirs: vi.fn().mockResolvedValue({
        upperDir: '/var/lib/docker/upper',
        workDir: '',
      }),
      removeContainer,
    } as unknown as DockerClient;

    const quota = {
      ensureProjectForUser: vi.fn().mockResolvedValue(10001),
      addPathToProject: vi.fn().mockResolvedValue(undefined),
      removePathFromProject,
    } as unknown as XfsQuotaManager;

    const { dispatcher } = makeDispatcher({ docker, quota });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerCreate, basePayload));

    expect(removePathFromProject).not.toHaveBeenCalled();
    expect(removeContainer).toHaveBeenCalledWith('docker-id-xyz', true);
  });

  it('passes image runtime overrides to Docker create', async () => {
    const docker = {
      allocateNextIp: vi.fn().mockResolvedValue('10.0.0.2'),
      createContainer: vi.fn().mockResolvedValue('docker-id-overrides'),
      startContainer: vi.fn().mockResolvedValue(undefined),
      getGraphDriverDirs: vi.fn().mockResolvedValue({
        upperDir: '/var/lib/docker/upper',
        workDir: '/var/lib/docker/work',
      }),
      removeContainer: vi.fn().mockResolvedValue(undefined),
    } as unknown as DockerClient;

    const quota = {
      ensureProjectForUser: vi.fn().mockResolvedValue(10001),
      addPathToProject: vi.fn().mockResolvedValue(undefined),
      removePathFromProject: vi.fn(),
    } as unknown as XfsQuotaManager;

    const { dispatcher, ws } = makeDispatcher({ docker, quota });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerCreate, {
      ...basePayload,
      runtimeOverrides: {
        uid: 1000,
        entrypoint: ['/entrypoint'],
        cmd: ['sleep', 'infinity'],
        init: true,
      },
    }));

    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
    expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      runtimeOverrides: {
        uid: 1000,
        entrypoint: ['/entrypoint'],
        cmd: ['sleep', 'infinity'],
        init: true,
      },
    }));
  });

  it('does not run compensations on the happy path', async () => {
    const removeContainer = vi.fn().mockResolvedValue(undefined);
    const removePathFromProject = vi.fn();
    const docker = {
      allocateNextIp: vi.fn().mockResolvedValue('10.0.0.2'),
      createContainer: vi.fn().mockResolvedValue('docker-id-happy'),
      startContainer: vi.fn().mockResolvedValue(undefined),
      getGraphDriverDirs: vi.fn().mockResolvedValue({
        upperDir: '/var/lib/docker/upper',
        workDir: '/var/lib/docker/work',
      }),
      removeContainer,
    } as unknown as DockerClient;

    const quota = {
      ensureProjectForUser: vi.fn().mockResolvedValue(10001),
      addPathToProject: vi.fn().mockResolvedValue(undefined),
      removePathFromProject,
    } as unknown as XfsQuotaManager;

    const { dispatcher, ws } = makeDispatcher({ docker, quota });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerCreate, basePayload));

    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
    expect(removeContainer).not.toHaveBeenCalled();
    expect(removePathFromProject).not.toHaveBeenCalled();
  });

  it('assigns local quota-enabled createDirs plus Docker upper/work dirs to the owner project', async () => {
    const docker = {
      allocateNextIp: vi.fn().mockResolvedValue('10.0.0.2'),
      createContainer: vi.fn().mockResolvedValue('docker-id-quota'),
      startContainer: vi.fn().mockResolvedValue(undefined),
      getGraphDriverDirs: vi.fn().mockResolvedValue({
        upperDir: '/var/lib/nyabase-docker/overlay2/abc/diff',
        workDir: '/var/lib/nyabase-docker/overlay2/abc/work',
      }),
      removeContainer: vi.fn(),
    } as unknown as DockerClient;
    const dataDirs = {
      getSource: vi
        .fn()
        .mockImplementation((sourceId: string) => {
          switch (sourceId) {
            case 'local-quota':
              return { kind: 'local', id: sourceId, root: '/data/local', quotaEnabled: true };
            case 'local-noquota':
              return { kind: 'local', id: sourceId, root: '/data/noquota', quotaEnabled: false };
            case 'remote':
              return { kind: 'remote', id: sourceId, root: '/mnt/nfs', quotaEnabled: false };
            default:
              return undefined;
          }
        }),
      createDir: vi.fn().mockResolvedValue(undefined),
      getDirPath: vi.fn().mockImplementation((sourceId: string, dirName: string) => `/resolved/${sourceId}/${dirName}`),
    } as unknown as DataDirsManager;
    const quota = {
      ensureProjectForUser: vi.fn().mockResolvedValue(11000),
      addPathToProject: vi.fn().mockResolvedValue(undefined),
      removePathFromProject: vi.fn(),
    } as unknown as XfsQuotaManager;
    const { dispatcher, ws } = makeDispatcher({ docker, dataDirs, quota });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerCreate, {
      ...basePayload,
      createDirs: [
        { sourceKind: 'local', sourceId: 'local-quota', dirName: 'alice', createIfMissing: true, ownerUid: 1234 },
        { sourceKind: 'local', sourceId: 'local-noquota', dirName: 'scratch', createIfMissing: true, ownerUid: 1234 },
        { sourceKind: 'remote', sourceId: 'remote', dirName: 'shared', createIfMissing: false, ownerUid: 1234 },
      ],
    }));

    expect(quota.ensureProjectForUser).toHaveBeenCalledWith(1000);
    expect(dataDirs.createDir).toHaveBeenCalledWith('local-quota', 'alice', 1234);
    expect(dataDirs.createDir).toHaveBeenCalledWith('local-noquota', 'scratch', 1234);
    expect(quota.addPathToProject).toHaveBeenCalledWith(1000, '/resolved/local-quota/alice');
    expect(quota.addPathToProject).toHaveBeenCalledWith(1000, '/var/lib/nyabase-docker/overlay2/abc/diff');
    expect(quota.addPathToProject).toHaveBeenCalledWith(1000, '/var/lib/nyabase-docker/overlay2/abc/work');
    expect(quota.addPathToProject).toHaveBeenCalledTimes(3);
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
  });


  it('reconciles create-time mounts after starting the container', async () => {
    const docker = {
      allocateNextIp: vi.fn().mockResolvedValue('10.0.0.2'),
      createContainer: vi.fn().mockResolvedValue('docker-id-mount'),
      startContainer: vi.fn().mockResolvedValue(undefined),
      inspectContainer: vi.fn().mockResolvedValue({ State: { Status: 'running', Pid: 4242 } }),
      getGraphDriverDirs: vi.fn().mockResolvedValue({
        upperDir: '/var/lib/nyabase-docker/overlay2/mount/diff',
        workDir: '/var/lib/nyabase-docker/overlay2/mount/work',
      }),
      removeContainer: vi.fn(),
    } as unknown as DockerClient;
    const quota = {
      ensureProjectForUser: vi.fn().mockResolvedValue(11000),
      addPathToProject: vi.fn().mockResolvedValue(undefined),
      removePathFromProject: vi.fn(),
    } as unknown as XfsQuotaManager;
    const restoreExec = mockExecFileSequence([
      { cmd: '/usr/local/bin/mount-helper', args: ['list', '--pid', '4242'], stdout: '[]' },
      { cmd: '/usr/local/bin/mount-helper', args: ['mount', '--pid', '4242', '--src', '/mnt/nyabase-nfs/project-a', '--dst', '/mnt/nfs'], stdout: '' },
      { cmd: '/usr/local/bin/mount-helper', args: ['list', '--pid', '4242'], stdout: JSON.stringify([{ src: '/mnt/nyabase-nfs/project-a', dst: '/mnt/nfs' }]) },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker, quota });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerCreate, {
      ...basePayload,
      mounts: [containerMount()],
    }));

    restoreExec();
    expect(docker.inspectContainer).toHaveBeenCalledWith('docker-id-mount');
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
  });

  it('fails ack and compensates container when Docker writable layer quota assignment fails', async () => {
    const removeContainer = vi.fn().mockResolvedValue(undefined);
    const removePathFromProject = vi.fn();
    const docker = {
      allocateNextIp: vi.fn().mockResolvedValue('10.0.0.2'),
      createContainer: vi.fn().mockResolvedValue('docker-id-quota-fail'),
      startContainer: vi.fn().mockResolvedValue(undefined),
      getGraphDriverDirs: vi.fn().mockResolvedValue({
        upperDir: '/var/lib/nyabase-docker/overlay2/bad/diff',
        workDir: '/var/lib/nyabase-docker/overlay2/bad/work',
      }),
      removeContainer,
    } as unknown as DockerClient;
    const quota = {
      ensureProjectForUser: vi.fn().mockResolvedValue(11000),
      addPathToProject: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('project assignment failed')),
      removePathFromProject,
    } as unknown as XfsQuotaManager;
    const { dispatcher, ws } = makeDispatcher({ docker, quota });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerCreate, basePayload));

    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; error: string }).ok).toBe(false);
    expect((ack.payload as { error: string }).error).toContain('project assignment failed');
    expect(removePathFromProject).toHaveBeenCalledWith(1000, '/var/lib/nyabase-docker/overlay2/bad/diff');
    expect(removeContainer).toHaveBeenCalledWith('docker-id-quota-fail', true);
  });

  it('fails ack before container creation when local createDir quota assignment fails', async () => {
    const docker = {
      allocateNextIp: vi.fn(),
      createContainer: vi.fn(),
      startContainer: vi.fn(),
      getGraphDriverDirs: vi.fn(),
      removeContainer: vi.fn(),
    } as unknown as DockerClient;
    const dataDirs = {
      getSource: vi.fn().mockReturnValue({ kind: 'local', id: 'local-quota', root: '/data/local', quotaEnabled: true }),
      createDir: vi.fn().mockResolvedValue(undefined),
      getDirPath: vi.fn().mockReturnValue('/data/local/alice'),
    } as unknown as DataDirsManager;
    const quota = {
      ensureProjectForUser: vi.fn().mockResolvedValue(11000),
      addPathToProject: vi.fn().mockRejectedValue(new Error('createDir assignment failed')),
      removePathFromProject: vi.fn(),
    } as unknown as XfsQuotaManager;
    const { dispatcher, ws } = makeDispatcher({ docker, dataDirs, quota });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerCreate, {
      ...basePayload,
      createDirs: [
        { sourceKind: 'local', sourceId: 'local-quota', dirName: 'alice', createIfMissing: true, ownerUid: 1234 },
      ],
    }));

    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; error: string }).ok).toBe(false);
    expect((ack.payload as { error: string }).error).toContain('createDir assignment failed');
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).not.toHaveBeenCalled();
  });

  it('swallows compensation failures and still surfaces the original error', async () => {
    const docker = {
      allocateNextIp: vi.fn().mockResolvedValue('10.0.0.2'),
      createContainer: vi.fn().mockResolvedValue('docker-id-bad-rb'),
      startContainer: vi.fn().mockResolvedValue(undefined),
      getGraphDriverDirs: vi.fn().mockRejectedValue(new Error('primary failure')),
      // Rollback itself fails — must not mask the original error.
      removeContainer: vi.fn().mockRejectedValue(new Error('rollback exploded')),
    } as unknown as DockerClient;

    const quota = {
      ensureProjectForUser: vi.fn().mockResolvedValue(10001),
      addPathToProject: vi.fn().mockResolvedValue(undefined),
      removePathFromProject: vi.fn(),
    } as unknown as XfsQuotaManager;

    const { dispatcher, ws } = makeDispatcher({ docker, quota });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerCreate, basePayload));

    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; error: string }).ok).toBe(false);
    expect((ack.payload as { error: string }).error).toContain('primary failure');
  });
});

describe('CommandDispatcher dynamic container mounts', () => {
  it('verifies runtime.container.mounts.apply after mount-helper mount and acks success when destination and source match', async () => {
    const mount = containerMount();
    const realpathSpy = vi.spyOn(fs.promises, 'realpath');
    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    const docker = dockerWithInspect('running', 4321);
    const assertNoPendingExec = mockExecFileSequence([
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([]),
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['mount', '--pid', '4321', '--src', mount.hostPath, '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{ dst: mount.containerPath, src: mount.hostPath }]),
      },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, { runtimeId: 'docker-1', expected: [mount] }));

    assertNoPendingExec();
    expect(realpathSpy).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(docker.inspectContainer).toHaveBeenCalledWith('docker-1');
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
    expect((ack.payload as { error?: string }).error).toBeUndefined();
  });

  it('acks runtime.container.mounts.apply when an NFS canonical source matches the host mount plus suffix', async () => {
    const hostMount = '/mnt/nfs-live-20260601t214626z';
    const exportRoot = '10.8.96.92:/srv/nfs-live-20260601t214626z';
    const suffix = 'rw-nfslive20260601t214626z';
    const mount = containerMount({
      hostPath: `${hostMount}/${suffix}`,
      containerPath: '/mnt/nfs',
      dirName: suffix,
    });
    mockRealpaths();
    mockProcMounts(`${exportRoot} ${hostMount} nfs4 rw,relatime,vers=4.2 0 0\n`);
    const docker = dockerWithInspect('running', 4321);
    const assertNoPendingExec = mockExecFileSequence([
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([]),
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['mount', '--pid', '4321', '--src', mount.hostPath, '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{ dst: mount.containerPath, src: `${exportRoot}/${suffix}` }]),
      },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, { runtimeId: 'docker-1', expected: [mount] }));

    assertNoPendingExec();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
    expect((ack.payload as { error?: string }).error).toBeUndefined();
  });

  it('acks runtime.container.mounts.apply when a local XFS mount reports the containing backing device', async () => {
    const mount = containerMount({
      sourceKind: 'local',
      sourceId: 'local-1',
      hostPath: '/data/project-a',
      containerPath: '/mnt/local-project',
    });
    mockRealpaths();
    mockProcMounts('/dev/sdb /data xfs rw,relatime,prjquota 0 0\n');
    const docker = dockerWithInspect('running', 4321);
    const assertNoPendingExec = mockExecFileSequence([
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([]),
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['mount', '--pid', '4321', '--src', mount.hostPath, '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{ dst: mount.containerPath, src: '/dev/sdb' }]),
      },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, { runtimeId: 'docker-1', expected: [mount] }));

    assertNoPendingExec();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
    expect((ack.payload as { error?: string }).error).toBeUndefined();
  });

  it('returns failed ack when runtime.container.mounts.apply verification cannot find the destination after mount-helper mount', async () => {
    const mount = containerMount();
    const docker = dockerWithInspect('running', 4321);
    const assertNoPendingExec = mockExecFileSequence([
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([]),
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['mount', '--pid', '4321', '--src', mount.hostPath, '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([]),
      },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, { runtimeId: 'docker-1', expected: [mount] }));

    assertNoPendingExec();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; error: string }).ok).toBe(false);
    expect((ack.payload as { error: string }).error).toContain(
      'Container mount verification failed after reconcileContainerMounts',
    );
    expect((ack.payload as { error: string }).error).toContain(
      `missing mount dockerId=docker-1 pid=4321 source=${mount.hostPath} destination=${mount.containerPath}`,
    );
    expect((ack.payload as { error: string }).error).toContain(
      'proofFailure=destination not present in mount-helper list',
    );
  });

  it('returns failed ack when runtime.container.mounts.apply verification finds the destination with the wrong source', async () => {
    const mount = containerMount();
    const docker = dockerWithInspect('running', 4321);
    const assertNoPendingExec = mockExecFileSequence([
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{ dst: mount.containerPath, src: '/mnt/other/project-a' }]),
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['umount', '--pid', '4321', '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['mount', '--pid', '4321', '--src', mount.hostPath, '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{ dst: mount.containerPath, src: '/mnt/other/project-a' }]),
      },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, { runtimeId: 'docker-1', expected: [mount] }));

    assertNoPendingExec();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; error: string }).ok).toBe(false);
    expect((ack.payload as { error: string }).error).toContain(
      'Container mount verification failed after reconcileContainerMounts',
    );
    expect((ack.payload as { error: string }).error).toContain(
      `mismatched mount dockerId=docker-1 pid=4321 expectedSource=${mount.hostPath} actualSource=/mnt/other/project-a destination=${mount.containerPath}`,
    );
    expect((ack.payload as { error: string }).error).toContain(
      "proofFailure=expected host source realpath failed: ENOENT: no such file or directory, realpath '/mnt/nyabase-nfs/project-a'",
    );
  });

  it('returns failed ack when an NFS canonical source has a different server or export suffix', async () => {
    const hostMount = '/mnt/nfs-live-20260601t214626z';
    const exportRoot = '10.8.96.92:/srv/nfs-live-20260601t214626z';
    const suffix = 'rw-nfslive20260601t214626z';
    const mount = containerMount({
      hostPath: `${hostMount}/${suffix}`,
      containerPath: '/mnt/nfs',
      dirName: suffix,
    });
    mockRealpaths();
    mockProcMounts(`${exportRoot} ${hostMount} nfs4 rw,relatime,vers=4.2 0 0\n`);
    const docker = dockerWithInspect('running', 4321);
    const assertNoPendingExec = mockExecFileSequence([
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{
          dst: mount.containerPath,
          src: '10.8.96.93:/srv/nfs-live-20260601t214626z/other',
        }]),
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['umount', '--pid', '4321', '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['mount', '--pid', '4321', '--src', mount.hostPath, '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{
          dst: mount.containerPath,
          src: '10.8.96.93:/srv/nfs-live-20260601t214626z/other',
        }]),
      },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, { runtimeId: 'docker-1', expected: [mount] }));

    assertNoPendingExec();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; error: string }).ok).toBe(false);
    expect((ack.payload as { error: string }).error).toContain(
      `mismatched mount dockerId=docker-1 pid=4321 expectedSource=${mount.hostPath} actualSource=10.8.96.93:/srv/nfs-live-20260601t214626z/other destination=${mount.containerPath}`,
    );
    expect((ack.payload as { error: string }).error).toContain(
      `proofFailure=canonical NFS source ${exportRoot}/${suffix} did not equal actual source 10.8.96.93:/srv/nfs-live-20260601t214626z/other`,
    );
  });

  it('returns failed ack when the expected host path cannot be resolved', async () => {
    const mount = containerMount({
      hostPath: '/mnt/nfs-live/missing-project',
      containerPath: '/mnt/nfs',
    });
    mockRealpaths({
      [mount.hostPath]: new Error('realpath failed for missing project'),
    });
    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    const docker = dockerWithInspect('running', 4321);
    const assertNoPendingExec = mockExecFileSequence([
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{ dst: mount.containerPath, src: '10.8.96.92:/srv/nfs-live/missing-project' }]),
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['umount', '--pid', '4321', '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['mount', '--pid', '4321', '--src', mount.hostPath, '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{ dst: mount.containerPath, src: '10.8.96.92:/srv/nfs-live/missing-project' }]),
      },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, { runtimeId: 'docker-1', expected: [mount] }));

    assertNoPendingExec();
    expect(readFileSpy).not.toHaveBeenCalled();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; error: string }).ok).toBe(false);
    expect((ack.payload as { error: string }).error).toContain(
      'proofFailure=expected host source realpath failed: realpath failed for missing project',
    );
  });

  it('returns failed ack for non-exact local sources backed by a non-XFS host mount', async () => {
    const mount = containerMount({
      sourceKind: 'local',
      sourceId: 'local-1',
      hostPath: '/mnt/local/project-a',
      containerPath: '/mnt/local-project',
    });
    mockRealpaths();
    mockProcMounts('/dev/sda1 /mnt/local ext4 rw,relatime 0 0\n');
    const docker = dockerWithInspect('running', 4321);
    const assertNoPendingExec = mockExecFileSequence([
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{ dst: mount.containerPath, src: '/dev/sda1/project-a' }]),
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['umount', '--pid', '4321', '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['mount', '--pid', '4321', '--src', mount.hostPath, '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{ dst: mount.containerPath, src: '/dev/sda1/project-a' }]),
      },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, { runtimeId: 'docker-1', expected: [mount] }));

    assertNoPendingExec();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; error: string }).ok).toBe(false);
    expect((ack.payload as { error: string }).error).toContain(
      `mismatched mount dockerId=docker-1 pid=4321 expectedSource=${mount.hostPath} actualSource=/dev/sda1/project-a destination=${mount.containerPath}`,
    );
    expect((ack.payload as { error: string }).error).toContain(
      'proofFailure=containing host mount /mnt/local is ext4, not xfs for local source',
    );
  });

  it('returns failed ack when a local XFS mount reports the wrong backing source', async () => {
    const mount = containerMount({
      sourceKind: 'local',
      sourceId: 'local-1',
      hostPath: '/data/project-a',
      containerPath: '/mnt/local-project',
    });
    mockRealpaths();
    mockProcMounts('/dev/sdb /data xfs rw,relatime,prjquota 0 0\n');
    const docker = dockerWithInspect('running', 4321);
    const assertNoPendingExec = mockExecFileSequence([
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{ dst: mount.containerPath, src: '/dev/sdc' }]),
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['umount', '--pid', '4321', '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['mount', '--pid', '4321', '--src', mount.hostPath, '--dst', mount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '4321'],
        stdout: JSON.stringify([{ dst: mount.containerPath, src: '/dev/sdc' }]),
      },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, { runtimeId: 'docker-1', expected: [mount] }));

    assertNoPendingExec();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; error: string }).ok).toBe(false);
    expect((ack.payload as { error: string }).error).toContain(
      `mismatched mount dockerId=docker-1 pid=4321 expectedSource=${mount.hostPath} actualSource=/dev/sdc destination=${mount.containerPath}`,
    );
    expect((ack.payload as { error: string }).error).toContain(
      'proofFailure=local XFS backing source /dev/sdb did not equal actual source /dev/sdc',
    );
    expect((ack.payload as { error: string }).error).toContain(
      'canonical expected=/dev/sdb actual=/dev/sdc',
    );
  });

  it('returns failed ack when runtime.container.mounts.apply verification still sees absent and mismatched mounts', async () => {
    const missingMount = containerMount({
      sourceId: 'remote-1',
      dirName: 'project-a',
      containerPath: '/mnt/nfs-a',
      hostPath: '/mnt/nyabase-nfs/project-a',
    });
    const mismatchedMount = containerMount({
      sourceId: 'remote-2',
      dirName: 'project-b',
      containerPath: '/mnt/nfs-b',
      hostPath: '/mnt/nyabase-nfs/project-b',
    });
    const docker = dockerWithInspect('running', 9876);
    const assertNoPendingExec = mockExecFileSequence([
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '9876'],
        stdout: JSON.stringify([{ dst: mismatchedMount.containerPath, src: '/mnt/stale/project-b' }]),
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['mount', '--pid', '9876', '--src', missingMount.hostPath, '--dst', missingMount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['umount', '--pid', '9876', '--dst', mismatchedMount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['mount', '--pid', '9876', '--src', mismatchedMount.hostPath, '--dst', mismatchedMount.containerPath],
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '9876'],
        stdout: JSON.stringify([{ dst: mismatchedMount.containerPath, src: '/mnt/wrong/project-b' }]),
      },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, {
      runtimeId: 'docker-1',
      expected: [missingMount, mismatchedMount],
    }));

    assertNoPendingExec();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean; error: string }).ok).toBe(false);
    expect((ack.payload as { error: string }).error).toContain(
      'Container mount verification failed after reconcileContainerMounts',
    );
    expect((ack.payload as { error: string }).error).toContain(
      `missing mount dockerId=docker-1 pid=9876 source=${missingMount.hostPath} destination=${missingMount.containerPath}`,
    );
    expect((ack.payload as { error: string }).error).toContain(
      `mismatched mount dockerId=docker-1 pid=9876 expectedSource=${mismatchedMount.hostPath} actualSource=/mnt/wrong/project-b destination=${mismatchedMount.containerPath}`,
    );
    expect((ack.payload as { error: string }).error).toContain(
      "proofFailure=expected host source realpath failed: ENOENT: no such file or directory, realpath '/mnt/nyabase-nfs/project-b'",
    );
  });

  it('treats an existing equivalent NFS-backed mount as reconciled without umount or mount', async () => {
    const hostMount = '/mnt/nfs-live-20260601t214626z';
    const exportRoot = '10.8.96.92:/srv/nfs-live-20260601t214626z';
    const suffix = 'rw-nfslive20260601t214626z';
    const mount = containerMount({
      hostPath: `${hostMount}/${suffix}`,
      containerPath: '/mnt/nfs',
      dirName: suffix,
    });
    const current = [{ dst: mount.containerPath, src: `${exportRoot}/${suffix}` }];
    mockRealpaths();
    mockProcMounts(`${exportRoot} ${hostMount} nfs4 rw,relatime,vers=4.2 0 0\n`);
    const docker = dockerWithInspect('running', 9876);
    const assertNoPendingExec = mockExecFileSequence([
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '9876'],
        stdout: JSON.stringify(current),
      },
      {
        cmd: '/usr/local/bin/mount-helper',
        args: ['list', '--pid', '9876'],
        stdout: JSON.stringify(current),
      },
    ]);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, {
      runtimeId: 'docker-1',
      expected: [mount],
    }));

    assertNoPendingExec();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
    expect((ack.payload as { data: { current: Array<{ dst: string; src: string }> } }).data.current).toEqual(current);
  });

  it('acks runtime.container.mounts.apply removal request without invoking mount-helper when the container is not running', async () => {
    const docker = dockerWithInspect('exited', 0);
    const { dispatcher, ws } = makeDispatcher({ docker });

    await dispatcher.handle(msg(AgentCommandKind.RuntimeContainerMountsApply, {
      runtimeId: 'docker-1',
      expected: [],
      toRemove: ['/mnt/nfs'],
    }));

    expect(execFileMock).not.toHaveBeenCalled();
    const ack = getSentAck(ws);
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
  });
});

describe('CommandDispatcher fetchContainerStats', () => {
  it('acks stats from Docker stats merged with the injected GPU memory provider', async () => {
    const getGpuMemUsedMiB = vi.fn().mockResolvedValue({ 'GPU-a': 123 });
    const docker = {
      fetchContainerStatsWithGpuMem: vi.fn().mockResolvedValue({
        cpuUsageRatio: 0.5,
        memUsedBytes: 2048,
        memLimitBytes: 4096,
        netRxBytes: 10,
        netTxBytes: 20,
        blockReadBytes: 30,
        blockWriteBytes: 40,
        gpuMemUsedMiB: { 'GPU-a': 123 },
      }),
    } as unknown as DockerClient;
    const { dispatcher, ws } = makeDispatcher({ docker, getGpuMemUsedMiB });

    await dispatcher.handle(msg('fetchContainerStats', { runtimeId: 'docker-id-123' }));

    expect(docker.fetchContainerStatsWithGpuMem).toHaveBeenCalledWith('docker-id-123', getGpuMemUsedMiB);
    const ack = getSentAck(ws);
    expect(ack.kind).toBe('commandAck');
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
    expect((ack.payload as { data: { gpuMemUsedMiB: Record<string, number> } }).data.gpuMemUsedMiB).toEqual({
      'GPU-a': 123,
    });
  });
});
