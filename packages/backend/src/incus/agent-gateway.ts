import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type * as http from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import {
  AGENT_CONTROL_PATH,
  AGENT_HEARTBEAT_INTERVAL_MS,
  AGENT_STREAM_PATH,
  MAX_AGENT_CONTROL_FRAME_BYTES,
  MAX_AGENT_STREAM_FRAME_BYTES,
  zAgentHello,
} from '@nyabase/common';
import { AgentConnection } from './agent-connection.js';
import { AgentCredentialVerifier } from './agent-credentials.js';
import { AgentRegistry } from './agent-registry.service.js';

const HELLO_TIMEOUT_MS = 10_000;
const STREAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Accepts the WebSockets host agents dial: one control socket per server and
 * one stream socket per Incus WebSocket the Backend asked for. Both are
 * authenticated by the agent credential before the upgrade completes.
 */
@Injectable()
export class AgentGateway implements OnModuleDestroy {
  private readonly logger = new Logger(AgentGateway.name);
  private control?: WebSocketServer;
  private streams?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  private readonly alive = new WeakMap<WebSocket, boolean>();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly credentials: AgentCredentialVerifier,
  ) {}

  attachToHttpServer(server: http.Server): void {
    this.control = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_AGENT_CONTROL_FRAME_BYTES,
      perMessageDeflate: false,
    });
    this.streams = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_AGENT_STREAM_FRAME_BYTES,
      perMessageDeflate: false,
    });
    server.on('upgrade', (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = request.url?.split('?')[0];
      if (path !== AGENT_CONTROL_PATH && path !== AGENT_STREAM_PATH) return;
      void this.upgrade(request, socket, head, path).catch((error: unknown) => {
        this.logger.warn(`Agent upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
        socket.destroy();
      });
    });
    this.heartbeat = setInterval(() => this.pingAll(), AGENT_HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.control?.clients ?? []) socket.close(1001, 'backend stopping');
    for (const socket of this.streams?.clients ?? []) socket.close(1001, 'backend stopping');
    this.control?.close();
    this.streams?.close();
  }

  private async upgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    path: string,
  ): Promise<void> {
    // Node hands the raw socket over without an error listener; authentication
    // awaits the database, and a reset during that wait must not crash the process.
    const onSocketError = (): void => {
      socket.destroy();
    };
    socket.on('error', onSocketError);
    const serverId = await this.credentials.authenticate(request.headers.authorization);
    if (socket.destroyed) return;
    if (!serverId) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const streamId = new URL(request.url ?? '', 'http://agent').searchParams.get('id') ?? '';
    if (path === AGENT_STREAM_PATH && !STREAM_ID_PATTERN.test(streamId)) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // ws attaches its own socket error handling once the upgrade completes.
    socket.removeListener('error', onSocketError);
    if (path === AGENT_CONTROL_PATH) {
      this.control!.handleUpgrade(request, socket, head, (ws) => this.acceptControl(ws, serverId));
      return;
    }
    this.streams!.handleUpgrade(request, socket, head, (ws) => {
      this.watchLiveness(ws);
      ws.on('error', () => ws.terminate());
      if (!this.registry.streams.accept(streamId, serverId, ws)) {
        ws.close(1008, 'no pending stream');
      }
    });
  }

  private watchLiveness(ws: WebSocket): void {
    this.alive.set(ws, true);
    ws.on('pong', () => this.alive.set(ws, true));
    ws.on('ping', () => this.alive.set(ws, true));
  }

  private acceptControl(ws: WebSocket, serverId: string): void {
    this.watchLiveness(ws);
    ws.on('error', (error) => this.logger.warn(`Agent ${serverId} socket error: ${error.message}`));
    let connection: AgentConnection | undefined;
    const helloTimer = setTimeout(() => ws.close(1008, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'binary control frame');
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        ws.close(1008, 'malformed control frame');
        return;
      }
      if (!connection) {
        const hello = zAgentHello.safeParse(frame);
        if (!hello.success) {
          ws.close(1008, 'expected hello');
          return;
        }
        clearTimeout(helloTimer);
        connection = new AgentConnection(serverId, hello.data, ws, this.registry.streams);
        ws.send(JSON.stringify({ type: 'welcome', serverId }));
        this.registry.register(connection);
        this.logger.log(`Agent connected for server ${serverId} (${hello.data.hostname}, ${hello.data.agentVersion})`);
        return;
      }
      if (!connection.handleFrame(frame)) ws.close(1008, 'malformed control frame');
    });
    ws.once('close', () => {
      clearTimeout(helloTimer);
      if (connection) {
        this.registry.unregister(connection);
        this.logger.log(`Agent disconnected for server ${serverId}`);
      }
    });
  }

  /** Control and stream sockets alike: a peer that stops answering pings is dropped. */
  private pingAll(): void {
    for (const ws of [...(this.control?.clients ?? []), ...(this.streams?.clients ?? [])]) {
      if (this.alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      this.alive.set(ws, false);
      ws.ping();
    }
  }
}
