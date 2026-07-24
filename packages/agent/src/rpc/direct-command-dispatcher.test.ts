import { describe, expect, it, vi } from 'vitest';
import {
  LABEL,
  RemoteFsType,
  type AgentToBackendMessage,
  type RemoteFsMountSpec,
} from '@nyabase/common';
import type { AgentConfig } from '../config.js';
import {
  DirectCommandDispatcher,
  MAX_PENDING_EXEC_SESSIONS,
} from './direct-command-dispatcher.js';

describe('DirectCommandDispatcher identity/bootstrap RPC', () => {
  it('freshly inspects the exact managed runtime and returns deduplicated graph paths', async () => {
    const sent: AgentToBackendMessage[] = [];
    const docker = {
      inspectContainer: vi.fn(async () => ({
        Id: 'runtime-a',
        Config: { Labels: {
          [LABEL.MANAGED]: 'true',
          [LABEL.CONTAINER_ID]: 'container-a',
          [LABEL.SERVER_ID]: 'server-a',
        } },
        State: { StartedAt: '2026-01-01T00:00:00Z', Running: true },
      })),
      getGraphDriverDirs: vi.fn(async () => ({ upperDir: '/graph/upper', workDir: '/graph/upper' })),
    };
    const dispatcher = makeDispatcher(docker, {}, sent);

    await dispatcher.handle({
      id: 'rpc-a',
      ts: 1,
      kind: 'inspectContainer',
      payload: { containerId: 'container-a', runtimeId: 'runtime-a' },
    });

    expect(docker.inspectContainer).toHaveBeenCalledWith('runtime-a');
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: {
        commandId: 'rpc-a',
        ok: true,
        data: {
          runtimeId: 'runtime-a',
          startedAt: '2026-01-01T00:00:00Z',
          running: true,
          graphPaths: ['/graph/upper'],
        },
      },
    });
  });

  it('returns an RPC error for a runtime/label identity mismatch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const docker = {
      inspectContainer: vi.fn(async () => ({
        Id: 'runtime-a',
        Config: { Labels: {
          [LABEL.MANAGED]: 'true',
          [LABEL.CONTAINER_ID]: 'another-container',
          [LABEL.SERVER_ID]: 'server-a',
        } },
        State: { StartedAt: '2026-01-01T00:00:00Z', Running: false },
      })),
      getGraphDriverDirs: vi.fn(),
    };

    await makeDispatcher(docker, {}, sent).handle({
      id: 'rpc-a',
      ts: 1,
      kind: 'inspectContainer',
      payload: { containerId: 'container-a', runtimeId: 'runtime-a' },
    });

    expect(docker.getGraphDriverDirs).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: { commandId: 'rpc-a', ok: false },
    });
  });

  it('samples runtime physical identity again when Docker inspection fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const guard = vi.fn().mockResolvedValue(undefined);
    const docker = {
      inspectContainer: vi.fn(async () => { throw new Error('inspect failed'); }),
    };

    await makeDispatcher(docker, {}, sent, undefined, guard).handle({
      id: 'rpc-a',
      ts: 1,
      kind: 'inspectContainer',
      payload: { containerId: 'container-a', runtimeId: 'runtime-a' },
    });

    expect(guard).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: { commandId: 'rpc-a', ok: false, error: 'inspect failed' },
    });
  });

  it('does not inspect Docker when the runtime physical pre-sample fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const guard = vi.fn(async () => { throw new Error('runtime drift'); });
    const docker = { inspectContainer: vi.fn() };

    await makeDispatcher(docker, {}, sent, undefined, guard).handle({
      id: 'rpc-a',
      ts: 1,
      kind: 'inspectContainer',
      payload: { containerId: 'container-a', runtimeId: 'runtime-a' },
    });

    expect(docker.inspectContainer).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: { commandId: 'rpc-a', ok: false, error: 'runtime drift' },
    });
  });

  it('runs the runtime physical post-sample before publishing self-check results', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const guard = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('runtime drift'));
    const docker = {
      pingDaemon: vi.fn().mockResolvedValue(undefined),
      daemonInfo: vi.fn(async () => { throw new Error('unavailable'); }),
    };
    const dispatcher = makeDispatcher(
      docker,
      { getDriverSelfChecks: vi.fn(() => []) },
      sent,
      undefined,
      guard,
      {
        dropbear: { getSelfCheckItems: vi.fn(async () => []) },
        quota: { checkToolAvailable: vi.fn().mockResolvedValue(undefined) },
      },
    );

    await dispatcher.handle({ id: 'self-a', ts: 1, kind: 'selfCheck', payload: {} });

    expect(guard).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: { commandId: 'self-a', ok: false, error: 'runtime drift' },
    });
  });

  it('acks bootstrap after the full stable RemoteFS snapshot is adopted', async () => {
    const sent: AgentToBackendMessage[] = [];
    const sync = vi.fn();
    const spec: RemoteFsMountSpec = {
      id: 'remote-a',
      hostMountPoint: '/mnt/remote-fs/remote-a',
      options: '',
      params: {
        type: RemoteFsType.Nfs,
        nfsServer: '10.0.0.1',
        exportPath: '/project',
        version: '4.2' as const,
      },
    };
    const status = {
      id: spec.id,
      hostMountPoint: spec.hostMountPoint,
      status: 'mounted' as const,
      lastCheckedAt: 1,
    };
    const mounter = {
      getAllSpecs: vi.fn(() => [{ ...spec, id: 'stale' }]),
      adoptSnapshot: vi.fn(async () => [status]),
      getSpec: vi.fn(() => spec),
    };
    const dispatcher = makeDispatcher({}, mounter, sent, sync);

    await dispatcher.handle({
      id: 'bootstrap-a',
      ts: 1,
      kind: 'agent.bootstrap.v1',
      payload: { remoteFsMounts: [spec] },
    });

    expect(sync).toHaveBeenCalledWith([spec], ['stale']);
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: {
        commandId: 'bootstrap-a',
        ok: true,
        data: { remoteFsMounts: [status] },
      },
    });
  });

  it('keeps bootstrap closed when RemoteFS snapshot identity is invalid', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const sync = vi.fn();
    const mounter = {
      getAllSpecs: vi.fn(() => []),
      adoptSnapshot: vi.fn(async () => { throw new Error('bootstrap identity invalid'); }),
      getSpec: vi.fn(),
    };
    const dispatcher = makeDispatcher({}, mounter, sent, sync);

    await dispatcher.handle({
      id: 'bootstrap-a',
      ts: 1,
      kind: 'agent.bootstrap.v1',
      payload: { remoteFsMounts: [] },
    });

    expect(sync).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: { commandId: 'bootstrap-a', ok: false, error: 'bootstrap identity invalid' },
    });
  });

  it('validates the outgoing bootstrap result before publishing the snapshot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const sync = vi.fn();
    const mounter = {
      getAllSpecs: vi.fn(() => []),
      adoptSnapshot: vi.fn(async () => [{
        id: 'remote-a',
        hostMountPoint: '/mnt/remote-fs/remote-a',
        status: 'not-a-status',
        lastCheckedAt: 1,
      }]),
      getSpec: vi.fn(),
    };

    await makeDispatcher({}, mounter, sent, sync).handle({
      id: 'bootstrap-a',
      ts: 1,
      kind: 'agent.bootstrap.v1',
      payload: { remoteFsMounts: [] },
    });

    expect(sync).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: { commandId: 'bootstrap-a', ok: false },
    });
  });

  it('never emits an old bootstrap acknowledgement onto a replacement connection', async () => {
    const sent: AgentToBackendMessage[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mounter = {
      getAllSpecs: vi.fn(() => []),
      adoptSnapshot: vi.fn(async () => {
        await gate;
        return [];
      }),
      getSpec: vi.fn(),
    };
    const dispatcher = makeDispatcher({}, mounter, sent);

    const old = dispatcher.handle({
      id: 'bootstrap-old',
      ts: 1,
      kind: 'agent.bootstrap.v1',
      payload: { remoteFsMounts: [] },
    });
    await vi.waitFor(() => expect(mounter.adoptSnapshot).toHaveBeenCalledOnce());
    dispatcher.resetConnection();
    release();
    await old;

    expect(sent.some((message) =>
      message.kind === 'commandAck'
      && message.payload.commandId === 'bootstrap-old')).toBe(false);
  });
});

