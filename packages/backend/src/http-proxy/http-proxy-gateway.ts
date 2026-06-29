import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as http from 'http';
import { createHash } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  zEnvelope,
  zHttpProxyClientAck,
  zHttpProxyStatusReport,
  type HttpProxyBackendMessage,
  type HttpProxyStatusReport,
} from '@nyabase/common';
import { HttpProxyService } from './http-proxy.service.js';

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 2_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

@Injectable()
export class HttpProxyGateway implements OnModuleDestroy {
  private readonly logger = new Logger(HttpProxyGateway.name);
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private latestStatus = new Map<WebSocket, HttpProxyStatusReport>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private maxWaitTimer: NodeJS.Timeout | null = null;
  private pendingReason: string | null = null;

  constructor(private service: HttpProxyService) {}

  attachToHttpServer(server: http.Server): void {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
      if (req.url?.split('?')[0] !== '/ws/http-proxy') return;
      this.wss!.handleUpgrade(req, socket as import('stream').Duplex, head, (ws) => {
        this.wss!.emit('connection', ws, req);
      });
    });
    this.wss.on('connection', (ws, req) => {
      void this.handleConnection(ws, req);
    });
    this.logger.log('HTTP proxy WebSocket gateway ready at /ws/http-proxy');
  }

  onModuleDestroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.latestStatus.clear();
    this.wss?.close();
  }

  isOnline(): boolean {
    return this.clients.size > 0;
  }

  scheduleBroadcast(reason: string): void {
    this.pendingReason = this.pendingReason ? `${this.pendingReason},${reason}` : reason;
    if (this.clients.size === 0) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flushBroadcast(), DEBOUNCE_MS);
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => void this.flushBroadcast(), MAX_WAIT_MS);
    }
  }

  async broadcastSnapshot(): Promise<void> {
    if (this.clients.size === 0) return;
    await this.flushBroadcast();
  }

  getStatus() {
    const proxies = Array.from(this.latestStatus.values()).sort((a, b) => a.proxyId.localeCompare(b.proxyId));
    const last = proxies
      .flatMap((proxy) => [proxy.connectedAt, proxy.lastSnapshotAt ?? 0])
      .filter((value) => value > 0)
      .sort((a, b) => b - a)[0];
    return {
      connectedProxies: this.clients.size,
      activeConnections: proxies.reduce((sum, proxy) => sum + proxy.activeConnections, 0),
      totalRequests: proxies.reduce((sum, proxy) => sum + proxy.totalRequests, 0),
      totalRejectedRequests: proxies.reduce((sum, proxy) => sum + proxy.totalRejectedRequests, 0),
      updatedAt: last ? new Date(last).toISOString() : null,
      proxies,
    };
  }

  private async flushBroadcast(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
    const reason = this.pendingReason;
    this.pendingReason = null;
    if (this.clients.size === 0) return;
    const snapshot = await this.service.buildSnapshot();
    this.logger.debug(`Broadcasting HTTP proxy snapshot generation=${snapshot.generation} reason=${reason ?? 'manual'}`);
    this.broadcast({ kind: 'update', payload: snapshot });
  }

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    if (!this.authorize(req)) {
      ws.close(4003, 'Invalid token');
      return;
    }
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
      this.latestStatus.delete(ws);
    });
    ws.on('error', (error) => this.logger.warn(`HTTP proxy WS error: ${error.message}`));
    ws.on('message', (raw) => this.handleMessage(ws, raw.toString()));
    ws.send(JSON.stringify({
      ts: Date.now(),
      kind: 'snapshot',
      payload: await this.service.buildSnapshot(),
    }));
  }

  private authorize(req: http.IncomingMessage): boolean {
    const expected = process.env.NYABASE_HTTP_PROXY_TOKEN ?? process.env.HTTP_PROXY_TOKEN ?? '';
    if (!expected) return process.env.NODE_ENV !== 'production';
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const queryToken = typeof req.url === 'string'
      ? new URL(req.url, 'http://localhost').searchParams.get('token') ?? ''
      : '';
    const token = bearer || queryToken;
    return token.length > 0 && this.hash(token) === this.hash(expected);
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    const parsed = zEnvelope.safeParse(this.parseJson(raw));
    if (!parsed.success) {
      this.logger.warn('Invalid HTTP proxy envelope');
      return;
    }
    if (parsed.data.kind === 'ack') {
      const ack = zHttpProxyClientAck.safeParse(parsed.data.payload);
      if (ack.success) this.logger.debug(`HTTP proxy acknowledged generation ${ack.data.generation}`);
      return;
    }
    if (parsed.data.kind === 'status') {
      const status = zHttpProxyStatusReport.safeParse(parsed.data.payload);
      if (status.success) this.latestStatus.set(ws, status.data);
    }
  }

  private broadcast(message: HttpProxyBackendMessage): void {
    const encoded = JSON.stringify({ ts: Date.now(), ...message });
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.logger.warn(`HTTP proxy client skipped because bufferedAmount=${client.bufferedAmount}`);
        continue;
      }
      client.send(encoded);
    }
  }

  private parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
