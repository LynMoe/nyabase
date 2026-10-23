import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import * as http from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { ConsoleToBrowser } from '@nyabase/common';
import { type AccessCredential, AuthService } from '../iam/auth.service.js';
import { SessionRevocationService } from '../iam/session-revocation.service.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import type { IncusExecWebSocketSession } from '../incus/index.js';
import { ConsoleSessionService, type ConsoleSession } from './console-session.service.js';

const MAX_CONSOLE_FRAME_BYTES = 256 * 1024;
const AUTH_TIMEOUT_MS = 10_000;
/**
 * Output queued towards a browser that does not read (e.g. `yes` with the tab
 * stalled). The Incus exec stream cannot be paused through the agent tunnel, so
 * past this cap the console is closed instead of buffering without bound.
 */
export const MAX_CONSOLE_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Close code sent when the browser fell too far behind the console output. */
export const CONSOLE_CLOSE_BACKPRESSURE = 4413;
const CLOSE_GRACE_MS = 1_000;
/**
 * The browser is asked for a fresh access token this long before the console's
 * authority runs out (a quarter of what is left, within these bounds).
 */
const REAUTH_LEAD_MIN_MS = 5_000;
const REAUTH_LEAD_MAX_MS = 60_000;
/**
 * A fresh token whose check fails for a reason other than authentication (a
 * database stall) is checked again after these delays, while the current
 * deadline still holds; the console is never revoked for such a failure.
 */
const REAUTH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
/** Close code sent when more input arrived before the exec stream opened than is held. */
export const CONSOLE_CLOSE_INPUT_OVERFLOW = 1009;

/** Browser-facing text per error code; internal error messages never leave the backend. */
const CONSOLE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  CONSOLE_BRIDGE_FAILED: 'The console connection failed',
  CONSOLE_SESSION_INVALID: 'Console session is invalid',
  CONSOLE_SESSION_REVOKED: 'The session was revoked',
  CONSOLE_AUTH_EXPIRED: 'The console was not re-authenticated before its credential expired',
  CONSOLE_FRAME_INVALID: 'Invalid console frame',
  CONSOLE_OUTPUT_OVERFLOW: 'The console output was not read fast enough; reconnect to continue',
  CONSOLE_INPUT_OVERFLOW: 'More console input arrived than the console holds; reconnect to continue',
};
/**
 * Close code sent when the browser session that authorized the console ended
 * (logout, refresh-token reuse) or all of the user's sessions were revoked
 * (disabled, deleted, role changed, password changed or reset), or a
 * re-authentication was refused.
 */
export const CONSOLE_CLOSE_SESSION_REVOKED = 4401;
/** Close code sent when no fresh access token arrived before the current one expired. */
export const CONSOLE_CLOSE_AUTH_EXPIRED = 4408;

/**
 * An open console and the browser session it is bound to. Its authority lasts
 * until `deadline` (token expiry, session expiry); every fresh access token of
 * the same session moves it after re-checking the session row.
 */
interface ConsoleConnection {
  readonly socket: WebSocket;
  readonly userId: string;
  readonly browserSessionId: string;
  /** Epoch ms; 0 until the first authorization. */
  deadline: number;
  deadlineTimer: NodeJS.Timeout | null;
  promptTimer: NodeJS.Timeout | null;
  /** Re-authentications run one at a time, in arrival order. */
  reauth: Promise<void>;
}

/** Browser frames bound for the exec stream. */
type ConsoleExecFrame =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number };

/**
 * Input / resize frames sent before the exec stream is open are held, up to
 * this many bytes, and replayed once it is; past it the console closes instead
 * of dropping keys.
 */
export const MAX_CONSOLE_PENDING_INPUT_BYTES = 256 * 1024;

interface ConsoleFrameEvents {
  /** A frame that is not JSON. */
  invalid(): void;
  /** More input arrived before the exec stream opened than is held. */
  overflow(): void;
}

