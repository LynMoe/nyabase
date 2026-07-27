import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  ConsoleGateway,
  MAX_CONCURRENT_CONSOLE_AUTH_CHECKS,
} from '../console-gateway.js';
import type { ExecSessionInfo } from '../exec-session-registry.js';

describe('ConsoleGateway durable authorization', () => {
  it('retains a global slot until each uncancellable authorization lookup settles', async () => {
    const releases: Array<(value: boolean) => void> = [];
    const authorization = {
      isAuthorized: vi.fn(() => new Promise<boolean>((resolve) => {
        releases.push(resolve);
      })),
    };
    const gateway = makeGateway(authorization);
    const check = (gateway as unknown as {
      isSessionAuthorized(
        info: ExecSessionInfo,
        authVersion: number,
        tokenExpiresAtMs: number,
      ): Promise<boolean>;
    }).isSessionAuthorized.bind(gateway);
    const pending = Array.from(
      { length: MAX_CONCURRENT_CONSOLE_AUTH_CHECKS },
      () => check(info(), 0, Date.now() + 60_000),
    );

    await expect(check(info(), 0, Date.now() + 60_000)).rejects.toThrow('authorization capacity');
    expect(authorization.isAuthorized).toHaveBeenCalledTimes(MAX_CONCURRENT_CONSOLE_AUTH_CHECKS);

    releases.forEach((release) => release(true));
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: MAX_CONCURRENT_CONSOLE_AUTH_CHECKS }, () => true),
    );
  });

  it('fails a durable console recheck once the access JWT expires', async () => {
    const authorization = { isAuthorized: vi.fn().mockResolvedValue(true) };
    const gateway = makeGateway(authorization);
    const check = (gateway as unknown as {
      isSessionAuthorized(
        info: ExecSessionInfo,
        authVersion: number,
        tokenExpiresAtMs: number,
      ): Promise<boolean>;
    }).isSessionAuthorized.bind(gateway);

    await expect(check(info(), 0, Date.now() - 1)).resolves.toBe(false);
    expect(authorization.isAuthorized).not.toHaveBeenCalled();
  });

  it('does not release an admission slot when the socket closes during durable authorization', async () => {
    let release!: (value: boolean) => void;
    const authorization = {
      isAuthorized: vi.fn(() => new Promise<boolean>((resolve) => {
        release = resolve;
      })),
    };
    const session = info();
    const registry = registryFor(session);
    const gateway = makeGateway(authorization, registry);
    const client = websocket();
    const internals = gateway as unknown as {
      handleConnection(ws: typeof client, req: { url: string }): Promise<void>;
    };
    let settled = false;
    const connection = internals
      .handleConnection(client, { url: '/ws/console?sessionId=session-a' })
      .finally(() => { settled = true; });
    client.emit('message', JSON.stringify({ type: 'auth', token: 'token-a' }));
    await vi.waitFor(() => expect(authorization.isAuthorized).toHaveBeenCalledOnce());

    client.readyState = WebSocket.CLOSED;
    client.emit('close');
    await Promise.resolve();
    expect(settled).toBe(false);

    release(true);
    await connection;
    expect(settled).toBe(true);
    expect(registry.remove).toHaveBeenCalledWith('session-a', session);
  });

  it('rechecks the exact session scope before forwarding every browser command', async () => {
    const authorization = {
      isAuthorized: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    };
    const session = info();
    const registry = registryFor(session);
    const agentGateway = {
      notify: vi.fn(),
      notifyAsync: vi.fn().mockResolvedValue(undefined),
      notifyExecAsync: vi.fn().mockResolvedValue(undefined),
      socketOwnerId: vi.fn(() => 'agent-gateway-a'),
      onLogChunk: vi.fn(() => vi.fn()),
      touchLogSession: vi.fn(),
    };
    const gateway = makeGateway(authorization, registry, agentGateway);
    const client = websocket();
    const connection = (gateway as unknown as {
      handleConnection(ws: typeof client, req: { url: string }): Promise<void>;
    }).handleConnection(client, { url: '/ws/console?sessionId=session-a' });

    client.emit('message', JSON.stringify({ type: 'auth', token: 'token-a' }));
    await connection;
    client.emit('message', JSON.stringify({ type: 'input', data: 'whoami\n' }));
    await vi.waitFor(() => expect(authorization.isAuthorized).toHaveBeenCalledTimes(2));

    expect(client.close).toHaveBeenCalledWith(4403, 'Console authorization revoked');
    expect(agentGateway.notifyExecAsync).toHaveBeenCalledWith(
      'session-a',
      expect.stringMatching(/^console:/),
      'server-a',
      'execClose',
      { sessionId: 'session-a' },
    );
    expect(agentGateway.notifyExecAsync).not.toHaveBeenCalledWith(
      'session-a',
      expect.any(String),
      'server-a',
      'execInput',
      expect.anything(),
    );
  });

  it('releases admission when the durable claim query throws', async () => {
    const workflow = workflowMock();
    workflow.claimExecSession.mockRejectedValueOnce(new Error('postgres unavailable'));
    const gateway = makeGateway(
      { isAuthorized: vi.fn().mockResolvedValue(true) },
      { get: vi.fn() },
      undefined,
      workflow,
    );
    const client = websocket();
    const connection = handle(gateway, client);

    client.emit('message', JSON.stringify({ type: 'auth', token: 'token-a' }));
    await expect(connection).resolves.toBeUndefined();

    expect(client.close).toHaveBeenCalledWith(1011, 'Console admission unavailable');
    expect(workflow.closeExecSession).not.toHaveBeenCalled();
  });

  it('closes the physical and durable session when local registration throws after claim', async () => {
    const workflow = workflowMock();
    const registry = {
      get: vi.fn(),
      register: vi.fn(() => {
        throw new Error('local registry full');
      }),
      remove: vi.fn(),
    };
    const agentGateway = agentGatewayMock();
    const gateway = makeGateway(
      { isAuthorized: vi.fn().mockResolvedValue(true) },
      registry,
      agentGateway,
      workflow,
    );
    const client = websocket();
    const connection = handle(gateway, client);

    client.emit('message', JSON.stringify({ type: 'auth', token: 'token-a' }));
    await expect(connection).resolves.toBeUndefined();

    expect(agentGateway.notifyExecAsync).toHaveBeenCalledWith(
      'session-a',
      expect.stringMatching(/^console:/),
      'server-a',
      'execClose',
      { sessionId: 'session-a' },
    );
    expect(workflow.closeExecSession).toHaveBeenCalledWith(
      'session-a',
      'Console local registration failed',
    );
    expect(client.close).toHaveBeenCalledWith(4429, 'Console session limit reached');
  });

  it('closes the physical and durable session when log registration throws after claim', async () => {
    const session = info();
    const registry = registryFor(session);
    const workflow = workflowMock();
    const agentGateway = {
      ...agentGatewayMock(),
      onLogChunk: vi.fn(() => {
        throw new Error('log registry full');
      }),
    };
    const gateway = makeGateway(
      { isAuthorized: vi.fn().mockResolvedValue(true) },
      registry,
      agentGateway,
      workflow,
    );
    const client = websocket();
    const connection = handle(gateway, client);

    client.emit('message', JSON.stringify({ type: 'auth', token: 'token-a' }));
    await expect(connection).resolves.toBeUndefined();

    expect(registry.remove).toHaveBeenCalledWith('session-a', session);
    expect(agentGateway.notifyExecAsync).toHaveBeenCalledWith(
      'session-a',
      expect.stringMatching(/^console:/),
      'server-a',
      'execClose',
      { sessionId: 'session-a' },
    );
    expect(workflow.closeExecSession).toHaveBeenCalledWith(
      'session-a',
      'Console log registration failed',
    );
    expect(client.close).toHaveBeenCalledWith(4429, 'Console session limit reached');
  });
});

