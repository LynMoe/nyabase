import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createHash } from 'crypto';
import {
  AgentToBackendMessage,
  AgentCommandEnvelope,
  BackendToAgentMessage,
  zEnvelope,
  zHelloPayload,
  zHeartbeatPayload,
  zStateReportPayload,
  zMetricsBatchPayload,
  zCommandAckPayload,
  zOperationProgressPayload,
  zContainerEventPayload,
  zLogChunkPayload,
  zDataDirReportPayload,
  zPullProgressPayload,
  zRemoteFsMountStatus,
  zDockerDaemonStatus,
  HelloPayload,
  HeartbeatPayload,
  StateReportPayload,
  MetricsBatchPayload,
  ContainerEventPayload,
  LogChunkPayload,
  DataDirReportPayload,
  PullProgressPayload,
  RemoteFsMountStatus,
  ServerStatus,
  type OperationProgressPayload,
} from '@nyabase/common';
import { ServerEntity } from '../entities/server.entity.js';
import { AgentSession } from './agent-session.js';
import { StateCache, ServerSnapshot } from './state-cache.js';
import { MetricsWriter } from '../metrics/metrics-writer.js';
import { ExecSessionRegistry } from './exec-session-registry.js';
import { LogChunkTracker } from './log-chunk-tracker.js';
import { PullProgressTracker } from './pull-progress-tracker.js';
import { UsersService } from '../users/users.service.js';
import { OperationReportUnlockService } from '../operations/operation-report-unlock.service.js';
import { DataDirReconcilerService } from '../datadirs/data-dir-reconciler.service.js';
import { ContainerSshRouteService } from '../ssh/container-ssh-route.service.js';
import { SshProxyGateway } from '../ssh/ssh-proxy-gateway.js';
import { HttpProxyGateway } from '../http-proxy/http-proxy-gateway.js';

const DIRECT_RPC_KINDS = new Set<string>([
  'execStream',
  'execResize',
  'execInput',
  'execClose',
  'reconcile',
  'fetchContainerStats',
  'checkDisk',
  'selfCheck',
  'reconcileDockerDaemon',
]);

