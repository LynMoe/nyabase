import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as http from 'http';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import {
  zSshProxyAuditEvent,
  zSshProxyClientAck,
  zSshProxyDisconnectAllResult,
  zSshProxyMetric,
  zSshProxyStatusReport,
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
  SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
  MAX_SSH_PROXY_SNAPSHOT_BYTES,
  MAX_SSH_PROXY_STATUS_CONNECTIONS,
  type SshProxyBackendMessage,
  type SshProxyStatusReport,
} from '@nyabase/common';
import { SshProxySnapshotService } from './ssh-proxy-snapshot.service.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import {
  configuredProxyTokenDigest,
  hasValidBearerToken,
} from '../common/proxy-bearer-auth.js';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';

export const MAX_SSH_PROXY_BUFFERED_BYTES = MAX_SSH_PROXY_SNAPSHOT_BYTES;
export const MAX_SSH_PROXY_CLIENTS = 4;
export const MAX_PENDING_SSH_DISCONNECT_ALL = 16;
const MAX_SSH_PROXY_CONTROL_FRAME_BYTES = 1024 * 1024;
const MAX_SSH_PROXY_SNAPSHOT_RENEWAL_MS = 60_000;
const INITIAL_CONNECTION_DEADLINE_MS = 15_000;

function isSshProxyEnvelope(value: unknown): value is {
  kind: 'ack' | 'metrics' | 'status' | 'disconnectAllResult' | 'audit';
  payload: unknown;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return ['ack', 'metrics', 'status', 'disconnectAllResult', 'audit']
    .includes(String(candidate.kind))
    && 'payload' in candidate;
}

export function sshProxySnapshotRenewalMs(staleAfterMs: number): number {
  if (
    !Number.isSafeInteger(staleAfterMs)
    || staleAfterMs < SSH_PROXY_SNAPSHOT_STALE_MIN_MS
    || staleAfterMs > SSH_PROXY_SNAPSHOT_STALE_MAX_MS
  ) {
    throw new Error(
      `SSH proxy snapshot staleAfterMs must be between ${SSH_PROXY_SNAPSHOT_STALE_MIN_MS} and ${SSH_PROXY_SNAPSHOT_STALE_MAX_MS}`,
    );
  }
  return Math.min(
    MAX_SSH_PROXY_SNAPSHOT_RENEWAL_MS,
    Math.floor(staleAfterMs / 3),
  );
}

