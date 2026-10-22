import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SessionRevocationService } from '../iam/session-revocation.service.js';
import { CONSOLE_CLOSE_SESSION_REVOKED, ConsoleBridgeGateway } from './console-bridge.gateway.js';
import { EphemeralStore } from '../platform/ephemeral-store.js';
import { ConsoleSessionService, type ConsoleSession } from './console-session.service.js';

const OPEN = 1;
const CLOSED = 3;

class FakeSocket extends EventEmitter {
  readyState = OPEN;
  readonly send = vi.fn();
  readonly close = vi.fn((_code?: number) => {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    queueMicrotask(() => this.emit('close'));
  });
}

function harness() {
  const revocations = new SessionRevocationService();
  const physical = { sockets: {}, close: vi.fn() };
  const users = new Map<string, { id: string; authVersion: number }>();
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
  const auth = { validateAccessToken: vi.fn(async (token: string) => users.get(token)) };
  const gateway = new ConsoleBridgeGateway(
    auth as never,
    sessions as never,
    { get: vi.fn(async () => ({})) } as never,
    revocations,
  );
  gateway.onModuleInit();

  async function connect(userId: string) {
    users.set(`token-${userId}`, { id: userId, authVersion: 0 });
    const socket = new FakeSocket();
    const handled = (gateway as unknown as {
      handle(socket: FakeSocket, request: { url: string }): Promise<void>;
    }).handle(socket, { url: `/ws/console?sessionId=${randomUUID()}` });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: `token-${userId}` })));
    return { socket, handled };
  }

  return { gateway, revocations, physical, sessions, generationAtCreate, connect };
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
