import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import * as http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { Repository } from 'typeorm';
import {
  zEnvelope,
  zSshProxyAuditEvent,
  zSshProxyClientAck,
  zSshProxyDisconnectAllResult,
  zSshProxyMetric,
  zSshProxyStatusReport,
  type SshProxyBackendMessage,
  type SshProxyStatusReport,
} from '@nyabase/common';
import { SshProxyTokenEntity } from '../entities/ssh-proxy-token.entity.js';
import { SshProxySnapshotService } from './ssh-proxy-snapshot.service.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

@Injectable()
export class SshProxyGateway implements OnModuleDestroy {
  private readonly logger = new Logger(SshProxyGateway.name);
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private latestStatus = new Map<WebSocket, SshProxyStatusReport>();
  private pendingDisconnectAll = new Map<string, {
    expected: number;
    replies: number;
    disconnected: number;
    timeout: NodeJS.Timeout;
    resolve: (result: { requestId: string; requested: number; disconnected: number }) => void;
  }>();

  constructor(
    @InjectRepository(SshProxyTokenEntity)
    private tokensRepo: Repository<SshProxyTokenEntity>,
    private snapshots: SshProxySnapshotService,
    private config: NyabaseConfigService,
  ) {}

  attachToHttpServer(server: http.Server): void {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
      if (req.url?.split('?')[0] !== '/ws/ssh-proxy') return;
      this.wss!.handleUpgrade(req, socket as import('stream').Duplex, head, (ws) => {
        this.wss!.emit('connection', ws, req);
      });
    });
    this.wss.on('connection', (ws, req) => {
      void this.handleConnection(ws, req);
    });
    this.logger.log('SSH proxy WebSocket gateway ready at /ws/ssh-proxy');
  }

  onModuleDestroy(): void {
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.latestStatus.clear();
    this.wss?.close();
  }

  async broadcastSnapshot(): Promise<void> {
    if (this.clients.size === 0) return;
    const snapshot = await this.snapshots.buildSnapshot();
    this.broadcast({ kind: 'update', payload: snapshot });
  }

  async ensureToken(): Promise<string> {
    const configuredToken = this.config.get<string>('ssh.proxyToken');
    if (configuredToken.trim()) {
      const tokenHash = this.hash(configuredToken);
      const existing = await this.tokensRepo.findOneBy({ id: 'singleton' });
      if (!existing || existing.tokenHash !== tokenHash) {
        await this.tokensRepo.save(this.tokensRepo.create({
          id: 'singleton',
          tokenHash,
          createdAt: existing?.createdAt ?? new Date(),
        }));
      }
      return configuredToken;
    }
    const existing = await this.tokensRepo.findOneBy({ id: 'singleton' });
    if (existing) return '';
    const raw = randomBytes(32).toString('hex');
    await this.tokensRepo.save(this.tokensRepo.create({
      id: 'singleton',
      tokenHash: this.hash(raw),
      createdAt: new Date(),
    }));
    this.logger.warn('Generated SSH proxy token because SSH_PROXY_TOKEN is not set; set it explicitly in production');
    return raw;
  }

  getStatus(): {
    connectedProxies: number;
    activeConnections: number;
    totalConnections: number;
    totalRejectedConnections: number;
    totalClosedConnections: number;
    totalBytesFromClient: number;
    totalBytesToClient: number;
    bandwidthInBps: number;
    bandwidthOutBps: number;
    updatedAt: string | null;
    proxies: SshProxyStatusReport[];
  } {
    const proxies = Array.from(this.latestStatus.values())
      .sort((a, b) => a.proxyId.localeCompare(b.proxyId));
    const last = proxies
      .flatMap((proxy) => [proxy.connectedAt, proxy.lastSnapshotAt ?? 0])
      .filter((value) => value > 0)
      .sort((a, b) => b - a)[0];
    return {
      connectedProxies: this.clients.size,
      activeConnections: proxies.reduce((sum, proxy) => sum + proxy.activeConnections, 0),
      totalConnections: proxies.reduce((sum, proxy) => sum + proxy.totalConnections, 0),
      totalRejectedConnections: proxies.reduce((sum, proxy) => sum + proxy.totalRejectedConnections, 0),
      totalClosedConnections: proxies.reduce((sum, proxy) => sum + proxy.totalClosedConnections, 0),
      totalBytesFromClient: proxies.reduce((sum, proxy) => sum + proxy.totalBytesFromClient, 0),
      totalBytesToClient: proxies.reduce((sum, proxy) => sum + proxy.totalBytesToClient, 0),
      bandwidthInBps: proxies.reduce((sum, proxy) => sum + proxy.bandwidthInBps, 0),
      bandwidthOutBps: proxies.reduce((sum, proxy) => sum + proxy.bandwidthOutBps, 0),
      updatedAt: last ? new Date(last).toISOString() : null,
      proxies,
    };
  }

  async disconnectAll(reason = 'admin disconnect all'): Promise<{
    requestId: string;
    requested: number;
    disconnected: number;
  }> {
    const targets = Array.from(this.clients).filter((client) => client.readyState === WebSocket.OPEN);
    const requestId = randomBytes(12).toString('hex');
    if (targets.length === 0) {
      return { requestId, requested: 0, disconnected: 0 };
    }
    const message: SshProxyBackendMessage = {
      kind: 'disconnectAll',
      payload: { requestId, reason },
    };
    const encoded = JSON.stringify({ ts: Date.now(), ...message });
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingDisconnectAll.get(requestId);
        if (!pending) return;
        this.pendingDisconnectAll.delete(requestId);
        pending.resolve({ requestId, requested: targets.length, disconnected: pending.disconnected });
      }, 5_000);
      this.pendingDisconnectAll.set(requestId, {
        expected: targets.length,
        replies: 0,
        disconnected: 0,
        timeout,
        resolve,
      });
      for (const client of targets) client.send(encoded);
    });
  }

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    if (!await this.authorize(req)) {
      ws.close(4003, 'Invalid token');
      return;
    }

    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
      this.latestStatus.delete(ws);
    });
    ws.on('error', (error) => this.logger.warn(`SSH proxy WS error: ${error.message}`));
    ws.on('message', (raw) => this.handleMessage(ws, raw.toString()));

    ws.send(JSON.stringify({
      ts: Date.now(),
      kind: 'snapshot',
      payload: await this.snapshots.buildSnapshot(),
    }));
  }

  private async authorize(req: http.IncomingMessage): Promise<boolean> {
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const queryToken = typeof req.url === 'string'
      ? new URL(req.url, 'http://localhost').searchParams.get('token') ?? ''
      : '';
    const token = bearer || queryToken;
    if (!token) return false;
    await this.ensureToken();
    const row = await this.tokensRepo.findOneBy({ id: 'singleton' });
    return row?.tokenHash === this.hash(token);
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    const parsed = zEnvelope.safeParse(this.parseJson(raw));
    if (!parsed.success) {
      this.logger.warn('Invalid SSH proxy envelope');
      return;
    }
    const envelope = parsed.data;
    if (envelope.kind === 'ack') {
      const ack = zSshProxyClientAck.safeParse(envelope.payload);
      if (ack.success) {
        this.logger.debug(`SSH proxy acknowledged generation ${ack.data.generation}`);
      }
      return;
    }
    if (envelope.kind === 'metrics') {
      const payload = envelope.payload && typeof envelope.payload === 'object'
        ? envelope.payload as Record<string, unknown>
        : {};
      const metrics = Array.isArray(payload.metrics)
        ? payload.metrics.map((metric) => zSshProxyMetric.safeParse(metric)).filter((metric) => metric.success).length
        : 0;
      if (metrics > 0) this.logger.debug(`SSH proxy metrics batch received: ${metrics}`);
      return;
    }
    if (envelope.kind === 'status') {
      const status = zSshProxyStatusReport.safeParse(envelope.payload);
      if (status.success) this.latestStatus.set(ws, status.data);
      return;
    }
    if (envelope.kind === 'disconnectAllResult') {
      const result = zSshProxyDisconnectAllResult.safeParse(envelope.payload);
      if (result.success) this.resolveDisconnectAll(result.data.requestId, result.data.disconnected);
      return;
    }
    if (envelope.kind === 'audit') {
      const audit = zSshProxyAuditEvent.safeParse(envelope.payload);
      if (audit.success) {
        this.logger.log(`SSH proxy audit action=${audit.data.action} ok=${audit.data.ok} user=${audit.data.username ?? audit.data.userId ?? 'unknown'}`);
      }
    }
  }

  private broadcast(message: SshProxyBackendMessage): void {
    const encoded = JSON.stringify({ ts: Date.now(), ...message });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(encoded);
    }
  }

  private resolveDisconnectAll(requestId: string, disconnected: number): void {
    const pending = this.pendingDisconnectAll.get(requestId);
    if (!pending) return;
    pending.replies += 1;
    pending.disconnected += disconnected;
    if (pending.replies < pending.expected) return;
    this.pendingDisconnectAll.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve({
      requestId,
      requested: pending.expected,
      disconnected: pending.disconnected,
    });
  }

  private parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