@Injectable()
export class SshProxyGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SshProxyGateway.name);
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  /** Slots are reserved synchronously before authentication or snapshot I/O. */
  private initializingClients = new Set<WebSocket>();
  private latestStatus = new Map<WebSocket, SshProxyStatusReport>();
  private snapshotBroadcastPromise: Promise<void> | null = null;
  private snapshotDirty = false;
  /**
   * In-memory invalidation token for snapshots built across a committed
   * authorization change. Every broadcast request replaces it synchronously;
   * builders may publish only when the token they started with is still live.
   */
  private snapshotRevision: object = {};
  private snapshotRenewalTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private unregisterSnapshotListener: (() => void) | null = null;
  private readonly expectedTokenDigest: Buffer;
  private pendingDisconnectAll = new Map<string, {
    expected: number;
    awaiting: Set<WebSocket>;
    disconnected: number;
    timeout: NodeJS.Timeout;
    resolve: (result: { requestId: string; requested: number; disconnected: number }) => void;
  }>();

  constructor(
    private snapshots: SshProxySnapshotService,
    private config: NyabaseConfigService,
    private proxySnapshots: ProxySnapshotNotifierService,
    private readonly runtimeRole?: RuntimeRoleService,
  ) {
    this.expectedTokenDigest = configuredProxyTokenDigest(
      config.get<string>('ssh.proxyToken'),
      'ssh.proxyToken',
    );
  }

  onModuleInit(): void {
    if (this.runtimeRole && !this.runtimeRole.servesProxySockets()) return;
    this.unregisterSnapshotListener = this.proxySnapshots.register(
      'ssh',
      () => this.broadcastSnapshot(),
    );
    this.scheduleSnapshotRenewal();
  }

  attachToHttpServer(server: http.Server): void {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_SSH_PROXY_CONTROL_FRAME_BYTES,
      perMessageDeflate: false,
    });
    server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
      if (req.url?.split('?')[0] !== '/ws/ssh-proxy') return;
      try {
        this.wss!.handleUpgrade(req, socket as import('stream').Duplex, head, (ws) => {
          this.wss!.emit('connection', ws, req);
        });
      } catch (error) {
        this.logger.warn(
          `SSH proxy WebSocket upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        socket.destroy();
      }
    });
    this.wss.on('connection', (ws, req) => {
      ws.on('close', () => this.removeAdmittedClient(ws));
      // Attach before the first await: an unhandled EventEmitter `error`
      // would otherwise terminate the Backend during authentication/build.
      ws.on('error', (error) => this.logger.warn(`SSH proxy WS error: ${error.message}`));
      void this.handleConnection(ws, req).catch((error: unknown) => {
        this.logger.warn(
          `SSH proxy connection initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        ws.terminate();
      });
    });
    this.logger.log('SSH proxy WebSocket gateway ready at /ws/ssh-proxy');
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.unregisterSnapshotListener?.();
    this.unregisterSnapshotListener = null;
    if (this.snapshotRenewalTimer) clearTimeout(this.snapshotRenewalTimer);
    this.snapshotRenewalTimer = null;
    for (const client of this.initializingClients) client.terminate();
    for (const client of this.clients) client.terminate();
    this.initializingClients.clear();
    this.clients.clear();
    this.latestStatus.clear();
    this.snapshotDirty = false;
    for (const [requestId, pending] of this.pendingDisconnectAll) {
      clearTimeout(pending.timeout);
      pending.resolve({ requestId, requested: pending.expected, disconnected: pending.disconnected });
    }
    this.pendingDisconnectAll.clear();
    this.wss?.close();
  }

  async broadcastSnapshot(): Promise<void> {
    return this.requestSnapshotBroadcast(true);
  }

  /** Lease renewal is not an authorization invalidation. If a build is
   * already in flight, its eventual snapshot is newer than this request and
   * can safely satisfy it without being discarded or starting another build.
   */
  private async renewSnapshotLease(): Promise<void> {
    return this.requestSnapshotBroadcast(false);
  }

  private async requestSnapshotBroadcast(invalidate: boolean): Promise<void> {
    if (this.destroyed) return;
    if (invalidate) {
      // This must happen before the first await, including when no proxy is
      // currently admitted: an initial-connection build may be in flight and
      // must discard its pre-revocation snapshot.
      this.snapshotRevision = {};
    }
    this.scheduleSnapshotRenewal();
    if (!invalidate && this.snapshotBroadcastPromise) return this.snapshotBroadcastPromise;
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
      activeConnections: boundedStatusSum(proxies, (proxy) => proxy.activeConnections),
      totalConnections: boundedStatusSum(proxies, (proxy) => proxy.totalConnections),
      totalRejectedConnections: boundedStatusSum(
        proxies,
        (proxy) => proxy.totalRejectedConnections,
      ),
      totalClosedConnections: boundedStatusSum(proxies, (proxy) => proxy.totalClosedConnections),
      totalBytesFromClient: boundedStatusSum(proxies, (proxy) => proxy.totalBytesFromClient),
      totalBytesToClient: boundedStatusSum(proxies, (proxy) => proxy.totalBytesToClient),
      bandwidthInBps: boundedStatusSum(proxies, (proxy) => proxy.bandwidthInBps),
      bandwidthOutBps: boundedStatusSum(proxies, (proxy) => proxy.bandwidthOutBps),
      updatedAt: safeStatusTimestampIso(last),
      proxies,
    };
  }

  async disconnectAll(
    reason = 'admin disconnect all',
    requestId = randomBytes(12).toString('hex'),
  ): Promise<{
    requestId: string;
    requested: number;
    disconnected: number;
  }> {
    const targets = Array.from(this.clients).filter((client) => client.readyState === WebSocket.OPEN);
    if (targets.length === 0) {
      return { requestId, requested: 0, disconnected: 0 };
    }
    if (this.pendingDisconnectAll.size >= MAX_PENDING_SSH_DISCONNECT_ALL) {
      throw new ServiceUnavailableException({
        code: 'SSH_PROXY_DISCONNECT_ALL_BUSY',
        message: 'Too many SSH proxy disconnect-all requests are already pending',
      });
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
        awaiting: new Set(targets),
        disconnected: 0,
        timeout,
        resolve,
      });
      for (const client of targets) {
        const sent = this.sendOrTerminate(
          client,
          encoded,
          'disconnect-all command',
          () => this.resolveDisconnectAll(requestId, 0, client),
        );
        if (!sent) this.resolveDisconnectAll(requestId, 0, client);
      }
    });
  }

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    if (
      this.destroyed
      || this.clients.size + this.initializingClients.size >= MAX_SSH_PROXY_CLIENTS
    ) {
      ws.terminate();
      return;
    }
    this.initializingClients.add(ws);
    const deadline = performance.now() + INITIAL_CONNECTION_DEADLINE_MS;
    try {
      if (!this.authorize(req)) {
        ws.terminate();
        return;
      }

      // Build before admission so an in-flight broadcast cannot overtake this
      // connection's initial snapshot. The reservation above bounds both
      // authentication I/O and concurrent snapshot builds.
      let initialSnapshot: Awaited<ReturnType<SshProxySnapshotService['buildSnapshot']>>;
      while (true) {
        const buildRevision = this.snapshotRevision;
        initialSnapshot = await this.buildInitialSnapshotBefore(deadline, ws);
        if (this.destroyed || ws.readyState !== WebSocket.OPEN) {
          if (ws.readyState === WebSocket.OPEN) ws.terminate();
          return;
        }
        if (buildRevision !== this.snapshotRevision) continue;
        break;
      }
      this.initializingClients.delete(ws);
      this.clients.add(ws);
      ws.on('message', (raw) => this.handleMessage(ws, raw.toString()));

      const initialEncoded = JSON.stringify({
        ts: Date.now(),
        kind: 'snapshot',
        payload: initialSnapshot,
      });
      this.sendOrTerminate(ws, initialEncoded, 'initial snapshot');
    } finally {
      this.initializingClients.delete(ws);
    }
  }

  private async flushSnapshotBroadcasts(): Promise<void> {
    while (this.snapshotDirty) {
      this.snapshotDirty = false;
      if (this.clients.size === 0) continue;
      try {
        const buildRevision = this.snapshotRevision;
        const snapshot = await this.snapshots.buildSnapshot();
        if (this.destroyed) return;
        if (buildRevision !== this.snapshotRevision) {
          this.snapshotDirty = true;
          continue;
        }
        this.broadcast({ kind: 'update', payload: snapshot });
      } catch (error) {
        // Preserve one dirty bit so the next domain event retries. Do not spin
        // forever on a deterministic snapshot defect.
        this.snapshotDirty = true;
        throw error;
      }
    }
  }

  private scheduleSnapshotRenewal(): void {
    if (this.destroyed) return;
    const staleAfterMs = this.config.get<number>('ssh.proxySnapshotStaleMs');
    const renewalMs = sshProxySnapshotRenewalMs(staleAfterMs);
    if (this.snapshotRenewalTimer) clearTimeout(this.snapshotRenewalTimer);
    this.snapshotRenewalTimer = setTimeout(() => {
      this.snapshotRenewalTimer = null;
      if (this.destroyed) return;
      if (this.clients.size === 0) {
        this.scheduleSnapshotRenewal();
        return;
      }
      // A build which is still running will produce a snapshot newer than
      // this tick. Reschedule without attaching another waiter to the same
      // potentially long-lived Promise on every interval.
      if (this.snapshotBroadcastPromise) {
        this.scheduleSnapshotRenewal();
        return;
      }
      void this.renewSnapshotLease().catch((error: unknown) => {
        this.logger.warn(
          `SSH proxy snapshot renewal failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, renewalMs);
    this.snapshotRenewalTimer.unref();
  }

  private authorize(req: http.IncomingMessage): boolean {
    return hasValidBearerToken(req, this.expectedTokenDigest);
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    const envelope = this.parseJson(raw);
    if (!isSshProxyEnvelope(envelope)) {
      this.logger.warn('Invalid SSH proxy envelope');
      return;
    }
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
      if (result.success) this.resolveDisconnectAll(result.data.requestId, result.data.disconnected, ws);
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
      this.sendOrTerminate(client, encoded, 'snapshot');
    }
  }

  private sendOrTerminate(
    client: WebSocket,
    encoded: string,
    context: string,
    onAsyncFailure?: () => void,
  ): boolean {
    if (client.readyState !== WebSocket.OPEN) return false;
    const encodedBytes = Buffer.byteLength(encoded);
    if (client.bufferedAmount + encodedBytes > MAX_SSH_PROXY_BUFFERED_BYTES) {
      this.logger.warn(
        `SSH proxy ${context} dropped by terminating a backpressured client; bufferedAmount=${client.bufferedAmount}`,
      );
      client.terminate();
      return false;
    }
    try {
      client.send(encoded, (error) => {
        if (!error) return;
        this.logger.warn(`SSH proxy ${context} send failed: ${error.message}`);
        client.terminate();
        onAsyncFailure?.();
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `SSH proxy ${context} send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      client.terminate();
      return false;
    }
  }

  private resolveClosedProxy(client: WebSocket): void {
    for (const requestId of this.pendingDisconnectAll.keys()) {
      this.resolveDisconnectAll(requestId, 0, client);
    }
  }

  private resolveDisconnectAll(requestId: string, disconnected: number, client: WebSocket): void {
    const pending = this.pendingDisconnectAll.get(requestId);
    if (!pending || !pending.awaiting.delete(client)) return;
    // Wire validation already enforces this physical per-proxy cap. Retain a
    // second arithmetic boundary here so an internal/corrupt call can never
    // turn the aggregate into Infinity or an unsafe JSON/audit count.
    const boundedDisconnected = Number.isSafeInteger(disconnected)
      ? Math.max(0, Math.min(MAX_SSH_PROXY_STATUS_CONNECTIONS, disconnected))
      : 0;
    pending.disconnected = Math.min(
      MAX_SSH_PROXY_CLIENTS * MAX_SSH_PROXY_STATUS_CONNECTIONS,
      pending.disconnected + boundedDisconnected,
    );
    if (pending.awaiting.size > 0) return;
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

  private removeAdmittedClient(client: WebSocket): void {
    this.clients.delete(client);
    this.latestStatus.delete(client);
    this.resolveClosedProxy(client);
  }

  private async buildInitialSnapshotBefore(
    deadline: number,
    client: WebSocket,
  ): Promise<Awaited<ReturnType<SshProxySnapshotService['buildSnapshot']>>> {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new Error('SSH proxy initial snapshot deadline exceeded');
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      if (client.readyState === WebSocket.OPEN) client.terminate();
    }, remainingMs);
    timer.unref();
    try {
      // Repository I/O is not cancellable. Keep the reservation until the
      // started build actually settles; otherwise close/reconnect can create
      // an unbounded number of hidden in-flight snapshot queries.
      const snapshot = await this.snapshots.buildSnapshot();
      if (expired || performance.now() >= deadline) {
        throw new Error('SSH proxy initial snapshot deadline exceeded');
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
