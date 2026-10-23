import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as http from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { AuthService } from '../iam/auth.service.js';
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

/** Browser-facing text per error code; internal error messages never leave the backend. */
const CONSOLE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  CONSOLE_BRIDGE_FAILED: 'The console connection failed',
  CONSOLE_SESSION_INVALID: 'Console session is invalid',
  CONSOLE_SESSION_REVOKED: 'The session was revoked',
  CONSOLE_FRAME_INVALID: 'Invalid console frame',
  CONSOLE_OUTPUT_OVERFLOW: 'The console output was not read fast enough; reconnect to continue',
};
/**
 * Close code sent when the user's sessions were revoked (disabled, deleted,
 * role changed, password changed or reset) while the console was open.
 */
export const CONSOLE_CLOSE_SESSION_REVOKED = 4401;

@Injectable()
export class ConsoleBridgeGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsoleBridgeGateway.name);
  private wss: WebSocketServer | null = null;
  private destroyed = false;
  /** Open (claimed) console sockets by user, closed on revocation. */
  private readonly openByUser = new Map<string, Set<WebSocket>>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly sessions: ConsoleSessionService,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
    private readonly revocations: SessionRevocationService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.revocations.subscribe((userId) => this.closeForUser(userId));
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
    const auth = await this.firstAuthFrame(socket);
    const user = await this.auth.validateAccessToken(auth);
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
    this.register(user.id, socket);
    let physical: IncusExecWebSocketSession | undefined;
    try {
      // A revocation between session creation and registration was missed by
      // the listener; the generation recorded at creation catches it.
      if (this.sessions.isRevoked(session)) {
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
      socket.on('message', (raw) => this.handleBrowserFrame(socket, physical!, raw));
      await closed;
    } finally {
      physical?.close();
      this.unregister(user.id, socket);
      this.sessions.release(sessionId);
    }
  }

  private register(userId: string, socket: WebSocket): void {
    const sockets = this.openByUser.get(userId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.openByUser.set(userId, sockets);
  }

  private unregister(userId: string, socket: WebSocket): void {
    const sockets = this.openByUser.get(userId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.openByUser.delete(userId);
  }

  private closeForUser(userId: string): void {
    for (const socket of this.openByUser.get(userId) ?? []) this.closeRevoked(socket);
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

  private handleBrowserFrame(
    browser: WebSocket,
    physical: IncusExecWebSocketSession,
    raw: RawData,
  ): void {
    let message: unknown;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      this.sendError(browser, 'CONSOLE_FRAME_INVALID');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const frame = message as Record<string, unknown>;
    if (frame.type === 'input' && typeof frame.data === 'string') {
      // Incus interactive exec websockets accept binary frames for stdin/stdout.
      // Text frames are ignored, which presents as a connected console that
      // cannot accept keyboard input.
      physical.sockets['0']?.send(Buffer.from(frame.data, 'utf8'));
      return;
    }
    if (
      frame.type === 'resize'
      && Number.isSafeInteger(frame.cols)
      && Number.isSafeInteger(frame.rows)
    ) {
      physical.sockets.control?.send(JSON.stringify({
        command: 'window-resize',
        args: [String(frame.cols), String(frame.rows)],
      }));
    }
  }

  private firstAuthFrame(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.removeAllListeners('message');
        reject(new Error('Console authentication timed out'));
      }, AUTH_TIMEOUT_MS);
      socket.once('message', (raw) => {
        clearTimeout(timeout);
        try {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (message.type !== 'auth' || typeof message.token !== 'string') {
            throw new Error('Console authentication frame is invalid');
          }
          resolve(message.token);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private sessionId(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null;
    const url = new URL(rawUrl, 'http://console.invalid');
    const sessionId = url.searchParams.get('sessionId');
    return sessionId && /^[0-9a-f-]{36}$/i.test(sessionId) ? sessionId : null;
  }

  private sendError(socket: WebSocket, code: keyof typeof CONSOLE_ERROR_MESSAGES): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_CONSOLE_BUFFERED_BYTES) return;
    socket.send(JSON.stringify({
      type: 'error',
      code,
      message: CONSOLE_ERROR_MESSAGES[code] ?? 'Console error',
    }));
  }
}