/**
 * The single `message` listener of a console socket, attached as the socket
 * opens and kept for its whole life, so no frame falls between phases. The
 * first frame must be `auth` and resolves `firstAuth`; later `auth` frames go
 * to the re-authentication handler and `input` / `resize` to the exec stream,
 * each held until its handler is attached: a re-authentication prompt can be
 * answered while the console is still being authorized or the exec opened.
 */
class ConsoleFrameDispatcher {
  readonly firstAuth: Promise<string>;
  private awaitingFirst: {
    resolve(token: string): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  } | null = null;
  private authHandler: ((token: string) => void) | null = null;
  /** Only the newest token counts; an older one would be superseded anyway. */
  private pendingToken: string | null = null;
  private execHandler: ((frame: ConsoleExecFrame) => void) | null = null;
  private pendingExec: ConsoleExecFrame[] = [];
  private pendingExecBytes = 0;

  constructor(socket: WebSocket, private readonly events: ConsoleFrameEvents, authTimeoutMs: number) {
    this.firstAuth = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.awaitingFirst = null;
        reject(new Error('Console authentication timed out'));
      }, authTimeoutMs);
      this.awaitingFirst = { resolve, reject, timer };
    });
    // A failed first frame is reported through `firstAuth` only.
    this.firstAuth.catch(() => undefined);
    socket.on('message', (raw) => this.dispatch(raw));
  }

  /** Route later `auth` frames (and one already received) to `handler`. */
  onAuth(handler: (token: string) => void): void {
    this.authHandler = handler;
    const token = this.pendingToken;
    this.pendingToken = null;
    if (token !== null) handler(token);
  }

  /** Route exec frames (and those held so far, in order) to `handler`. */
  onExec(handler: (frame: ConsoleExecFrame) => void): void {
    this.execHandler = handler;
    const held = this.pendingExec;
    this.pendingExec = [];
    this.pendingExecBytes = 0;
    for (const frame of held) handler(frame);
  }

  private dispatch(raw: RawData): void {
    const text = raw.toString();
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      if (!this.failFirst('Console authentication frame is invalid')) this.events.invalid();
      return;
    }
    const frame = message && typeof message === 'object' && !Array.isArray(message)
      ? message as Record<string, unknown>
      : {};
    const token = frame.type === 'auth' && typeof frame.token === 'string' ? frame.token : null;
    if (this.awaitingFirst) {
      if (token === null) {
        this.failFirst('Console authentication frame is invalid');
        return;
      }
      const first = this.awaitingFirst;
      this.awaitingFirst = null;
      clearTimeout(first.timer);
      first.resolve(token);
      return;
    }
    if (token !== null) {
      if (this.authHandler) this.authHandler(token);
      else this.pendingToken = token;
      return;
    }
    const exec = execFrame(frame);
    if (!exec) return;
    if (this.execHandler) {
      this.execHandler(exec);
      return;
    }
    this.pendingExecBytes += Buffer.byteLength(text);
    if (this.pendingExecBytes > MAX_CONSOLE_PENDING_INPUT_BYTES) {
      this.pendingExec = [];
      this.pendingExecBytes = 0;
      this.events.overflow();
      return;
    }
    this.pendingExec.push(exec);
  }

  /** True when the frame was the (failed) first one. */
  private failFirst(reason: string): boolean {
    const first = this.awaitingFirst;
    if (!first) return false;
    this.awaitingFirst = null;
    clearTimeout(first.timer);
    first.reject(new Error(reason));
    return true;
  }
}

function execFrame(frame: Record<string, unknown>): ConsoleExecFrame | null {
  if (frame.type === 'input' && typeof frame.data === 'string') {
    return { type: 'input', data: frame.data };
  }
  if (
    frame.type === 'resize'
    && Number.isSafeInteger(frame.cols)
    && Number.isSafeInteger(frame.rows)
  ) {
    return { type: 'resize', cols: frame.cols as number, rows: frame.rows as number };
  }
  return null;
}

