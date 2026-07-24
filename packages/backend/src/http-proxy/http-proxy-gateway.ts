import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  MAX_HTTP_PROXY_SNAPSHOT_BYTES,
  zEnvelope,
  zHttpProxyClientAck,
  zHttpProxyStatusReport,
  type HttpProxyBackendMessage,
  type HttpProxyStatusReport,
} from '@nyabase/common';
import { HttpProxyService } from './http-proxy.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import {
  configuredProxyTokenDigest,
  hasValidBearerToken,
} from '../common/proxy-bearer-auth.js';

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 2_000;
const MAX_BUFFERED_BYTES = MAX_HTTP_PROXY_SNAPSHOT_BYTES;
const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;
const INITIAL_CONNECTION_DEADLINE_MS = 15_000;
const SNAPSHOT_RENEWAL_MS = Math.floor(HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS / 3);
export const MAX_HTTP_PROXY_CLIENTS = 4;

@Injectable()
export class HttpProxyGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HttpProxyGateway.name);
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  /** Slots are reserved before the first async snapshot build. */
  private initializingClients = new Set<WebSocket>();
  private latestStatus = new Map<WebSocket, HttpProxyStatusReport>();
  private latestSentSnapshot = new Map<WebSocket, { generation: number; validUntil: number }>();
  private latestAck = new Map<WebSocket, { generation: number; safeUntil: number }>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private maxWaitTimer: NodeJS.Timeout | null = null;
  private pendingReason: string | null = null;
  private snapshotBroadcastPromise: Promise<void> | null = null;
  private snapshotDirty = false;
  private snapshotRevision: object = {};
  private snapshotRenewalTimer: NodeJS.Timeout | null;
  private destroyed = false;
  private unregisterSnapshotNotifier: (() => void) | null = null;
  private readonly expectedTokenDigest: Buffer;

  constructor(
    private service: HttpProxyService,
    config: NyabaseConfigService,
    private snapshotNotifier: ProxySnapshotNotifierService,
  ) {
    this.expectedTokenDigest = configuredProxyTokenDigest(
      config.get<string>('http.proxyToken'),
      'http.proxyToken',
    );
    if (SNAPSHOT_RENEWAL_MS >= HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS / 2) {
      throw new Error('HTTP proxy snapshot renewal interval must be less than half the lease TTL');
    }
    this.snapshotRenewalTimer = setInterval(() => {
      if (this.destroyed || this.clients.size === 0) return;
      this.requestLeaseRenewal();
    }, SNAPSHOT_RENEWAL_MS);
    this.snapshotRenewalTimer.unref();
  }

  onModuleInit(): void {
    this.unregisterSnapshotNotifier = this.snapshotNotifier.register(
      'http',
      () => this.broadcastSnapshot(),
    );
  }

  attachToHttpServer(server: http.Server): void {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CONTROL_FRAME_BYTES,
      perMessageDeflate: false,
    });
    server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
      if (req.url?.split('?')[0] !== '/ws/http-proxy') return;
      try {
        this.wss!.handleUpgrade(req, socket as import('stream').Duplex, head, (ws) => {
          this.wss!.emit('connection', ws, req);
        });
      } catch (error) {
        this.logger.warn(
          `HTTP proxy WebSocket upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        socket.destroy();
      }
    });
    this.wss.on('connection', (ws, req) => {
      ws.on('close', () => this.removeAdmittedClient(ws));
      // EventEmitter treats an unhandled `error` as process-fatal. Install this
      // synchronously, before authentication or snapshot I/O can yield.
      ws.on('error', (error) => this.logger.warn(`HTTP proxy WS error: ${error.message}`));
      void this.handleConnection(ws, req).catch((error: unknown) => {
        this.logBroadcastFailure(error);
        ws.terminate();
      });
    });
    this.logger.log('HTTP proxy WebSocket gateway ready at /ws/http-proxy');
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.unregisterSnapshotNotifier?.();
    this.unregisterSnapshotNotifier = null;
    if (this.snapshotRenewalTimer) clearInterval(this.snapshotRenewalTimer);
    this.snapshotRenewalTimer = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    for (const client of this.initializingClients) client.terminate();
    for (const client of this.clients) client.terminate();
    this.initializingClients.clear();
    this.clients.clear();
    this.latestStatus.clear();
    this.latestSentSnapshot.clear();
    this.latestAck.clear();
    this.snapshotDirty = false;
    this.wss?.close();
  }

  isOnline(): boolean {
    const now = Date.now();
    return Array.from(this.clients).some((client) => {
      const ack = this.latestAck.get(client);
      return ack !== undefined && ack.safeUntil > now;
    });
  }

  scheduleBroadcast(reason: string): void {
    if (this.destroyed) return;
    this.snapshotRevision = {};
    // The reason is diagnostic only. Never concatenate an event stream into
    // an unbounded string; when nobody can receive a snapshot there is no log
    // reason to retain. The revision change above still invalidates an initial
    // snapshot build that is currently outside `clients`.
    if (this.clients.size === 0) {
      this.pendingReason = null;
      return;
    }
    this.pendingReason = reason;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.flushBroadcast().catch((error: unknown) => this.logBroadcastFailure(error));
    }, DEBOUNCE_MS);
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        void this.flushBroadcast().catch((error: unknown) => this.logBroadcastFailure(error));
      }, MAX_WAIT_MS);
    }
  }

  async broadcastSnapshot(): Promise<void> {
    if (this.destroyed) return;
    this.snapshotRevision = {};
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
      activeConnections: boundedStatusSum(proxies, (proxy) => proxy.activeConnections),
      totalRequests: boundedStatusSum(proxies, (proxy) => proxy.totalRequests),
      totalRejectedRequests: boundedStatusSum(proxies, (proxy) => proxy.totalRejectedRequests),
      updatedAt: safeStatusTimestampIso(last),
      proxies,
    };
  }

  private async flushBroadcast(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
    this.snapshotDirty = true;
    if (this.snapshotBroadcastPromise) return this.snapshotBroadcastPromise;
    const pending = this.flushSnapshotBroadcasts();
    this.snapshotBroadcastPromise = pending;
    try {
      await pending;
    } finally {
      if (this.snapshotBroadcastPromise === pending) this.snapshotBroadcastPromise = null;
    }
  }

  private requestLeaseRenewal(): void {
    this.snapshotDirty = true;
    if (this.snapshotBroadcastPromise) return;
    void this.flushBroadcast().catch((error: unknown) => this.logBroadcastFailure(error));
  }

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    if (
      this.destroyed
      || this.clients.size + this.initializingClients.size >= MAX_HTTP_PROXY_CLIENTS
    ) {
      ws.terminate();
      return;
    }
    this.initializingClients.add(ws);
    const deadline = Date.now() + INITIAL_CONNECTION_DEADLINE_MS;
    try {
      if (!this.authorize(req)) {
        ws.terminate();
        return;
      }
      // Build before admission so an existing broadcast cannot overtake this
      // connection's initial snapshot. The slot above is deliberately held
      // across the build so concurrent handshakes cannot create an unbounded
      // build queue.
      for (;;) {
        const buildRevision = this.snapshotRevision;
        const initialSnapshot = await this.buildInitialSnapshotBefore(deadline, ws);
        if (this.destroyed || ws.readyState !== WebSocket.OPEN) {
          if (ws.readyState === WebSocket.OPEN) ws.terminate();
          return;
        }
        if (buildRevision !== this.snapshotRevision) continue;

        // No await is allowed between this final revision comparison and the
        // first send. This makes admission + initial authority one JS turn;
        // a revocation can occur before it (and force a rebuild) or after it
        // (and schedule an update), never in an unobserved promise hop.
        this.initializingClients.delete(ws);
        this.clients.add(ws);
        ws.on('message', (raw) => this.handleMessage(ws, raw.toString()));
        if (!this.sendSnapshot(ws, { kind: 'snapshot', payload: initialSnapshot })) return;
        break;
      }
      void this.broadcastSnapshot().catch((error: unknown) => this.logBroadcastFailure(error));
    } finally {
      this.initializingClients.delete(ws);
    }
  }

  private async flushSnapshotBroadcasts(): Promise<void> {
    while (this.snapshotDirty) {
      this.snapshotDirty = false;
      const reason = this.pendingReason;
      this.pendingReason = null;
      if (this.clients.size === 0) continue;
      try {
        const buildRevision = this.snapshotRevision;
        const snapshot = await this.service.buildSnapshot();
        if (this.destroyed) return;
        if (buildRevision !== this.snapshotRevision) {
          this.snapshotDirty = true;
          continue;
        }
        this.logger.debug(
          `Broadcasting HTTP proxy snapshot generation=${snapshot.generation} reason=${reason ?? 'manual'}`,
        );
        this.broadcast({ kind: 'update', payload: snapshot });
      } catch (error) {
        this.snapshotDirty = true;
        throw error;
      }
    }
  }

  private logBroadcastFailure(error: unknown): void {
    this.logger.warn(
      `HTTP proxy snapshot broadcast failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private authorize(req: http.IncomingMessage): boolean {
    return hasValidBearerToken(req, this.expectedTokenDigest);
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    const parsed = zEnvelope.safeParse(this.parseJson(raw));
    if (!parsed.success) {
      this.logger.warn('Invalid HTTP proxy envelope');
      return;
    }
    if (parsed.data.kind === 'ack') {
      const ack = zHttpProxyClientAck.safeParse(parsed.data.payload);
      if (ack.success) {
        const sent = this.latestSentSnapshot.get(ws);
        const safeUntil = (sent?.validUntil ?? 0) - PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS;
        if (sent?.generation === ack.data.generation && safeUntil > Date.now()) {
          this.latestAck.set(ws, { generation: ack.data.generation, safeUntil });
          this.logger.debug(`HTTP proxy acknowledged generation ${ack.data.generation}`);
        } else {
          this.logger.warn(`Ignored unknown or already-stale HTTP proxy ack generation ${ack.data.generation}`);
        }
      }
      return;
    }
    if (parsed.data.kind === 'status') {
      const status = zHttpProxyStatusReport.safeParse(parsed.data.payload);
      if (status.success) this.latestStatus.set(ws, status.data);
    }
  }

  private broadcast(message: HttpProxyBackendMessage): void {
    const encoded = JSON.stringify({ ts: Date.now(), ...message });
    for (const client of this.clients) this.sendSnapshot(client, message, encoded);
  }

  private sendSnapshot(
    client: WebSocket,
    message: HttpProxyBackendMessage,
    encoded = JSON.stringify({ ts: Date.now(), ...message }),
  ): boolean {
    if (client.readyState !== WebSocket.OPEN) return false;
    const encodedBytes = Buffer.byteLength(encoded);
    if (client.bufferedAmount + encodedBytes > MAX_BUFFERED_BYTES) {
      this.logger.warn(
        'HTTP proxy client terminated because the next snapshot exceeds the outbound buffer limit; '
        + `bufferedAmount=${client.bufferedAmount} snapshotBytes=${encodedBytes}`,
      );
      this.clients.delete(client);
      this.latestStatus.delete(client);
      this.latestSentSnapshot.delete(client);
      this.latestAck.delete(client);
      client.terminate();
      return false;
    }
    this.latestSentSnapshot.set(client, {
      generation: message.payload.generation,
      validUntil: message.payload.validUntil,
    });
    client.send(encoded);
    return true;
  }

  private parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private removeAdmittedClient(client: WebSocket): void {
    this.clients.delete(client);
    this.latestStatus.delete(client);
    this.latestSentSnapshot.delete(client);
    this.latestAck.delete(client);
  }

  private async buildInitialSnapshotBefore(
    deadline: number,
    client: WebSocket,
  ): Promise<Awaited<ReturnType<HttpProxyService['buildSnapshot']>>> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('HTTP proxy initial snapshot deadline exceeded');
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      if (client.readyState === WebSocket.OPEN) client.terminate();
    }, remainingMs);
    timer.unref();
    try {
      // Snapshot builds cannot be cancelled at the ORM boundary. The slot is
      // released only after this Promise settles, even if the transport was
      // already closed by the deadline.
      const snapshot = await this.service.buildSnapshot();
      if (expired || Date.now() >= deadline) {
        throw new Error('HTTP proxy initial snapshot deadline exceeded');
      }
      return snapshot;
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeStatusTimestampIso(value: number | undefined): string | null {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) return null;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return null;
  return timestamp.toISOString();
}

function boundedStatusSum<T>(rows: readonly T[], valueFor: (row: T) => number): number {
  let result = 0;
  for (const row of rows) {
    const value = valueFor(row);
    if (!Number.isFinite(value) || value < 0) continue;
    result += value;
    if (result >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  }
  return result;
}
