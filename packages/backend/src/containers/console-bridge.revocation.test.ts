import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SessionRevocationService } from '../iam/session-revocation.service.js';
import {
  CONSOLE_CLOSE_AUTH_EXPIRED,
  CONSOLE_CLOSE_BACKPRESSURE,
  CONSOLE_CLOSE_SESSION_REVOKED,
  ConsoleBridgeGateway,
  MAX_CONSOLE_BUFFERED_BYTES,
} from './console-bridge.gateway.js';
import { EphemeralStore } from '../platform/ephemeral-store.js';
import { ConsoleSessionService, type ConsoleSession } from './console-session.service.js';

const OPEN = 1;
const CLOSED = 3;

class FakeSocket extends EventEmitter {
  readyState = OPEN;
  bufferedAmount = 0;
  readonly terminate = vi.fn();
  readonly send = vi.fn();
  readonly close = vi.fn((_code?: number) => {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    queueMicrotask(() => this.emit('close'));
  });
}

function harness() {
  const revocations = new SessionRevocationService();
  const physical: { sockets: Record<string, EventEmitter>; close: ReturnType<typeof vi.fn> } = {
    sockets: {},
    close: vi.fn(),
  };
  /** Access tokens by value: the user, the browser session and the token expiry. */
  const tokens = new Map<string, { userId: string; sessionId: string; expiresAt: Date }>();
  /** Live browser sessions and their idle expiry; absent = logged out. */
  const browserSessions = new Map<string, Date>();
  const sessions = {
    claim: vi.fn(async (sessionId: string, actorId: string): Promise<ConsoleSession> => ({
      sessionId,
      actorId,
      authVersion: 0,
      containerId: 'container-1',
      serverId: 'server-1',
      instanceName: 'nyc-1',
      command: ['bash'],
      tty: true,
      cols: 80,
      rows: 24,
      admin: false,
      revocationGeneration: generationAtCreate.get(actorId) ?? 0,
      state: 'claimed',
      expiresAt: new Date().toISOString(),
    })),
    isRevoked: (session: ConsoleSession) =>
      revocations.generation(session.actorId) !== session.revocationGeneration,
    release: vi.fn(),
    openExec: vi.fn(async () => physical),
  };
  const generationAtCreate = new Map<string, number>();
  const auth = {
    validateAccessToken: vi.fn(async (token: string) => {
      const found = tokens.get(token);
      if (!found) throw new Error('Invalid access token');
      return { user: { id: found.userId, authVersion: 0 }, sessionId: found.sessionId, expiresAt: found.expiresAt };
    }),
    browserSessionDeadline: vi.fn(async (credential: { sessionId: string; expiresAt: Date }) => {
      const sessionEnd = browserSessions.get(credential.sessionId);
      if (!sessionEnd) return null;
      return new Date(Math.min(sessionEnd.getTime(), credential.expiresAt.getTime()));
    }),
  };
  const gateway = new ConsoleBridgeGateway(
    auth as never,
    sessions as never,
    { get: vi.fn(async () => ({})) } as never,
    revocations,
  );
  gateway.onModuleInit();

  function issue(userId: string, sessionId: string, lifetimeMs = 15 * 60_000): string {
    const token = `token-${randomUUID()}`;
    tokens.set(token, { userId, sessionId, expiresAt: new Date(Date.now() + lifetimeMs) });
    if (!browserSessions.has(sessionId)) browserSessions.set(sessionId, new Date(Date.now() + 86_400_000));
    return token;
  }

  async function connect(userId: string, options: { sessionId?: string; lifetimeMs?: number } = {}) {
    const sessionId = options.sessionId ?? `${userId}-session`;
    const token = issue(userId, sessionId, options.lifetimeMs);
    const socket = new FakeSocket();
    const handled = (gateway as unknown as {
      handle(socket: FakeSocket, request: { url: string }): Promise<void>;
    }).handle(socket, { url: `/ws/console?sessionId=${randomUUID()}` });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token })));
    return { socket, handled, sessionId };
  }

  return {
    gateway, revocations, physical, sessions, generationAtCreate, browserSessions, connect, issue,
  };
}