@Injectable()
export class AgentGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentGateway.name);
  private wss: WebSocketServer | null = null;
  private sessions: Map<string, AgentSession> = new Map();

  readonly stateCache = new StateCache();

  private readonly logChunkTracker = new LogChunkTracker();
  private readonly pullProgressTracker = new PullProgressTracker();
  private readonly reportedUnknownXfsNumericIdsByServer = new Map<string, Set<number>>();

  // ---------------------------------------------------------------------------
  // Pull progress — delegated to PullProgressTracker; expose the same surface
  // that ImagesService and the SSE endpoint rely on.
  // ---------------------------------------------------------------------------

  /** Latest pull progress snapshot per `serverId:dockerRef`. */
  get pullProgress(): Map<string, PullProgressPayload> {
    return this.pullProgressTracker.progress;
  }

  /** Subscribe to all pull progress events. Returns an unsubscribe function. */
  onPullProgress(cb: (p: PullProgressPayload) => void): () => void {
    return this.pullProgressTracker.onProgress(cb);
  }

  constructor(
    @InjectRepository(ServerEntity)
    private serversRepo: Repository<ServerEntity>,
    private metricsWriter: MetricsWriter,
    private execSessionRegistry: ExecSessionRegistry,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    @Optional()
    @Inject(forwardRef(() => OperationReportUnlockService))
    private operationReportUnlock?: OperationReportUnlockService,
    @Optional()
    @Inject(forwardRef(() => DataDirReconcilerService))
    private dataDirReconciler?: DataDirReconcilerService,
    @Optional()
    @Inject(forwardRef(() => ContainerSshRouteService))
    private sshRoutes?: ContainerSshRouteService,
    @Optional()
    @Inject(forwardRef(() => SshProxyGateway))
    private sshProxyGateway?: SshProxyGateway,
    @Optional()
    @Inject(forwardRef(() => HttpProxyGateway))
    private httpProxyGateway?: HttpProxyGateway,
  ) {}

  onModuleInit() {
    this.execSessionRegistry.setOrphanHandler((sessionId, info) => {
      this.notify(info.serverId, 'execClose', { sessionId });
    });
    this.logChunkTracker.start();
  }

  onModuleDestroy() {
    this.logChunkTracker.stop();
    this.wss?.close();
  }

  attachToHttpServer(server: http.Server): void {
    // noServer mode: each WebSocketServer only handles its own upgrade path.
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
      if (req.url?.split('?')[0] !== '/ws/agent') return;
      this.wss!.handleUpgrade(req, socket as import('stream').Duplex, head, (ws) => {
        this.wss!.emit('connection', ws, req);
      });
    });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.logger.log('Agent WebSocket gateway ready at /ws/agent');
  }

  // ---------------------------------------------------------------------------
  // Connection handling
  // ---------------------------------------------------------------------------

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      ws.close(4001, 'Missing token');
      return;
    }

    const rawToken = authHeader.slice(7);
    const hash = createHash('sha256').update(rawToken).digest('hex');
    const server = await this.serversRepo.findOne({ where: { agentTokenHash: hash } });
    if (!server) {
      ws.close(4003, 'Invalid token');
      return;
    }

    // Kick old session if present
    const existing = this.sessions.get(server.id);
    if (existing) {
      existing.rejectAll('Replaced by new connection');
      existing.ws.close(4000, 'Replaced by new connection');
    }

    const session = new AgentSession(server.id, ws);
    this.sessions.set(server.id, session);
    this.logger.log(`Agent connected: server=${server.name} (${server.id})`);
    this.stateCache.set(server.id, this.emptySnapshot(server.id, session.id, Date.now()));

    ws.on('message', (raw) => this.handleMessage(session, server, raw.toString()));
    ws.on('close', () => this.handleDisconnect(session, server));
    ws.on('error', (err) => this.logger.error(`Agent WS error [${server.name}]: ${err.message}`));

    // Request full state immediately after establishing the session
    session.send({ id: undefined, ts: Date.now(), kind: 'reconcile', payload: { serverId: server.id } });
  }

  private async handleDisconnect(session: AgentSession, server: ServerEntity): Promise<void> {
    this.logger.log(`Agent disconnected: server=${server.name}`);
    session.rejectAll('Agent disconnected');

    // Only clean up if this is still the active session (not already replaced)
    if (this.sessions.get(server.id) !== session) return;

    this.sessions.delete(server.id);
    this.stateCache.delete(server.id);
    this.logChunkTracker.clearServer(server.id, this.execSessionRegistry);
    this.pullProgressTracker.clearServer(server.id);
    await this.serversRepo.update(server.id, { status: ServerStatus.Offline, lastSeenAt: new Date() });
  }

  // ---------------------------------------------------------------------------
  // Message routing
  // ---------------------------------------------------------------------------

  private async handleMessage(session: AgentSession, server: ServerEntity, raw: string): Promise<void> {
    let envelope: ReturnType<typeof zEnvelope.parse>;
    try {
      envelope = zEnvelope.parse(JSON.parse(raw));
    } catch {
      this.logger.warn(`Invalid envelope from agent ${server.id}`);
      session.ws.close(4400, 'Invalid envelope');
      return;
    }

    const msg = envelope as AgentToBackendMessage;

    try {
      switch (msg.kind) {
        case 'hello':
          await this.onHello(server, zHelloPayload.parse(msg.payload));
          break;
        case 'heartbeat':
          await this.onHeartbeat(server, zHeartbeatPayload.parse(msg.payload));
          break;
        case 'stateReport':
          await this.onStateReport(server, zStateReportPayload.parse(msg.payload));
          break;
        case 'metricsBatch':
          await this.onMetricsBatch(zMetricsBatchPayload.parse(msg.payload));
          break;
        case 'commandAck': {
          const ack = zCommandAckPayload.parse(msg.payload);
          session.resolveAck(ack.commandId, ack.ok, ack.error, ack.data);
          break;
        }
        case 'operationProgress': {
          await this.onOperationProgress(zOperationProgressPayload.parse(msg.payload));
          break;
        }
        case 'containerEvent':
          await this.onContainerEvent(server, zContainerEventPayload.parse(msg.payload));
          break;
        case 'logChunk':
          this.logChunkTracker.dispatch(zLogChunkPayload.parse(msg.payload));
          break;
        case 'dataDirReport': {
          const report = zDataDirReportPayload.parse(msg.payload) as DataDirReportPayload;
          if (report.serverId !== server.id) {
            this.logger.warn(`dataDirReport serverId mismatch: payload=${report.serverId} connection=${server.id}, ignoring`);
            break;
          }
          this.stateCache.updateDataDirs(server.id, report.dirs);
          await this.dataDirReconciler?.reconcile(server.id);
          await this.operationReportUnlock?.onDataDirReport(server.id, report.observedAt);
          break;
        }
        case 'pullProgress': {
          const pp = zPullProgressPayload.parse(msg.payload) as PullProgressPayload;
          this.pullProgressTracker.handle(pp, (serverId) => {
            this.sessions.get(serverId)?.send({
              id: undefined, ts: Date.now(), kind: 'reconcile', payload: { serverId },
            } as BackendToAgentMessage);
          });
          break;
        }
        case 'remoteFsMountStatus': {
          const status = zRemoteFsMountStatus.parse(msg.payload) as RemoteFsMountStatus;
          this.stateCache.updateRemoteFsMountStatus(server.id, status);
          break;
        }
        case 'dockerDaemonStatus': {
          const parsed = zDockerDaemonStatus.safeParse(msg.payload);
          if (parsed.success) {
            if (parsed.data.serverId !== server.id) {
              this.logger.warn(`dockerDaemonStatus serverId mismatch: payload=${parsed.data.serverId} connection=${server.id}, ignoring`);
              break;
            }
            this.stateCache.updateDockerDaemonStatus(server.id, parsed.data);
          } else {
            this.logger.warn(`Invalid dockerDaemonStatus from ${server.id}: ${parsed.error.message}`);
          }
          break;
        }
        default:
          this.logger.warn(`Unknown message kind: ${(msg as { kind: string }).kind}`);
      }
    } catch (err) {
      this.logger.error(`Error handling message ${msg.kind} from ${server.id}: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------

  private async onHello(server: ServerEntity, payload: HelloPayload): Promise<void> {
    this.logger.log(
      `Hello from ${server.name}: ${payload.hostname}, ${payload.gpus.length} GPUs, agentVersion=${payload.agentVersion}`,
    );

    // Freeze dockerRoot/dockerSocket on first hello; log mismatch but don't overwrite.
    const dbUpdate: Partial<ServerEntity> = { status: ServerStatus.Online, lastSeenAt: new Date() };
    if (payload.dockerRoot && server.dockerRoot === null) {
      dbUpdate.dockerRoot = payload.dockerRoot;
      dbUpdate.dockerSocket = payload.dockerSocket ?? null;
      this.logger.log(
        `Freezing dockerRoot for ${server.name}: ${payload.dockerRoot} (socket: ${payload.dockerSocket ?? 'unknown'})`,
      );
    } else if (payload.dockerRoot && server.dockerRoot !== null && server.dockerRoot !== payload.dockerRoot) {
      this.logger.warn(
        `dockerRoot mismatch for ${server.name}: DB has "${server.dockerRoot}", agent reports "${payload.dockerRoot}". Ignoring agent value.`,
      );
    }
    await this.serversRepo.update(server.id, dbUpdate);

    // Reset stateCache so stale containers from the previous agent lifecycle are
    // cleared before the fresh stateReport arrives.
    const snap: ServerSnapshot = {
      serverId: server.id,
      runtimeReady: false,
      sessionId: this.sessions.get(server.id)?.id ?? '',
      helloAt: Date.now(),
      lastFullReportAt: null,
      lastFullReportReceivedAt: null,
      lastIncrementalReportAt: null,
      lastIncrementalReportReceivedAt: null,
      lastUpdated: Date.now(),
      agentVersion: payload.agentVersion,
      hostname: payload.hostname,
      cpuCores: payload.cpuCores,
      totalMemBytes: payload.totalMemBytes,
      containers: new Map(),
      disks: payload.disks,
      gpus: payload.gpus,
      xfsProjects: [],
      localImages: payload.localImages ?? [],
      dataDirs: [],
      dataDirIssues: { orphans: [], missing: [] },
      remoteFsMounts: [],
      dockerDaemon: null,
    };
    this.stateCache.set(server.id, snap);
  }

  private async onHeartbeat(server: ServerEntity, _payload: HeartbeatPayload): Promise<void> {
    await this.serversRepo.update(server.id, { status: ServerStatus.Online, lastSeenAt: new Date() });
  }

  private async onStateReport(server: ServerEntity, payload: StateReportPayload): Promise<void> {
    let snap = this.stateCache.get(server.id);
    if (!snap) {
      snap = this.emptySnapshot(server.id, this.sessions.get(server.id)?.id ?? '', Date.now());
      this.stateCache.set(server.id, snap);
    }

    if (payload.incremental && !snap.runtimeReady) {
      this.logger.warn(`[StateReport] Ignoring incremental report before first full report for server ${server.id}`);
      return;
    }

    if (!payload.incremental) {
      snap.containers.clear();
    }
    for (const c of payload.containers) {
      snap.containers.set(c.spec.runtimeId, c);
    }
    await this.sshRoutes?.updateFromStateReport(
      server.id,
      payload.containers,
      payload.observedAt,
      payload.incremental,
    );
    this.httpProxyGateway?.scheduleBroadcast('container_state_report');

    // Resolve numericUserId → UUID for each xfsProject entry.
    const numericIds = payload.xfsProjects.map((p) => p.numericUserId);
    const uuidMap = await this.usersService.getUserIdsByNumericIds(numericIds);
    const unknownNumericIds = new Set<number>();
    snap.xfsProjects = payload.xfsProjects
      .map((p) => {
        const userId = uuidMap.get(p.numericUserId);
        if (!userId) {
          unknownNumericIds.add(p.numericUserId);
          return null;
        }
        return { userId, projectId: p.projectId, usedBytes: p.usedBytes, hardLimitBytes: p.hardLimitBytes };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    this.warnForNewUnknownXfsNumericIds(server.id, unknownNumericIds);

    snap.disks = payload.disks;
    if (payload.localImages) snap.localImages = payload.localImages;
    // Sync remote FS mount statuses from stateReport (fill in any that weren't sent as individual events)
    if (payload.remoteFsMounts) {
      if (payload.incremental) {
        for (const status of payload.remoteFsMounts) {
          this.stateCache.updateRemoteFsMountStatus(server.id, status);
        }
      } else {
        snap.remoteFsMounts = payload.remoteFsMounts;
      }
    }
    snap.lastUpdated = Date.now();
    if (payload.incremental) {
      snap.lastIncrementalReportAt = payload.observedAt;
      snap.lastIncrementalReportReceivedAt = snap.lastUpdated;
    } else {
      snap.runtimeReady = true;
      snap.lastFullReportAt = payload.observedAt;
      snap.lastFullReportReceivedAt = snap.lastUpdated;
    }
    await this.operationReportUnlock?.onStateReport(server.id, payload.observedAt);
    await this.sshProxyGateway?.broadcastSnapshot();
  }

  private warnForNewUnknownXfsNumericIds(serverId: string, unknownNumericIds: Set<number>): void {
    if (unknownNumericIds.size === 0) return;
    let reported = this.reportedUnknownXfsNumericIdsByServer.get(serverId);
    if (!reported) {
      reported = new Set<number>();
      this.reportedUnknownXfsNumericIdsByServer.set(serverId, reported);
    }
    const newIds = [...unknownNumericIds]
      .filter((id) => !reported.has(id))
      .sort((a, b) => a - b);
    if (newIds.length === 0) return;
    for (const id of newIds) reported.add(id);
    this.logger.warn(
      `[StateReport] Unknown XFS numericUserIds from server ${serverId} — skipping new=${newIds.join(',')} reportUnknownCount=${unknownNumericIds.size}`,
    );
  }

  private async onMetricsBatch(payload: MetricsBatchPayload): Promise<void> {
    await this.metricsWriter.writeBatch(payload.serverId, payload.points);
  }

  private async onContainerEvent(server: ServerEntity, payload: ContainerEventPayload): Promise<void> {
    this.stateCache.applyContainerEvent(server.id, payload.runtimeId, payload.action);
  }

  private async onOperationProgress(payload: OperationProgressPayload): Promise<void> {
    void payload;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getSession(serverId: string): AgentSession | undefined {
    return this.sessions.get(serverId);
  }

  isOnline(serverId: string): boolean {
    const session = this.sessions.get(serverId);
    return !!session && session.ws.readyState === WebSocket.OPEN;
  }

  async rpc<T = unknown>(
    serverId: string,
    kind: BackendToAgentMessage['kind'],
    payload: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!DIRECT_RPC_KINDS.has(kind)) {
      throw new Error(`Direct command ${kind} is disabled; use sendCommandEnvelope`);
    }
    const session = this.sessions.get(serverId);
    if (!session) throw new Error('Agent offline');
    return session.rpc<T>(kind, payload, timeoutMs);
  }

  async sendCommandEnvelope<T = unknown>(
    serverId: string,
    envelope: AgentCommandEnvelope,
    timeoutMs = 60_000,
  ): Promise<T> {
    const session = this.sessions.get(serverId);
    if (!session) throw new Error('Agent offline');
    return session.commandEnvelope<T>(envelope, timeoutMs);
  }

  /** Fire-and-forget: send a message without waiting for acknowledgement. */
  notify(serverId: string, kind: BackendToAgentMessage['kind'], payload: unknown): void {
    this.sessions.get(serverId)?.send(
      { id: undefined, ts: Date.now(), kind, payload } as BackendToAgentMessage,
    );
  }

  /**
   * Register a log-chunk listener for an exec session.
   * Immediately replays any chunks that arrived before the browser connected.
   * Returns an unsubscribe function.
   */
  onLogChunk(
    sessionId: string,
    serverId: string,
    cb: (chunk: LogChunkPayload) => void,
  ): () => void {
    return this.logChunkTracker.onLogChunk(sessionId, serverId, cb);
  }

  private emptySnapshot(serverId: string, sessionId: string, now: number): ServerSnapshot {
    return {
      serverId,
      runtimeReady: false,
      sessionId,
      helloAt: null,
      lastFullReportAt: null,
      lastFullReportReceivedAt: null,
      lastIncrementalReportAt: null,
      lastIncrementalReportReceivedAt: null,
      lastUpdated: now,
      agentVersion: '',
      hostname: '',
      cpuCores: 0,
      totalMemBytes: 0,
      containers: new Map(),
      disks: [],
      gpus: [],
      xfsProjects: [],
      localImages: [],
      dataDirs: [],
      dataDirIssues: { orphans: [], missing: [] },
      remoteFsMounts: [],
      dockerDaemon: null,
    };
  }
}
