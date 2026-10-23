import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type * as http from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import {
  AGENT_CLOSE_PROTOCOL_UNSUPPORTED,
  AGENT_CONTROL_PATH,
  AGENT_HEARTBEAT_INTERVAL_MS,
  AGENT_PROTOCOL_VERSION,
  MAX_AGENT_HELLO_FRAME_BYTES,
  AGENT_STREAM_PATH,
  MAX_AGENT_CONTROL_FRAME_BYTES,
  MAX_AGENT_STREAM_FRAME_BYTES,
  zAgentHello,
} from '@nyabase/common';
import { AgentConnection } from './agent-connection.js';
import { AgentCredentialVerifier, AgentUpgradeAdmissions, type TrustProxy } from './agent-credentials.js';
import { AGENT_CLOSE_CREDENTIAL_REJECTED, AgentRegistry } from './agent-registry.service.js';

const HELLO_TIMEOUT_MS = 10_000;
const STREAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFUSALS = {
  429: 'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
  503: 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
} as const;

export interface AgentGatewayOptions {
  /** Express' `trust proxy fn`, so a client behind the TLS edge is limited by its own address. */
  readonly trustProxy?: TrustProxy;
}

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
  private admissions = new AgentUpgradeAdmissions();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly credentials: AgentCredentialVerifier,
  ) {}

  attachToHttpServer(server: http.Server, options: AgentGatewayOptions = {}): void {
    this.admissions = new AgentUpgradeAdmissions(options.trustProxy);
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
    // Each credential check costs a database query: bound them before anyone is authenticated.
    const admission = this.admissions.admit(request);
    if (admission.refused) {
      socket.end(REFUSALS[admission.refused]);
      return;
    }
    let serverId: string | undefined;
    try {
      serverId = await this.credentials.authenticate(request.headers.authorization);
    } finally {
      admission.settle(serverId !== undefined);
    }
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
      const authorization = request.headers.authorization;
      this.control!.handleUpgrade(request, socket, head, (ws) => this.acceptControl(ws, serverId, authorization));
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

  /**
   * hello → re-verify the credential (it may have been rotated, or the server
   * deleted, while this socket was upgrading) → welcome and register. Until
   * registered the socket is tracked so AgentRegistry.disconnect reaches it.
   */
  private acceptControl(ws: WebSocket, serverId: string, authorization: string | undefined): void {
    this.watchLiveness(ws);
    ws.on('error', (error) => this.logger.warn(`Agent ${serverId} socket error: ${error.message}`));
    let connection: AgentConnection | undefined;
    let verifying = false;
    const untrack = this.registry.trackPending(serverId, ws);
    const helloTimer = setTimeout(() => ws.close(1008, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'binary control frame');
        return;
      }
      // Sized before parsing: a frame nobody asked for is not worth parsing.
      if (connection ? !connection.admits(frameBytes(data)) : frameBytes(data) > MAX_AGENT_HELLO_FRAME_BYTES) {
        ws.close(1009, 'unsolicited oversized frame');
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        ws.close(1008, 'malformed control frame');
        return;
      }
      if (connection) {
        if (!connection.handleFrame(frame)) ws.close(1008, 'malformed control frame');
        return;
      }
      const refusal = verifying ? undefined : unsupportedProtocol(frame);
      if (refusal) {
        ws.close(AGENT_CLOSE_PROTOCOL_UNSUPPORTED, refusal.slice(0, 120));
        this.logger.warn(`Agent for server ${serverId} refused: ${refusal}`);
        this.registry.refuse(serverId, refusal);
        return;
      }
      const hello = verifying ? undefined : zAgentHello.safeParse(frame);
      if (!hello?.success) {
        ws.close(1008, verifying ? 'frame before welcome' : 'expected hello');
        return;
      }
      verifying = true;
      void this.credentials.confirmControl(serverId, authorization).then((valid) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!valid) {
          ws.close(AGENT_CLOSE_CREDENTIAL_REJECTED, 'credential revoked');
          return;
        }
        clearTimeout(helloTimer);
        untrack();
        connection = new AgentConnection(
          serverId,
          hello.data,
          ws,
          this.registry.streams,
          (current) => this.registry.statusChanged(current),
        );
        ws.send(JSON.stringify({ type: 'welcome', serverId }));
        this.registry.register(connection);
        this.logger.log(`Agent connected for server ${serverId} (${hello.data.hostname}, ${hello.data.agentVersion})`);
        if (!hello.data.status.ipv6Guard.present) {
          this.logger.warn(`Agent for server ${serverId} has no IPv6 guard: ${hello.data.status.ipv6Guard.error ?? 'unknown'}`);
        }
      }, (error: unknown) => {
        this.logger.warn(`Agent ${serverId} credential check failed: ${error instanceof Error ? error.message : String(error)}`);
        ws.close(1011, 'credential check failed');
      });
    });
    ws.once('close', () => {
      clearTimeout(helloTimer);
      untrack();
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

function frameBytes(data: WebSocket.RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  return data.byteLength;
}

/**
 * Why a hello from another agent build is refused, or undefined when the
 * frame claims this Backend's protocol (or is no hello at all).
 */
export function unsupportedProtocol(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined;
  const { type, protocol, agentVersion } = frame as Record<string, unknown>;
  if (type !== 'hello' || protocol === AGENT_PROTOCOL_VERSION) return undefined;
  const build = typeof agentVersion === 'string' ? ` ${agentVersion.slice(0, 64)}` : '';
  return `nyabase-agent${build} speaks protocol ${String(protocol).slice(0, 16)}; `
    + `this Backend requires protocol ${AGENT_PROTOCOL_VERSION}. Upgrade the agent on this host`;
}