@Injectable()
export class ConsoleBridgeGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsoleBridgeGateway.name);
  private wss: WebSocketServer | null = null;
  private destroyed = false;
  /** Open (claimed) consoles by user, closed on revocation or when their session ends. */
  private readonly openByUser = new Map<string, Set<ConsoleConnection>>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly sessions: ConsoleSessionService,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
    private readonly revocations: SessionRevocationService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.revocations.subscribe(
      (userId, sessionId) => this.closeForSession(userId, sessionId),
    );
  }

  attachToHttpServer(server: http.Server): void {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CONSOLE_FRAME_BYTES,
      perMessageDeflate: false,
    });
    server.on('upgrade', (request, socket, head) => {
      const path = request.url?.split('?')[0] ?? '';
      if (path !== '/ws/console') return;
      this.wss?.handleUpgrade(request, socket, head, (client) => {
        this.wss?.emit('connection', client, request);
      });
    });
    this.wss.on('connection', (socket, request) => {
      socket.on('error', (error) => this.logger.warn(`Console bridge error: ${error.message}`));
      void this.handle(socket, request).catch((error: unknown) => {
        this.logger.warn(`Console bridge failed: ${error instanceof Error ? error.message : String(error)}`);
        this.sendError(socket, 'CONSOLE_BRIDGE_FAILED');
        socket.close(1011);
      });
    });
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.wss?.close();
    this.wss = null;
  }

  private async handle(socket: WebSocket, request: http.IncomingMessage): Promise<void> {
    const sessionId = this.sessionId(request.url);
    if (!sessionId) {
      socket.close(1008);
      return;
    }
    // The socket's only message listener, from now until it closes.
    const frames = new ConsoleFrameDispatcher(socket, {
      invalid: () => this.sendError(socket, 'CONSOLE_FRAME_INVALID'),
      overflow: () => {
        this.sendError(socket, 'CONSOLE_INPUT_OVERFLOW');
        socket.close(CONSOLE_CLOSE_INPUT_OVERFLOW, 'console input overflow');
      },
    }, AUTH_TIMEOUT_MS);
    const auth = await frames.firstAuth;
    const credential = await this.auth.validateAccessToken(auth);
    const { user } = credential;
    const session = await this.sessions.claim(sessionId, user.id, user.authVersion);
    if (!session) {
      this.sendError(socket, 'CONSOLE_SESSION_INVALID');
      socket.close(1008);
      return;
    }
    if (this.destroyed) {
      this.sessions.release(sessionId);
      socket.close(1012);
      return;
    }
    // Armed before any further await so an early close is never missed.
    const closed = new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) resolve();
      else socket.once('close', () => resolve());
    });
    // Registered before the session row is read: a logout committing after
    // that read reaches this console through the listener.
    const connection = this.register(socket, credential);
    frames.onAuth((token) => this.reauthenticate(connection, token));
    let physical: IncusExecWebSocketSession | undefined;
    try {
      // A revocation between session creation and registration was missed by
      // the listener; the generation recorded at creation catches it.
      if (this.sessions.isRevoked(session) || !(await this.authorize(connection, credential))) {
        this.closeRevoked(socket);
        return;
      }
      const client = await this.clients.get(session.serverId);
      physical = await this.sessions.openExec(client, session.instanceName, session.command, {
        width: session.cols,
        height: session.rows,
        tty: session.tty,
      });
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'ready' }));
      this.pipePhysical(socket, physical, session);
      const exec = physical;
      frames.onExec((frame) => this.forwardToExec(exec, frame));
      await closed;
    } finally {
      physical?.close();
      this.unregister(connection);
      this.sessions.release(sessionId);
    }
  }

  private register(socket: WebSocket, credential: AccessCredential): ConsoleConnection {
    const connection: ConsoleConnection = {
      socket,
      userId: credential.user.id,
      browserSessionId: credential.sessionId,
      deadline: 0,
      deadlineTimer: null,
      promptTimer: null,
      reauth: Promise.resolve(),
    };
    const connections = this.openByUser.get(connection.userId) ?? new Set<ConsoleConnection>();
    connections.add(connection);
    this.openByUser.set(connection.userId, connections);
    return connection;
  }

  private unregister(connection: ConsoleConnection): void {
    this.clearTimers(connection);
    const connections = this.openByUser.get(connection.userId);
    if (!connections) return;
    connections.delete(connection);
    if (connections.size === 0) this.openByUser.delete(connection.userId);
  }

  /** `sessionId` undefined: every session of the user was revoked. */
  private closeForSession(userId: string, sessionId?: string): void {
    for (const connection of this.openByUser.get(userId) ?? []) {
      if (sessionId === undefined || connection.browserSessionId === sessionId) {
        this.closeRevoked(connection.socket);
      }
    }
  }

  /**
   * Check that `credential`'s browser session is still live and arm the
   * console's deadline from it. False: the session is gone. The browser is
   * asked for a fresh token only when one can move the deadline: not once it
   * is the session's absolute end, nor when the last token did not move it.
   */
  private async authorize(connection: ConsoleConnection, credential: AccessCredential): Promise<boolean> {
    if (
      credential.user.id !== connection.userId
      || credential.sessionId !== connection.browserSessionId
    ) return false;
    const deadline = await this.auth.browserSessionDeadline(credential);
    // Closed meanwhile: arm nothing for a console that is already gone.
    if (!deadline || connection.socket.readyState !== WebSocket.OPEN) return false;
    const at = deadline.at.getTime();
    const extended = at > connection.deadline;
    this.clearTimers(connection);
    connection.deadline = at;
    if (deadline.renewable && extended) {
      const remainingMs = at - Date.now();
      const leadMs = Math.min(REAUTH_LEAD_MAX_MS, Math.max(REAUTH_LEAD_MIN_MS, remainingMs / 4));
      connection.promptTimer = this.timerAt(at - leadMs, () => {
        connection.promptTimer = null;
        this.send(connection.socket, { type: 'reauthenticate' });
      });
    }
    connection.deadlineTimer = this.timerAt(at, () => {
      connection.deadlineTimer = null;
      this.closeExpired(connection.socket);
    });
    return true;
  }

  /**
   * A fresh access token from the browser. It must name the same user and
   * browser session, and that session must still be live; otherwise the
   * console closes now instead of at the old deadline.
   */
  private reauthenticate(connection: ConsoleConnection, token: string): void {
    connection.reauth = connection.reauth
      .then(() => this.checkFreshToken(connection, token))
      .catch((error: unknown) => {
        // Not an authentication verdict: the current deadline still holds.
        this.logger.warn(`Console re-authentication failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /**
   * Only an authentication verdict (invalid token, another user or session,
   * session gone) revokes the console. Any other failure (a database stall)
   * keeps the current deadline and checks the same token again while that
   * deadline leaves time to; the console then lapses at it like an unanswered
   * prompt instead of being reported as logged out.
   */
  private async checkFreshToken(connection: ConsoleConnection, token: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (connection.socket.readyState !== WebSocket.OPEN) return;
      try {
        const credential = await this.auth.validateAccessToken(token);
        if (!(await this.authorize(connection, credential))) this.closeRevoked(connection.socket);
        return;
      } catch (error) {
        if (error instanceof UnauthorizedException) {
          this.closeRevoked(connection.socket);
          return;
        }
        const delayMs = REAUTH_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined || Date.now() + delayMs >= connection.deadline) throw error;
        this.logger.warn(`Console re-authentication check failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs).unref?.();
        });
      }
    }
  }

  /** Deadlines are bounded by the access-token lifetime (at most 24 h), well within setTimeout's range. */
  private timerAt(at: number, fire: () => void): NodeJS.Timeout {
    const timer = setTimeout(fire, Math.max(0, at - Date.now()));
    timer.unref?.();
    return timer;
  }

  private clearTimers(connection: ConsoleConnection): void {
    if (connection.promptTimer) clearTimeout(connection.promptTimer);
    if (connection.deadlineTimer) clearTimeout(connection.deadlineTimer);
    connection.promptTimer = null;
    connection.deadlineTimer = null;
  }

  private closeExpired(socket: WebSocket): void {
    this.sendError(socket, 'CONSOLE_AUTH_EXPIRED');
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(CONSOLE_CLOSE_AUTH_EXPIRED, 'console credential expired');
    }
  }

  private closeRevoked(socket: WebSocket): void {
    this.sendError(socket, 'CONSOLE_SESSION_REVOKED');
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(CONSOLE_CLOSE_SESSION_REVOKED, 'session revoked');
    }
  }

  private pipePhysical(
    browser: WebSocket,
    physical: IncusExecWebSocketSession,
    _session: ConsoleSession,
  ): void {
    for (const [fd, socket] of Object.entries(physical.sockets)) {
      if (!socket) continue;
      socket.on('message', (data: unknown) => {
        if (browser.readyState !== WebSocket.OPEN) return;
        const text = Buffer.isBuffer(data)
          ? data.toString('utf8')
          : typeof data === 'string'
            ? data
            : String(data);
        this.sendBounded(browser, physical, JSON.stringify({
          type: 'data',
          data: text,
          stderr: fd === '2',
        }));
      });
      socket.on('close', () => {
        if (browser.readyState === WebSocket.OPEN) {
          this.sendBounded(browser, physical, JSON.stringify({ type: 'eof', exitCode: null }));
        }
      });
      socket.on('error', (error: unknown) => {
        this.logger.warn(`Incus console fd error: ${String(error)}`);
        if (browser.readyState === WebSocket.OPEN) browser.close(1011);
      });
    }
  }

  /**
   * Send console output unless the browser has fallen behind by more than the
   * cap; then stop the exec stream and close the console with a clear code.
   */
  private sendBounded(
    browser: WebSocket,
    physical: IncusExecWebSocketSession,
    encoded: string,
  ): void {
    if (browser.readyState !== WebSocket.OPEN) return;
    if (browser.bufferedAmount + Buffer.byteLength(encoded) > MAX_CONSOLE_BUFFERED_BYTES) {
      this.logger.warn(`Console closed for backpressure; bufferedAmount=${browser.bufferedAmount}`);
      physical.close();
      browser.close(CONSOLE_CLOSE_BACKPRESSURE, 'console output overflow');
      // The close frame queues behind the unread output; do not wait on a stalled reader.
      setTimeout(() => {
        if (browser.readyState !== WebSocket.CLOSED) browser.terminate();
      }, CLOSE_GRACE_MS).unref?.();
      return;
    }
    browser.send(encoded);
  }

  private forwardToExec(physical: IncusExecWebSocketSession, frame: ConsoleExecFrame): void {
    if (frame.type === 'input') {
      // Incus interactive exec websockets accept binary frames for stdin/stdout.
      // Text frames are ignored, which presents as a connected console that
      // cannot accept keyboard input.
      physical.sockets['0']?.send(Buffer.from(frame.data, 'utf8'));
      return;
    }
    physical.sockets.control?.send(JSON.stringify({
      command: 'window-resize',
      args: [String(frame.cols), String(frame.rows)],
    }));
  }

  private sessionId(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null;
    const url = new URL(rawUrl, 'http://console.invalid');
    const sessionId = url.searchParams.get('sessionId');
    return sessionId && /^[0-9a-f-]{36}$/i.test(sessionId) ? sessionId : null;
  }

  private sendError(socket: WebSocket, code: keyof typeof CONSOLE_ERROR_MESSAGES): void {
    this.send(socket, {
      type: 'error',
      code,
      message: CONSOLE_ERROR_MESSAGES[code] ?? 'Console error',
    });
  }

  /** Control frames; a browser this far behind is about to be closed for backpressure anyway. */
  private send(socket: WebSocket, frame: ConsoleToBrowser): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_CONSOLE_BUFFERED_BYTES) return;
    socket.send(JSON.stringify(frame));
  }
}
