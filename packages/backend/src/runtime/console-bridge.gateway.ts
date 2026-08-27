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
import { AuthService } from '../auth/auth.service.js';
import {
  CONSOLE_BRIDGE,
  type ConsoleBridgePort,
} from './console-bridge.port.js';
import {
  INCUS_CLIENT_FACTORY,
  type IncusClientFactory,
} from './reconcile-worker.service.js';
import { ConsoleSessionService, type ConsoleSession } from './console-session.service.js';

const MAX_CONSOLE_FRAME_BYTES = 256 * 1024;
const AUTH_TIMEOUT_MS = 10_000;

@Injectable()
export class ConsoleBridgeGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsoleBridgeGateway.name);
  private wss: WebSocketServer | null = null;
  private destroyed = false;

  constructor(
    private readonly auth: AuthService,
    private readonly sessions: ConsoleSessionService,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
    @Inject(CONSOLE_BRIDGE) private readonly bridge: ConsoleBridgePort,
  ) {}

  onModuleInit(): void {}

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
      await this.sessions.release(sessionId);
      socket.close(1012);
      return;
    }
    let physical: Awaited<ReturnType<ConsoleBridgePort['open']>> | undefined;
    try {
      const client = await this.clients.get(session.serverId);
      physical = await this.bridge.open(client, session.instanceName, session.command, {
        width: session.cols,
        height: session.rows,
        tty: session.tty,
      });
      socket.send(JSON.stringify({ type: 'ready' }));
      this.pipePhysical(socket, physical, session);
      socket.on('message', (raw) => this.handleBrowserFrame(socket, physical!, raw));
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
      });
    } finally {
      physical?.close();
      await this.sessions.release(sessionId);
    }
  }

  private pipePhysical(
    browser: WebSocket,
    physical: Awaited<ReturnType<ConsoleBridgePort['open']>>,
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
    physical: Awaited<ReturnType<ConsoleBridgePort['open']>>,
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
