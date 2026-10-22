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
        this.sendError(socket, 'CONSOLE_BRIDGE_FAILED', error);
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
      this.sendError(socket, 'CONSOLE_SESSION_INVALID', new Error('Console session is invalid'));
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
    this.sendError(socket, 'CONSOLE_SESSION_REVOKED', new Error('The session was revoked'));
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
        browser.send(JSON.stringify({
          type: 'data',
          data: text,
          stderr: fd === '2',
        }));
      });
      socket.on('close', () => {
        if (browser.readyState === WebSocket.OPEN) {
          browser.send(JSON.stringify({ type: 'eof', exitCode: null }));
        }
      });
      socket.on('error', (error: unknown) => {
        this.logger.warn(`Incus console fd error: ${String(error)}`);
        if (browser.readyState === WebSocket.OPEN) browser.close(1011);
      });
    }
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
      this.sendError(browser, 'CONSOLE_FRAME_INVALID', new Error('Invalid console frame'));
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

  private sendError(socket: WebSocket, code: string, error: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'error',
      code,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}
