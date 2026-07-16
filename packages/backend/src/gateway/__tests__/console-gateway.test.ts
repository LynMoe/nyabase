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
      isSessionAuthorized(info: ExecSessionInfo): Promise<boolean>;
    }).isSessionAuthorized.bind(gateway);
    const pending = Array.from(
      { length: MAX_CONCURRENT_CONSOLE_AUTH_CHECKS },
      () => check(info()),
    );

    await expect(check(info())).rejects.toThrow('authorization capacity');
    expect(authorization.isAuthorized).toHaveBeenCalledTimes(MAX_CONCURRENT_CONSOLE_AUTH_CHECKS);

    releases.forEach((release) => release(true));
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: MAX_CONCURRENT_CONSOLE_AUTH_CHECKS }, () => true),
    );
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
    expect(agentGateway.notify).toHaveBeenCalledWith(
      'server-a',
      'execClose',
      { sessionId: 'session-a' },
    );
    expect(agentGateway.notify).not.toHaveBeenCalledWith(
      'server-a',
      'execInput',
      expect.anything(),
    );
  });
});

function makeGateway(
  authorization: object,
  registry: object = { claimForUser: vi.fn() },
  agentGateway: object = { notify: vi.fn() },
): ConsoleGateway {
  return new ConsoleGateway(
    agentGateway as never,
    registry as never,
    { verify: vi.fn(() => ({ sub: 'user-a' })) } as never,
    { get: vi.fn(() => 'secret') } as never,
    authorization as never,
  );
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