function sentTypes(socket: FakeSocket): string[] {
  return socket.send.mock.calls.map(([raw]) => (JSON.parse(String(raw)) as { type: string }).type);
}

describe('console bridge session revocation', () => {
  it('closes only the revoked user\'s open console sockets with the revocation close code', async () => {
    const { revocations, physical, connect } = harness();
    const alice = await connect('alice');
    const bob = await connect('bob');
    await vi.waitFor(() => expect(sentTypes(alice.socket)).toContain('ready'));
    await vi.waitFor(() => expect(sentTypes(bob.socket)).toContain('ready'));

    revocations.revoke('alice');

    expect(alice.socket.close).toHaveBeenCalledWith(CONSOLE_CLOSE_SESSION_REVOKED, 'session revoked');
    await alice.handled;
    expect(physical.close).toHaveBeenCalledTimes(1);
    expect(bob.socket.close).not.toHaveBeenCalled();
    expect(bob.socket.readyState).toBe(OPEN);
  });

  it('refuses a session whose user was revoked after the session was created', async () => {
    const { revocations, sessions, generationAtCreate, connect } = harness();
    generationAtCreate.set('alice', revocations.generation('alice'));
    // Revoked between POST /exec-sessions and the websocket claim.
    revocations.revoke('alice');

    const alice = await connect('alice');
    await alice.handled;
    expect(alice.socket.close).toHaveBeenCalledWith(CONSOLE_CLOSE_SESSION_REVOKED, 'session revoked');
    expect(sessions.openExec).not.toHaveBeenCalled();
    expect(sessions.release).toHaveBeenCalled();
  });

  it('closes the consoles of a browser session that logged out, and only those', async () => {
    const { revocations, physical, connect } = harness();
    const laptop = await connect('alice', { sessionId: 'alice-laptop' });
    const phone = await connect('alice', { sessionId: 'alice-phone' });
    await vi.waitFor(() => expect(sentTypes(laptop.socket)).toContain('ready'));
    await vi.waitFor(() => expect(sentTypes(phone.socket)).toContain('ready'));

    revocations.endSession('alice', 'alice-laptop');

    expect(laptop.socket.close).toHaveBeenCalledWith(CONSOLE_CLOSE_SESSION_REVOKED, 'session revoked');
    await laptop.handled;
    expect(physical.close).toHaveBeenCalledTimes(1);
    expect(phone.socket.close).not.toHaveBeenCalled();
    phone.socket.close(1000);
    await phone.handled;
  });

  it('refuses a console whose browser session already ended', async () => {
    const { sessions, browserSessions, connect } = harness();
    const alice = await connect('alice');
    browserSessions.delete(alice.sessionId);
    await alice.handled;
    expect(alice.socket.close).toHaveBeenCalledWith(CONSOLE_CLOSE_SESSION_REVOKED, 'session revoked');
    expect(sessions.openExec).not.toHaveBeenCalled();
  });

  it('stops listening after module destroy', async () => {
    const { gateway, revocations, connect } = harness();
    const alice = await connect('alice');
    await vi.waitFor(() => expect(sentTypes(alice.socket)).toContain('ready'));
    gateway.onModuleDestroy();
    revocations.revoke('alice');
    expect(alice.socket.close).not.toHaveBeenCalled();
    alice.socket.close(1000);
    await alice.handled;
  });
});