function makeGateway(
  authorization: object,
  registry: object = { claimForUser: vi.fn() },
  agentGateway: object = agentGatewayMock(),
  workflow: object = workflowMock(),
): ConsoleGateway {
  return new ConsoleGateway(
    agentGateway as never,
    registry as never,
    { verify: vi.fn(() => ({ sub: 'user-a', ver: 0, exp: Math.floor(Date.now() / 1000) + 3_600 })) } as never,
    { get: vi.fn(() => 'secret') } as never,
    authorization as never,
    workflow as never,
  );
}

function handle(gateway: ConsoleGateway, client: ReturnType<typeof websocket>) {
  return (gateway as unknown as {
    handleConnection(
      ws: typeof client,
      req: { url: string },
    ): Promise<void>;
  }).handleConnection(client, { url: '/ws/console?sessionId=session-a' });
}

function agentGatewayMock() {
  return {
    notify: vi.fn(),
    notifyAsync: vi.fn().mockResolvedValue(undefined),
    notifyExecAsync: vi.fn().mockResolvedValue(undefined),
    socketOwnerId: vi.fn(() => 'agent-gateway-a'),
    onLogChunk: vi.fn(() => vi.fn()),
    touchLogSession: vi.fn(),
  };
}

function workflowMock() {
  return {
    claimExecSession: vi.fn().mockResolvedValue({
      id: 'session-a',
      serverId: 'server-a',
      userId: 'user-a',
      containerId: 'container-a',
      runtimeId: 'docker-a',
      authorizationKind: 'container-owner',
      createdAt: new Date(),
    }),
    touchExecSession: vi.fn().mockResolvedValue(true),
    closeExecSession: vi.fn().mockResolvedValue(true),
  };
}

function info(): ExecSessionInfo {
  return {
    serverId: 'server-a',
    userId: 'user-a',
    containerId: 'container-a',
    dockerId: 'runtime-a',
    authorizationKind: 'container-owner',
    createdAt: Date.now(),
    claimed: false,
  };
}

function registryFor(session: ExecSessionInfo) {
  let current: ExecSessionInfo | undefined = session;
  return {
    claimForUser: vi.fn((_sessionId: string, userId: string, closeClient: (reason: string) => void) => {
      if (!current || current.claimed || current.userId !== userId) return undefined;
      current.claimed = true;
      current.closeClient = closeClient;
      return current;
    }),
    get: vi.fn(() => current),
    remove: vi.fn((_sessionId: string, expected?: ExecSessionInfo) => {
      if (!current || (expected && current !== expected)) return false;
      current = undefined;
      return true;
    }),
    touch: vi.fn(() => true),
  };
}

function websocket() {
  return Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn(),
    bufferedAmount: 0,
  });
}