describe('DirectCommandDispatcher exec lifecycle', () => {
  it('reserves synchronously but does not open or acknowledge before the physical pre-sample', async () => {
    const sent: AgentToBackendMessage[] = [];
    let releaseGuard!: () => void;
    const guardGate = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const guard = vi.fn().mockReturnValueOnce(guardGate).mockResolvedValue(undefined);
    const handles = {
      kill: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), write: vi.fn(() => true),
    };
    const docker = { exec: vi.fn().mockResolvedValue(handles) };
    const dispatcher = makeDispatcher(docker, {}, sent, undefined, guard);

    const handled = dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    expect((dispatcher as unknown as {
      pendingExecSessions: Map<string, unknown>;
    }).pendingExecSessions.has('session-a')).toBe(true);
    expect(docker.exec).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);

    releaseGuard();
    await handled;
    await dispatcher.waitForIdle();
    expect(docker.exec).toHaveBeenCalledOnce();
    expect(sent).toContainEqual(expect.objectContaining({
      kind: 'commandAck',
      payload: expect.objectContaining({ commandId: 'exec-a', ok: true }),
    }));
  });

  it('kills the unpublished exec and suppresses ack/output when the post-sample detects drift', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const guard = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('runtime drift'));
    const handles = {
      kill: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), write: vi.fn(() => true),
    };
    const docker = {
      exec: vi.fn(async (
        _runtimeId: string,
        _cmd: string[],
        _tty: boolean,
        onData: (data: string, stderr: boolean) => void,
      ) => {
        onData('buffered-output', false);
        return handles;
      }),
    };
    const dispatcher = makeDispatcher(docker, {}, sent, undefined, guard);

    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await dispatcher.waitForIdle();

    expect(guard).toHaveBeenCalledTimes(2);
    expect(handles.kill).toHaveBeenCalledOnce();
    expect((dispatcher as unknown as { execSessions: Map<string, unknown> }).execSessions.size).toBe(0);
    expect(sent.some((message) => message.kind === 'logChunk')).toBe(false);
    expect(sent).toContainEqual(expect.objectContaining({
      kind: 'commandAck',
      payload: expect.objectContaining({ commandId: 'exec-a', ok: false, error: 'runtime drift' }),
    }));
  });

  it('runs the post-sample after Docker rejects an exec open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const guard = vi.fn().mockResolvedValue(undefined);
    const dispatcher = makeDispatcher({
      exec: vi.fn(async () => { throw new Error('open failed'); }),
    }, {}, sent, undefined, guard);

    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await dispatcher.waitForIdle();

    expect(guard).toHaveBeenCalledTimes(2);
    expect(sent).toContainEqual(expect.objectContaining({
      kind: 'commandAck',
      payload: expect.objectContaining({ commandId: 'exec-a', ok: false, error: 'open failed' }),
    }));
  });

  it('does not publish exec success before initial Docker resize and its post-sample settle', async () => {
    const sent: AgentToBackendMessage[] = [];
    let releaseResize!: () => void;
    const resizeGate = new Promise<void>((resolve) => { releaseResize = resolve; });
    const guard = vi.fn().mockResolvedValue(undefined);
    const handles = {
      kill: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn(() => resizeGate),
      write: vi.fn(() => true),
    };
    const dispatcher = makeDispatcher(
      { exec: vi.fn().mockResolvedValue(handles) },
      {},
      sent,
      undefined,
      guard,
    );

    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: {
        sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true,
        cols: 120, rows: 40,
      },
    });
    await vi.waitFor(() => expect(handles.resize).toHaveBeenCalledWith(120, 40));

    expect(guard).toHaveBeenCalledOnce();
    expect(sent.some((message) => message.kind === 'commandAck')).toBe(false);
    let idleSettled = false;
    const idle = dispatcher.waitForIdle().then(() => { idleSettled = true; });
    await Promise.resolve();
    expect(idleSettled).toBe(false);

    releaseResize();
    await idle;
    expect(guard).toHaveBeenCalledTimes(2);
    expect(sent).toContainEqual(expect.objectContaining({
      kind: 'commandAck',
      payload: expect.objectContaining({ commandId: 'exec-a', ok: true }),
    }));
  });

  it('kills an unpublished exec when daemon drift follows its initial resize', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const guard = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('runtime drift'));
    const handles = {
      kill: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(() => true),
    };
    const dispatcher = makeDispatcher(
      { exec: vi.fn().mockResolvedValue(handles) }, {}, sent, undefined, guard,
    );

    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: {
        sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true,
        cols: 120, rows: 40,
      },
    });
    await dispatcher.waitForIdle();

    expect(handles.resize).toHaveBeenCalledOnce();
    expect(handles.kill).toHaveBeenCalledOnce();
    expect((dispatcher as unknown as { execSessions: Map<string, unknown> }).execSessions.size)
      .toBe(0);
    expect(sent.some((message) => message.kind === 'logChunk')).toBe(false);
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: { commandId: 'exec-a', ok: false, error: 'runtime drift' },
    });
  });

  it('post-samples a failed active resize and closes the exact session before error ack', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const guard = vi.fn().mockResolvedValue(undefined);
    const handles = {
      kill: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn(async () => { throw new Error('resize failed'); }),
      write: vi.fn(() => true),
    };
    const dispatcher = makeDispatcher(
      { exec: vi.fn().mockResolvedValue(handles) }, {}, sent, undefined, guard,
    );
    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await dispatcher.waitForIdle();

    await dispatcher.handle({
      id: 'resize-a', ts: 2, kind: 'execResize',
      payload: { sessionId: 'session-a', cols: 120, rows: 40 },
    });

    expect(guard).toHaveBeenCalledTimes(4);
    expect(handles.kill).toHaveBeenCalledOnce();
    expect((dispatcher as unknown as { execSessions: Map<string, unknown> }).execSessions.size)
      .toBe(0);
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: { commandId: 'resize-a', ok: false, error: 'resize failed' },
    });
  });

  it('closes an active resize when the post-sample detects daemon drift', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    let releaseResize!: () => void;
    const resizeGate = new Promise<void>((resolve) => { releaseResize = resolve; });
    const guard = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('runtime drift'));
    const handles = {
      kill: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn(() => resizeGate),
      write: vi.fn(() => true),
    };
    const dispatcher = makeDispatcher(
      { exec: vi.fn().mockResolvedValue(handles) }, {}, sent, undefined, guard,
    );
    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await dispatcher.waitForIdle();

    const resizing = dispatcher.handle({
      id: 'resize-a', ts: 2, kind: 'execResize',
      payload: { sessionId: 'session-a', cols: 120, rows: 40 },
    });
    await vi.waitFor(() => expect(handles.resize).toHaveBeenCalledOnce());
    expect(handles.kill).not.toHaveBeenCalled();
    releaseResize();
    await resizing;

    expect(handles.kill).toHaveBeenCalledOnce();
    expect((dispatcher as unknown as { execSessions: Map<string, unknown> }).execSessions.size)
      .toBe(0);
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: { commandId: 'resize-a', ok: false, error: 'runtime drift' },
    });
  });

  it('does not write active input when its daemon pre-sample fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const guard = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('runtime drift'));
    const handles = {
      kill: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), write: vi.fn(() => true),
    };
    const dispatcher = makeDispatcher(
      { exec: vi.fn().mockResolvedValue(handles) }, {}, sent, undefined, guard,
    );
    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await dispatcher.waitForIdle();

    await dispatcher.handle({
      id: 'input-a', ts: 2, kind: 'execInput',
      payload: { sessionId: 'session-a', data: 'YQ==' },
    });

    expect(handles.write).not.toHaveBeenCalled();
    expect(handles.kill).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: { commandId: 'input-a', ok: false, error: 'runtime drift' },
    });
  });

  it('does not run a queued input after execClose wins while the pre-sample is pending', async () => {
    const sent: AgentToBackendMessage[] = [];
    let releaseGuard!: () => void;
    const guardGate = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const guard = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(guardGate)
      .mockResolvedValue(undefined);
    const handles = {
      kill: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), write: vi.fn(() => true),
    };
    const dispatcher = makeDispatcher(
      { exec: vi.fn().mockResolvedValue(handles) }, {}, sent, undefined, guard,
    );
    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await dispatcher.waitForIdle();

    const input = dispatcher.handle({
      id: 'input-a', ts: 2, kind: 'execInput',
      payload: { sessionId: 'session-a', data: 'YQ==' },
    });
    await vi.waitFor(() => expect(guard).toHaveBeenCalledTimes(3));
    await dispatcher.handle({
      id: 'close-a', ts: 3, kind: 'execClose', payload: { sessionId: 'session-a' },
    });
    releaseGuard();
    await input;

    expect(handles.write).not.toHaveBeenCalled();
    expect(handles.kill).toHaveBeenCalledOnce();
    expect((dispatcher as unknown as { execSessions: Map<string, unknown> }).execSessions.size)
      .toBe(0);
  });

  it('keeps a closing exec owner and idle barrier until physical kill settles', async () => {
    const sent: AgentToBackendMessage[] = [];
    let releaseKill!: () => void;
    const killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const handles = {
      kill: vi.fn(() => killGate),
      resize: vi.fn(),
      write: vi.fn(() => true),
    };
    const dispatcher = makeDispatcher({ exec: vi.fn().mockResolvedValue(handles) }, {}, sent);
    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await vi.waitFor(() => expect((dispatcher as unknown as {
      execSessions: Map<string, unknown>;
    }).execSessions.size).toBe(1));

    const closing = dispatcher.handle({
      id: 'close-a', ts: 2, kind: 'execClose', payload: { sessionId: 'session-a' },
    });
    await vi.waitFor(() => expect(handles.kill).toHaveBeenCalledOnce());
    expect((dispatcher as unknown as {
      execSessions: Map<string, unknown>;
    }).execSessions.size).toBe(1);

    let idleSettled = false;
    const idle = dispatcher.waitForIdle().then(() => { idleSettled = true; });
    await Promise.resolve();
    expect(idleSettled).toBe(false);

    releaseKill();
    await Promise.all([closing, idle]);
    expect((dispatcher as unknown as {
      execSessions: Map<string, unknown>;
    }).execSessions.size).toBe(0);
  });

  it('does not make a stable active shell global physical work', async () => {
    const sent: AgentToBackendMessage[] = [];
    const handles = {
      kill: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn(),
      write: vi.fn(() => true),
    };
    const dispatcher = makeDispatcher({ exec: vi.fn().mockResolvedValue(handles) }, {}, sent);
    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await vi.waitFor(() => expect((dispatcher as unknown as {
      execSessions: Map<string, unknown>;
    }).execSessions.size).toBe(1));

    await expect(dispatcher.waitForIdle()).resolves.toBeUndefined();
    expect(handles.kill).not.toHaveBeenCalled();
  });

  it('closes only sessions on the durable task exact runtime', async () => {
    const sent: AgentToBackendMessage[] = [];
    const handlesA = {
      kill: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), write: vi.fn(() => true),
    };
    const handlesB = {
      kill: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), write: vi.fn(() => true),
    };
    const docker = {
      exec: vi.fn(async (runtimeId: string) => runtimeId === 'runtime-a' ? handlesA : handlesB),
    };
    const dispatcher = makeDispatcher(docker, {}, sent);
    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await dispatcher.handle({
      id: 'exec-b', ts: 2, kind: 'execStream',
      payload: { sessionId: 'session-b', runtimeId: 'runtime-b', cmd: ['/bin/sh'], tty: true },
    });
    await vi.waitFor(() => expect((dispatcher as unknown as {
      execSessions: Map<string, unknown>;
    }).execSessions.size).toBe(2));

    await dispatcher.closeByRuntime('runtime-a');

    expect(handlesA.kill).toHaveBeenCalledOnce();
    expect(handlesB.kill).not.toHaveBeenCalled();
    expect((dispatcher as unknown as {
      execSessions: Map<string, unknown>;
    }).execSessions.size).toBe(1);
  });

  it('rejects late same-runtime opens for the complete durable task fence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    let releaseKill!: () => void;
    const killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const activeHandles = {
      kill: vi.fn(() => killGate), resize: vi.fn(), write: vi.fn(() => true),
    };
    const laterHandles = {
      kill: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), write: vi.fn(() => true),
    };
    const docker = { exec: vi.fn().mockResolvedValueOnce(activeHandles).mockResolvedValue(laterHandles) };
    const dispatcher = makeDispatcher(docker, {}, sent);
    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await vi.waitFor(() => expect((dispatcher as unknown as {
      execSessions: Map<string, unknown>;
    }).execSessions.size).toBe(1));

    const acquiring = dispatcher.acquireRuntimeTaskFence('runtime-a');
    await vi.waitFor(() => expect(activeHandles.kill).toHaveBeenCalledOnce());
    await dispatcher.handle({
      id: 'late-a', ts: 2, kind: 'execStream',
      payload: { sessionId: 'session-late-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await dispatcher.handle({
      id: 'other-b', ts: 3, kind: 'execStream',
      payload: { sessionId: 'session-b', runtimeId: 'runtime-b', cmd: ['/bin/sh'], tty: true },
    });

    expect(docker.exec).toHaveBeenCalledTimes(2);
    expect(sent).toContainEqual(expect.objectContaining({
      kind: 'commandAck',
      payload: expect.objectContaining({
        commandId: 'late-a', ok: false, error: expect.stringContaining('durable task'),
      }),
    }));

    releaseKill();
    const releaseFence = await acquiring;
    await dispatcher.handle({
      id: 'still-fenced-a', ts: 4, kind: 'execStream',
      payload: { sessionId: 'session-still-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    expect(docker.exec).toHaveBeenCalledTimes(2);

    releaseFence();
    await dispatcher.handle({
      id: 'after-a', ts: 5, kind: 'execStream',
      payload: { sessionId: 'session-after-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    expect(docker.exec).toHaveBeenCalledTimes(3);
  });

  it('waitForIdle snapshots admitted work and cannot be starved by later console churn', async () => {
    const sent: AgentToBackendMessage[] = [];
    let resolveA!: (handles: {
      kill(): Promise<void>; resize(): void; write(): boolean;
    }) => void;
    let resolveB!: (handles: {
      kill(): Promise<void>; resize(): void; write(): boolean;
    }) => void;
    const openingA = new Promise<{
      kill(): Promise<void>; resize(): void; write(): boolean;
    }>((resolve) => { resolveA = resolve; });
    const openingB = new Promise<{
      kill(): Promise<void>; resize(): void; write(): boolean;
    }>((resolve) => { resolveB = resolve; });
    const docker = { exec: vi.fn().mockReturnValueOnce(openingA).mockReturnValueOnce(openingB) };
    const dispatcher = makeDispatcher(docker, {}, sent);
    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });

    let snapshotSettled = false;
    const snapshot = dispatcher.waitForIdle().then(() => { snapshotSettled = true; });
    await dispatcher.handle({
      id: 'exec-b', ts: 2, kind: 'execStream',
      payload: { sessionId: 'session-b', runtimeId: 'runtime-b', cmd: ['/bin/sh'], tty: true },
    });
    resolveA({ kill: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), write: vi.fn(() => true) });
    await snapshot;

    expect(snapshotSettled).toBe(true);
    expect((dispatcher as unknown as {
      pendingExecSessions: Map<string, unknown>;
    }).pendingExecSessions.has('session-b')).toBe(true);
    // Let the detached test object settle without making it part of the first
    // admission snapshot assertion.
    resolveB({ kill: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), write: vi.fn(() => true) });
  });

  it('retains a stale pending open across reset until its physical close settles', async () => {
    const sent: AgentToBackendMessage[] = [];
    let resolveOpen!: (handles: {
      kill(): Promise<void>; resize(): void; write(): boolean;
    }) => void;
    const opening = new Promise<{
      kill(): Promise<void>; resize(): void; write(): boolean;
    }>((resolve) => { resolveOpen = resolve; });
    let releaseKill!: () => void;
    const killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const handles = { kill: vi.fn(() => killGate), resize: vi.fn(), write: vi.fn(() => true) };
    const dispatcher = makeDispatcher({ exec: vi.fn(() => opening) }, {}, sent);

    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    dispatcher.resetConnection();
    expect((dispatcher as unknown as {
      pendingExecSessions: Map<string, unknown>;
    }).pendingExecSessions.size).toBe(1);

    let idleSettled = false;
    const idle = dispatcher.waitForIdle().then(() => { idleSettled = true; });
    resolveOpen(handles);
    await vi.waitFor(() => expect(handles.kill).toHaveBeenCalledOnce());
    expect((dispatcher as unknown as {
      pendingExecSessions: Map<string, unknown>;
    }).pendingExecSessions.size).toBe(1);
    expect(idleSettled).toBe(false);

    releaseKill();
    await idle;
    expect((dispatcher as unknown as {
      pendingExecSessions: Map<string, unknown>;
    }).pendingExecSessions.size).toBe(0);
  });

  it('kills and forgets an exec whose Docker stdin is backpressured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const handles = {
      kill: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(() => false),
    };
    const dispatcher = makeDispatcher({ exec: vi.fn().mockResolvedValue(handles) }, {}, sent);
    await dispatcher.handle({
      id: 'exec-a',
      ts: 1,
      kind: 'execStream',
      payload: {
        sessionId: 'session-a',
        runtimeId: 'runtime-a',
        cmd: ['/bin/sh'],
        tty: true,
      },
    });
    await vi.waitFor(() => expect((dispatcher as unknown as {
      execSessions: Map<string, unknown>;
    }).execSessions.size).toBe(1));

    await dispatcher.handle({
      id: 'input-a',
      ts: 1,
      kind: 'execInput',
      payload: { sessionId: 'session-a', data: 'YQ==' },
    });
    await dispatcher.handle({
      id: 'input-after-close',
      ts: 1,
      kind: 'execInput',
      payload: { sessionId: 'session-a', data: 'Yg==' },
    });

    expect(handles.write).toHaveBeenCalledOnce();
    expect(handles.kill).toHaveBeenCalledOnce();
    expect(sent).toContainEqual(expect.objectContaining({
      kind: 'commandAck',
      payload: expect.objectContaining({
        commandId: 'input-a',
        ok: false,
        error: expect.stringContaining('backpressure'),
      }),
    }));
  });

  it('rejects exec opens beyond the bounded pending-session capacity', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: AgentToBackendMessage[] = [];
    const docker = { exec: vi.fn(() => new Promise(() => undefined)) };
    const dispatcher = makeDispatcher(docker, {}, sent);

    for (let index = 0; index < MAX_PENDING_EXEC_SESSIONS; index += 1) {
      await dispatcher.handle({
        id: `exec-${index}`,
        ts: 1,
        kind: 'execStream',
        payload: {
          sessionId: `session-${index}`,
          runtimeId: 'runtime-a',
          cmd: ['/bin/sh'],
          tty: true,
        },
      });
    }
    await dispatcher.handle({
      id: 'exec-overflow',
      ts: 1,
      kind: 'execStream',
      payload: {
        sessionId: 'session-overflow',
        runtimeId: 'runtime-a',
        cmd: ['/bin/sh'],
        tty: true,
      },
    });

    expect(docker.exec).toHaveBeenCalledTimes(MAX_PENDING_EXEC_SESSIONS);
    expect(sent.at(-1)).toMatchObject({
      kind: 'commandAck',
      payload: {
        commandId: 'exec-overflow',
        ok: false,
        error: expect.stringContaining('session limit'),
      },
    });
    dispatcher.resetConnection();
  });

  it('does not allocate pending sessions for unknown control frames', async () => {
    const sent: AgentToBackendMessage[] = [];
    const docker = {
      exec: vi.fn().mockResolvedValue({ kill: vi.fn(), resize: vi.fn(), write: vi.fn() }),
    };
    const dispatcher = makeDispatcher(docker, {}, sent);

    for (let index = 0; index < 128; index += 1) {
      await dispatcher.handle({
        id: `input-${index}`,
        ts: 1,
        kind: 'execInput',
        payload: { sessionId: `unknown-${index}`, data: 'YQ==' },
      });
      await dispatcher.handle({
        id: `resize-${index}`,
        ts: 1,
        kind: 'execResize',
        payload: { sessionId: `unknown-${index}`, cols: 80, rows: 24 },
      });
      await dispatcher.handle({
        id: `close-${index}`,
        ts: 1,
        kind: 'execClose',
        payload: { sessionId: `unknown-${index}` },
      });
    }

    await dispatcher.handle({
      id: 'exec-real', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-real', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });

    expect(docker.exec).toHaveBeenCalledOnce();
  });

  it('kills active exec handles when the Backend connection is lost', async () => {
    const sent: AgentToBackendMessage[] = [];
    const handles = { kill: vi.fn(), resize: vi.fn(), write: vi.fn() };
    const docker = { exec: vi.fn().mockResolvedValue(handles) };
    const dispatcher = makeDispatcher(docker, {}, sent);

    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    await Promise.resolve();
    dispatcher.resetConnection();

    expect(handles.kill).toHaveBeenCalledOnce();
  });

  it('kills an exec whose open resolves after the connection was reset', async () => {
    const sent: AgentToBackendMessage[] = [];
    let resolveOpen!: (handles: { kill(): void; resize(): void; write(): void }) => void;
    const opening = new Promise<{ kill(): void; resize(): void; write(): void }>((resolve) => {
      resolveOpen = resolve;
    });
    const handles = { kill: vi.fn(), resize: vi.fn(), write: vi.fn() };
    const dispatcher = makeDispatcher({ exec: vi.fn(() => opening) }, {}, sent);

    await dispatcher.handle({
      id: 'exec-a', ts: 1, kind: 'execStream',
      payload: { sessionId: 'session-a', runtimeId: 'runtime-a', cmd: ['/bin/sh'], tty: true },
    });
    dispatcher.resetConnection();
    resolveOpen(handles);
    await dispatcher.waitForIdle();

    expect(handles.kill).toHaveBeenCalledOnce();
  });
});

function makeDispatcher(
  docker: object,
  mounter: object,
  sent: AgentToBackendMessage[],
  sync?: (...args: unknown[]) => void,
  guard?: () => Promise<void>,
  dependencies?: { dropbear?: object; quota?: object },
): DirectCommandDispatcher {
  const ws = { send: (message: AgentToBackendMessage) => sent.push(message), emit: vi.fn() };
  return new DirectCommandDispatcher(
    config(),
    docker as never,
    mounter as never,
    ws as never,
    (dependencies?.dropbear ?? {}) as never,
    (dependencies?.quota ?? { checkToolAvailable: vi.fn() }) as never,
    sync,
    undefined,
    guard,
  );
}

function config(): AgentConfig {
  return {
    backendUrl: 'ws://localhost',
    agentToken: '0123456789abcdef',
    serverId: 'server-a',
    dockerRoot: '/var/lib/nyabase-docker',
    parentIface: 'eth0',
    macvlanCidr: '10.0.0.0/24',
    macvlanGateway: '10.0.0.1',
    reservedIps: [],
    metricsIntervalMs: 10_000,
    isGpuServer: false,
    dockerResourceLimit: { enabled: false },
    localDataSources: [],
    agentVersion: 'test',
  };
}
