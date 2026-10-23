import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleBridgeGateway } from '../containers/console-bridge.gateway.js';
import { ConsoleSessionService } from '../containers/console-session.service.js';

const SECRET = 'one-time-console-secret';
const RENEWED_SECRET = 'renewed-console-secret';

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close'));
  });
}

class FakeExecSocket extends EventEmitter {
  readonly send = vi.fn();
}

function mentions(calls: unknown[][], secret: string): boolean {
  return calls.some((args) => args.some((arg) =>
    (Buffer.isBuffer(arg) ? arg.toString('utf8') : String(arg)).includes(secret)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Incus console bridge contract', () => {
  it('accepts the one authentication frame without logging or forwarding the secret', async () => {
    const logged = (['log', 'warn', 'error', 'debug', 'verbose'] as const)
      .map((level) => vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    const stdin = new FakeExecSocket();
    const control = new FakeExecSocket();
    const physical = { sockets: { '0': stdin, control }, close: vi.fn() };
    const auth = {
      validateAccessToken: vi.fn(async () => ({
        user: { id: 'user-1', authVersion: 0 },
        sessionId: 'browser-session-1',
        expiresAt: new Date(Date.now() + 15 * 60_000),
      })),
      browserSessionDeadline: vi.fn(async () => ({
        at: new Date(Date.now() + 15 * 60_000),
        renewable: true,
      })),
    };
    const sessions = {
      claim: vi.fn(async (sessionId: string, actorId: string) => ({
        sessionId,
        actorId,
        serverId: 'server-1',
        instanceName: 'nyc-1',
        command: ['bash'],
        tty: true,
        cols: 80,
        rows: 24,
      })),
      isRevoked: () => false,
      release: vi.fn(),
      openExec: vi.fn(async () => physical),
    };
    const gateway = new ConsoleBridgeGateway(
      auth as never,
      sessions as never,
      { get: vi.fn(async () => ({})) } as never,
      { subscribe: () => () => undefined } as never,
    );
    const socket = new FakeSocket();
    // Driven through the socket's single frame dispatcher, as a browser would.
    const handled = (gateway as unknown as {
      handle(value: FakeSocket, request: { url: string }): Promise<void>;
    }).handle(socket, { url: '/ws/console?sessionId=00000000-0000-4000-8000-000000000001' });

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: SECRET })));
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ready' })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: RENEWED_SECRET })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'ls\n' })));
    await vi.waitFor(() => expect(auth.browserSessionDeadline).toHaveBeenCalledTimes(2));

    expect(auth.validateAccessToken.mock.calls).toEqual([[SECRET], [RENEWED_SECRET]]);
    expect(socket.close).not.toHaveBeenCalled();
    expect(stdin.send).toHaveBeenCalledWith(Buffer.from('ls\n', 'utf8'));
    for (const secret of [SECRET, RENEWED_SECRET]) {
      // Never echoed to the browser, forwarded to the exec stream or logged.
      expect(mentions(socket.send.mock.calls, secret)).toBe(false);
      expect(mentions(stdin.send.mock.calls, secret)).toBe(false);
      expect(mentions(control.send.mock.calls, secret)).toBe(false);
      for (const spy of logged) expect(mentions(spy.mock.calls, secret)).toBe(false);
    }

    socket.close();
    await handled;
    expect(physical.close).toHaveBeenCalled();
  });

  it('opens a direct Incus exec websocket and does not create an Agent task', async () => {
    const openExecWebSockets = vi.fn().mockResolvedValue({
      sockets: {},
      close: vi.fn(),
    });
    const sessions = new ConsoleSessionService({} as never, {} as never, {} as never);

    await sessions.openExec(
      { openExecWebSockets } as never,
      'nyc-container-1',
      ['bash'],
      { tty: true, width: 120, height: 40 },
    );

    expect(openExecWebSockets).toHaveBeenCalledWith(
      'nyc-container-1',
      expect.objectContaining({
        command: ['bash'],
        interactive: true,
        'wait-for-websocket': true,
        width: 120,
        height: 40,
      }),
      expect.objectContaining({
        channels: ['0', 'control'],
      }),
    );
  });
});