describe('console bridge re-authentication', () => {
  it('asks for a fresh token before the credential expires and closes when none arrives', async () => {
    const { physical, connect } = harness();
    const alice = await connect('alice', { lifetimeMs: 40 });
    await vi.waitFor(() => expect(sentTypes(alice.socket)).toContain('reauthenticate'));
    await vi.waitFor(() => expect(alice.socket.close)
      .toHaveBeenCalledWith(CONSOLE_CLOSE_AUTH_EXPIRED, 'console credential expired'));
    await alice.handled;
    expect(physical.close).toHaveBeenCalled();
  });

  it('keeps the console open on a fresh token of the same browser session', async () => {
    const { connect, issue } = harness();
    const alice = await connect('alice', { lifetimeMs: 60 });
    await vi.waitFor(() => expect(sentTypes(alice.socket)).toContain('ready'));
    const fresh = issue('alice', alice.sessionId);
    alice.socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: fresh })));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(alice.socket.close).not.toHaveBeenCalled();
    alice.socket.close(1000);
    await alice.handled;
  });

  it('closes on a token of another browser session, another user or an invalid token', async () => {
    const { connect, issue } = harness();
    for (const token of [
      () => issue('alice', 'alice-other-session'),
      () => issue('bob', 'alice-session'),
      () => 'token-forged',
    ]) {
      const alice = await connect('alice');
      await vi.waitFor(() => expect(sentTypes(alice.socket)).toContain('ready'));
      alice.socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: token() })));
      await vi.waitFor(() => expect(alice.socket.close)
        .toHaveBeenCalledWith(CONSOLE_CLOSE_SESSION_REVOKED, 'session revoked'));
      await alice.handled;
    }
  });

  it('closes on a fresh token once the browser session is gone', async () => {
    const { browserSessions, connect, issue } = harness();
    const alice = await connect('alice');
    await vi.waitFor(() => expect(sentTypes(alice.socket)).toContain('ready'));
    const fresh = issue('alice', alice.sessionId);
    browserSessions.delete(alice.sessionId);
    alice.socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: fresh })));
    await vi.waitFor(() => expect(alice.socket.close)
      .toHaveBeenCalledWith(CONSOLE_CLOSE_SESSION_REVOKED, 'session revoked'));
    await alice.handled;
  });
});

describe('console bridge backpressure and error text', () => {
  it('closes the console instead of buffering output for a browser that does not read', async () => {
    const setup = harness();
    const stdout = new EventEmitter();
    setup.physical.sockets = { '1': stdout };
    const alice = await setup.connect('alice');
    await vi.waitFor(() => expect(sentTypes(alice.socket)).toContain('ready'));

    stdout.emit('message', Buffer.from('y\n'));
    expect(sentTypes(alice.socket)).toEqual(['ready', 'data']);

    alice.socket.bufferedAmount = MAX_CONSOLE_BUFFERED_BYTES;
    stdout.emit('message', Buffer.from('y\n'));
    expect(sentTypes(alice.socket)).toEqual(['ready', 'data']);
    expect(alice.socket.close).toHaveBeenCalledWith(CONSOLE_CLOSE_BACKPRESSURE, 'console output overflow');
    expect(setup.physical.close).toHaveBeenCalled();
    await alice.handled;
  });

  it('never sends internal error messages to the browser', async () => {
    const setup = harness();
    setup.sessions.openExec.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:8443'));
    const alice = await setup.connect('alice');
    await expect(alice.handled).rejects.toThrow('ECONNREFUSED');
    // The connection handler answers that rejection with the fixed text for its code.
    (setup.gateway as unknown as { sendError(socket: FakeSocket, code: string): void })
      .sendError(alice.socket, 'CONSOLE_BRIDGE_FAILED');
    const frames = alice.socket.send.mock.calls.map(([raw]) => String(raw));
    expect(frames.join('\n')).not.toContain('ECONNREFUSED');
    expect(JSON.parse(frames.at(-1)!)).toEqual({
      type: 'error',
      code: 'CONSOLE_BRIDGE_FAILED',
      message: 'The console connection failed',
    });
  });
});

describe('ConsoleSessionService revocation generation', () => {
  it('does not let a revoked user claim a session created before the revocation', async () => {
    const revocations = new SessionRevocationService();
    const ephemeral = new EphemeralStore();
    const service = new ConsoleSessionService({} as never, ephemeral, revocations);
    const sessionId = randomUUID();
    const session = {
      sessionId,
      actorId: 'alice',
      authVersion: 0,
      revocationGeneration: revocations.generation('alice'),
      state: 'unclaimed',
    };
    ephemeral.set(`console-session:${sessionId}`, JSON.stringify(session), 60_000);
    revocations.revoke('alice');

    await expect(service.claim(sessionId, 'alice', 0)).resolves.toBeNull();
    ephemeral.onApplicationShutdown();
  });
});
