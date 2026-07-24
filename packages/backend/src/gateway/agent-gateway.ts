import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import * as http from 'http';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createHash, randomBytes } from 'crypto';
import {
  AgentToBackendMessage,
  BackendToAgentMessage,
  zEnvelope,
  zHelloPayload,
  zHeartbeatPayload,
  zInventoryFaultPayload,
  zStateReportPayload,
  zMetricsBatchPayload,
  zCommandAckPayload,
  zTaskResultPayload,
  zLogChunkPayload,
  zDockerDaemonStatus,
  zAgentBootstrapResult,
  zAgentBootstrapPayload,
  HelloPayload,
  HeartbeatPayload,
  InventoryFaultPayload,
  StateReportPayload,
  ContainerSnapshot,
  MetricsBatchPayload,
  LogChunkPayload,
  RemoteFsMountStatus,
  type AgentBootstrapResult,
  type RemoteFsMountSpec,
  AgentTaskKind,
  AgentTaskStatus,
  ServerStatus,
  ContainerStatus,
  ContainerPhase,
  LABEL,
  isPublicDirectRpcKind,
  isAgentNotifyKind,
  type PublicDirectRpcKind,
  type AgentNotifyKind,
  isUsableHostInCidr,
  canonicalIpv4Address,
  canonicalIpv4Cidr,
  ipv4CidrsOverlap,
  parseCidr,
  MAX_AGENT_WS_FRAME_BYTES,
  MAX_AGENT_REMOTE_FS_MOUNTS,
  AGENT_BOOTSTRAP_RPC_TIMEOUT_MS,
  AGENT_INITIAL_STATE_REPORT_TIMEOUT_MS,
  AGENT_STEADY_STATE_REPORT_TIMEOUT_MS,
} from '@nyabase/common';
import {
  AGENT_INVENTORY_FAULT_QUARANTINE_CODE,
  ServerEntity,
} from '../entities/server.entity.js';
import { AgentRpcTransportError, AgentSession } from './agent-session.js';
import { StateCache, ServerSnapshot } from './state-cache.js';
import { MetricsWriter } from '../metrics/metrics-writer.js';
import { ExecSessionRegistry } from './exec-session-registry.js';
import { LogChunkTracker } from './log-chunk-tracker.js';
import { UsersService } from '../users/users.service.js';
import { AgentTaskDispatcherService } from '../agent-tasks/agent-task-dispatcher.service.js';
import { AgentTaskResultService } from '../agent-tasks/agent-task-result.service.js';
import {
  DataDirInventoryFaultError,
  DataDirReconcilerService,
} from '../datadirs/data-dir-reconciler.service.js';
import { ContainerSshRouteService } from '../ssh/container-ssh-route.service.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { SshProxyGateway } from '../ssh/ssh-proxy-gateway.js';
import { HttpProxyGateway } from '../http-proxy/http-proxy-gateway.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { ContainerSshConvergenceService } from '../ssh/container-ssh-convergence.service.js';
import { RuntimeDriftReconcilerService } from '../runtime/runtime-drift-reconciler.service.js';
import { FailStopService } from '../common/fail-stop.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { performance } from 'node:perf_hooks';
import { ZodError } from 'zod';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import {
  assertNetworkClaimCapacity,
  gcExpiredNetworkClaims,
} from '../common/network-claim-ledger.js';

export const MAX_AGENT_INITIALIZING_CONNECTIONS = 8;
export const MAX_AGENT_PENDING_INBOUND_BYTES_PER_SERVER = MAX_AGENT_WS_FRAME_BYTES;
export const MAX_AGENT_PENDING_INBOUND_BYTES_GLOBAL = 64 * 1024 * 1024;
export const MAX_AGENT_STATE_REPORT_QUEUE_AGE_MS = 15_000;
export const SERVER_DELETE_INVENTORY_PROOF_TIMEOUT_MS = 120_000;

type MessageIngress = {
  wallMs: number;
  monotonicMs: number;
};

type ServerDeletionInventoryProofResult = {
  nonce: string;
  sessionId: string;
  sequence: number;
  receivedMonotonicAt: number;
  snapshot: ServerSnapshot;
};

type ServerDeletionInventoryProofChallenge = {
  nonce: string;
  sessionId: string;
  minimumSequence: number;
  startedMonotonicAt: number;
  promise: Promise<ServerDeletionInventoryProofResult>;
  resolve: (proof: ServerDeletionInventoryProofResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class AgentIdentityFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentIdentityFaultError';
  }
}

class BackendBootstrapStateFaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BackendBootstrapStateFaultError';
  }
}

class AgentInventoryFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentInventoryFaultError';
  }
}

export interface SessionFenceOptions {
  /**
   * A never-connected registration can be deleted directly. Once a physical
   * host/network identity was bound, deletion must linearize against a fresh,
   * empty authoritative inventory before retiring the session.
   */
  requireBoundServerEmptyInventory?: boolean;
  /**
   * Optionally authorize and claim the process-local fence at one caller-owned
   * linearization point. The caller may invoke `claim` synchronously inside a
   * serialized database transaction after checking current authority. This
   * prevents a revoked actor from fencing an Agent without keeping that
   * database lease across inventory collection or route revocation.
   */
  authorizeAndClaim?: (claim: () => void) => Promise<void>;
}

@Injectable()
export class AgentGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentGateway.name);
  private wss: WebSocketServer | null = null;
  private sessions: Map<string, AgentSession> = new Map();
  private readonly initializingSockets = new Set<WebSocket>();
  /** Serialize session lifecycle and inbound effects for each physical server. */
  private readonly serverWorkTails = new Map<string, Promise<void>>();
  private readonly inboundWorkDepth = new Map<string, number>();
  private readonly inboundWorkBytes = new Map<string, number>();
  private inboundWorkBytesTotal = 0;
  private readonly pendingHeartbeatServers = new Set<string>();
  private readonly overloadedSessions = new WeakSet<AgentSession>();
  /** Short-lived admission fence used while credentials or the server row change. */
  private readonly sessionAdmissionBlocks = new Set<string>();
  private readonly committedStateReportSequences = new Map<
    string,
    { sessionId: string; sequence: number }
  >();
  private readonly serverDeletionInventoryProofs = new Map<
    string,
    ServerDeletionInventoryProofChallenge
  >();
  private sessionWatchdog: ReturnType<typeof setInterval> | null = null;
  private unregisterServerBlockListener: (() => void) | null = null;
  private destroyed = false;

  readonly stateCache = new StateCache();

  private readonly logChunkTracker = new LogChunkTracker();
  private readonly reportedUnknownXfsNumericIdsByServer = new Map<string, Set<number>>();

  constructor(
    @InjectRepository(ServerEntity)
    private serversRepo: Repository<ServerEntity>,
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
    @InjectRepository(ContainerLifecycleEntity)
    private containerLifecyclesRepo: Repository<ContainerLifecycleEntity>,
    @InjectRepository(ContainerMountEntity)
    private containerMountsRepo: Repository<ContainerMountEntity>,
    private metricsWriter: MetricsWriter,
    private execSessionRegistry: ExecSessionRegistry,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    private taskDispatcher: AgentTaskDispatcherService,
    private taskResults: AgentTaskResultService,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private remoteFsAssignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsMountsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(AgentTaskEntity)
    private agentTasksRepo: Repository<AgentTaskEntity>,
    private taskPayloadCodec: AgentTaskPayloadCodecService,
    private dataSource: DataSource,
    private agentTasks: AgentTasksService,
    private resourceKeys: ResourceKeyService,
    private runtimeDriftReconciler: RuntimeDriftReconcilerService,
    @Inject(forwardRef(() => DataDirReconcilerService))
    private dataDirReconciler: DataDirReconcilerService,
    @Inject(forwardRef(() => ContainerSshRouteService))
    private sshRoutes: ContainerSshRouteService,
    @Inject(forwardRef(() => SshProxyGateway))
    private sshProxyGateway: SshProxyGateway,
    @Inject(forwardRef(() => HttpProxyGateway))
    private httpProxyGateway: HttpProxyGateway,
    @Inject(forwardRef(() => ContainerSshConvergenceService))
    private sshConvergence: ContainerSshConvergenceService,
    private failStop: FailStopService,
    private proxySnapshots: ProxySnapshotNotifierService,
    @InjectRepository(NetworkAddressClaimEntity)
    private addressClaimsRepo: Repository<NetworkAddressClaimEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Process-local sessions never survive a Backend restart. Clear stale
    // durable presentation state before any HTTP/WebSocket listener exists.
    await this.serversRepo.createQueryBuilder()
      .update(ServerEntity)
      .set({ status: ServerStatus.Offline })
      .where('status != :quarantined', { quarantined: ServerStatus.AgentQuarantined })
      .execute();
    await this.sshRoutes.clearAll();
    this.execSessionRegistry.setOrphanHandler((sessionId, info) => {
      this.logChunkTracker.removeSession(sessionId);
      this.notify(info.serverId, 'execClose', { sessionId });
    });
    this.unregisterServerBlockListener = this.proxySnapshots.registerServerBlockListener(
      (serverId, reason) => {
        if (!this.sessions.has(serverId)) return;
        void this.fenceSession(serverId, reason).catch((error) => {
          this.logger.error(
            `Blocked Agent session retirement failed for ${serverId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      },
    );
    this.taskDispatcher.registerTransport({
      onlineServerIds: () => this.dispatchReadyServerIds(),
      send: (serverId, payload) => this.sendTask(serverId, payload),
      quarantine: (serverId, reason) => this.fenceSession(serverId, reason),
    });
    this.logChunkTracker.start();
    this.sessionWatchdog = setInterval(() => this.expireSilentSessions(), 5_000);
    this.sessionWatchdog.unref?.();
  }

  onModuleDestroy() {
    this.destroyed = true;
    this.logChunkTracker.stop();
    if (this.sessionWatchdog) clearInterval(this.sessionWatchdog);
    this.sessionWatchdog = null;
    this.unregisterServerBlockListener?.();
    this.unregisterServerBlockListener = null;
    for (const ws of this.initializingSockets) ws.terminate();
    this.initializingSockets.clear();
    for (const session of this.sessions.values()) {
      session.rejectAll('Backend gateway shutting down');
      session.ws.terminate();
    }
    this.sessions.clear();
    this.inboundWorkDepth.clear();
    this.inboundWorkBytes.clear();
    this.inboundWorkBytesTotal = 0;
    this.pendingHeartbeatServers.clear();
    for (const [serverId, proof] of this.serverDeletionInventoryProofs) {
      this.rejectServerDeletionInventoryProof(
        serverId,
        proof,
        new Error('Backend gateway shutting down'),
      );
    }
    this.committedStateReportSequences.clear();
    this.wss?.close();
  }

  attachToHttpServer(server: http.Server): void {
    // noServer mode: each WebSocketServer only handles its own upgrade path.
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_AGENT_WS_FRAME_BYTES,
      perMessageDeflate: false,
    });
    server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
      if (req.url?.split('?')[0] !== '/ws/agent') return;
      try {
        this.wss!.handleUpgrade(req, socket as import('stream').Duplex, head, (ws) => {
          this.wss!.emit('connection', ws, req);
        });
      } catch {
        socket.destroy();
      }
    });
    this.wss.on('connection', (ws, req) => {
      // Install transport guards synchronously; authentication performs I/O.
      ws.on('error', (error) => {
        this.logger.warn(`Agent WS error during/after admission: ${error.message}`);
      });
      void this.handleConnection(ws, req).catch((error) => {
        this.logger.error(`Agent connection setup failed: ${error instanceof Error ? error.message : String(error)}`);
        ws.terminate();
      });
    });
    this.logger.log('Agent WebSocket gateway ready at /ws/agent');
  }

  private enqueueServerWork<T>(serverId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.serverWorkTails.get(serverId) ?? Promise.resolve();
    const execution = previous.then(work, work);
    const tail = execution.then(() => undefined, () => undefined);
    this.serverWorkTails.set(serverId, tail);
    void tail.finally(() => {
      if (this.serverWorkTails.get(serverId) === tail) this.serverWorkTails.delete(serverId);
    });
    return execution;
  }

  // ---------------------------------------------------------------------------
  // Connection handling
  // ---------------------------------------------------------------------------

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    if (this.destroyed || this.initializingSockets.size >= MAX_AGENT_INITIALIZING_CONNECTIONS) {
      ws.terminate();
      return;
    }
    this.initializingSockets.add(ws);
    let preAdmissionViolation = false;
    const rejectPreAdmissionFrame = () => {
      preAdmissionViolation = true;
      this.logger.warn('Agent sent application data before durable admission acknowledgement');
      ws.terminate();
    };
    ws.on('message', rejectPreAdmissionFrame);
    try {
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        ws.terminate();
        return;
      }

      const rawToken = authHeader.slice(7);
      const hash = createHash('sha256').update(rawToken).digest('hex');
      const server = await this.serversRepo.findOne({ where: { agentTokenHash: hash } });
      if (!server || preAdmissionViolation || this.destroyed || ws.readyState !== WebSocket.OPEN) {
        ws.terminate();
        return;
      }

      await this.enqueueServerWork(server.id, async () => {
      // Authentication happened before entering the per-server queue. Re-read
      // inside it so token rotation/deletion cannot race a stale successful
      // lookup into a newly authoritative session.
      const currentServer = await this.serversRepo.findOneBy({ id: server.id });
      if (
        !currentServer
        || currentServer.agentTokenHash !== hash
        || preAdmissionViolation
        || this.destroyed
        || ws.readyState !== WebSocket.OPEN
      ) {
        ws.terminate();
        return;
      }
      if (this.sessionAdmissionBlocks.has(server.id)) {
        ws.terminate();
        return;
      }
      if (currentServer.status === ServerStatus.AgentQuarantined) {
        ws.terminate();
        return;
      }
      if (preAdmissionViolation || ws.readyState !== WebSocket.OPEN) return;
      const existing = this.sessions.get(server.id);
      if (existing) {
        // Availability is deliberately secondary to fencing. A second socket
        // never replaces a still-authoritative Agent; heartbeat expiry or the
        // explicit session fence must retire the old connection first.
        ws.terminate();
        return;
      }

      const session = new AgentSession(server.id, ws);
      this.proxySnapshots.blockServer(server.id, 'agent session initializing');
      this.sessions.set(server.id, session);
      this.stateCache.set(server.id, this.emptySnapshot(server.id, session.id, Date.now()));
      this.logger.log(`Agent connected: server=${currentServer.name} (${currentServer.id})`);

      ws.off('message', rejectPreAdmissionFrame);
      ws.on('message', (raw) => {
        this.receiveMessage(session, currentServer, raw.toString());
      });
      ws.on('close', (code) => {
        // Revoke process-local route renewal immediately, but retain the
        // session object until frames received before close (notably an
        // inventoryFault) drain through the serialized server queue.
        this.proxySnapshots.blockServer(currentServer.id, 'Agent disconnected');
        session.rejectAll('Agent disconnected');
        void this.enqueueServerWork(
          currentServer.id,
          async () => {
            // Drain every frame received before the close frame first. In
            // particular, inventoryFault must durably quarantine the shared
            // network before this process-local session is forgotten.
            if (this.sessions.get(currentServer.id) !== session) return;
            await this.quarantineIncompleteInitialization(
              session,
              currentServer.id,
              'Agent disconnected before its first authoritative state report completed',
              code,
            );
            if (!this.retireProcessLocalSession(session, currentServer.id, 'Agent disconnected')) return;
            await this.handleDisconnect(currentServer);
          },
        ).catch((error: unknown) => {
          this.logger.error(
            `Agent disconnect cleanup failed for ${currentServer.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      });
      if (!session.send({
        id: undefined,
        ts: Date.now(),
        kind: 'admission.ready.v1',
        payload: { serverId: currentServer.id },
      })) {
        const retired = this.retireProcessLocalSession(
          session,
          currentServer.id,
          'Agent admission acknowledgement could not be delivered',
        );
        ws.terminate();
        if (retired) await this.handleDisconnect(currentServer);
        return;
      }
      });
    } finally {
      ws.off('message', rejectPreAdmissionFrame);
      this.initializingSockets.delete(ws);
    }
  }

  private async handleDisconnect(server: ServerEntity): Promise<void> {
    this.logger.log(`Agent disconnected: server=${server.name}`);
    await this.revokeRetiredSessionRoutes(server.id, 'agent_disconnected');
  }

  private retireProcessLocalSession(
    session: AgentSession,
    serverId: string,
    reason: string,
  ): boolean {
    if (this.sessions.get(serverId) !== session) return false;
    const deletionProof = this.serverDeletionInventoryProofs.get(serverId);
    if (deletionProof?.sessionId === session.id) {
      this.rejectServerDeletionInventoryProof(
        serverId,
        deletionProof,
        new ConflictException({
          code: 'SERVER_DELETE_INVENTORY_SESSION_LOST',
          message: 'The Agent session closed before deletion inventory proof committed',
          serverId,
        }),
      );
    }
    this.sessions.delete(serverId);
    this.stateCache.delete(serverId);
    this.committedStateReportSequences.delete(serverId);
    this.reportedUnknownXfsNumericIdsByServer.delete(serverId);
    this.logChunkTracker.clearServer(serverId);
    this.execSessionRegistry.clearServer(serverId, false);
    this.proxySnapshots.blockServer(serverId, reason);
    session.rejectAll(reason);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Message routing
  // ---------------------------------------------------------------------------

  private receiveMessage(session: AgentSession, server: ServerEntity, raw: string): void {
    const ingress: MessageIngress = {
      wallMs: Date.now(),
      monotonicMs: performance.now(),
    };
    // An RPC acknowledgement must not wait behind the serialized hello handler
    // that is itself awaiting that acknowledgement. It is connection-local,
    // mutates no durable state, and is fenced by object identity.
    try {
      const envelope = zEnvelope.parse(JSON.parse(raw)) as AgentToBackendMessage;
      if (this.sessions.get(server.id) !== session) return;
      // Liveness belongs to the authenticated socket, not to the durable work
      // queue. A long hello/bootstrap must not hide already-received heartbeats
      // behind itself and trigger the 20-second watchdog.
      session.markInbound();
      if (envelope.kind === 'commandAck') {
        if (!session.hasReceivedHello) {
          void this.enqueueServerWork(server.id, () =>
            this.rejectSession(session, server.id, 'Hello required'))
            .catch((error) => this.handleNonAuthoritativeWorkFailure(
              session,
              server.id,
              'pre-hello command acknowledgement rejection',
              error,
            ));
          return;
        }
        const ack = zCommandAckPayload.parse(envelope.payload);
        session.resolveAck(ack.commandId, ack.ok, ack.error, ack.data);
        return;
      }
      if (envelope.kind === 'heartbeat') {
        const heartbeat = zHeartbeatPayload.parse(envelope.payload);
        if (heartbeat.serverId !== server.id) {
          void this.enqueueServerWork(server.id, () =>
            this.rejectSession(session, server.id, 'Heartbeat server identity mismatch'))
            .catch((error) => this.handleNonAuthoritativeWorkFailure(
              session,
              server.id,
              'heartbeat identity rejection',
              error,
            ));
          return;
        }
        // Socket liveness was recorded above. Coalesce the durable lastSeen
        // write to at most one queued item per server; periodic heartbeats can
        // never starve an initial full report or exhaust inbound capacity.
        if (!session.bootstrapReady || this.pendingHeartbeatServers.has(server.id)) return;
        this.pendingHeartbeatServers.add(server.id);
        void this.enqueueServerWork(
          server.id,
          () => this.onHeartbeat(server, heartbeat, session),
        ).catch((error) => this.handleNonAuthoritativeWorkFailure(
          session,
          server.id,
          'heartbeat persistence',
          error,
        )).finally(() => this.pendingHeartbeatServers.delete(server.id));
        return;
      }
      if (envelope.kind === 'logChunk' && session.hasReceivedHello) {
        // Console output is an authenticated, process-local, lossy stream. It
        // must never sit behind durable inventory work or consume the bounded
        // authoritative queue: a noisy command such as `yes` would otherwise
        // quarantine a perfectly healthy Agent.
        const parsed = zLogChunkPayload.safeParse(envelope.payload);
        if (!parsed.success) {
          this.logger.warn(`Ignoring invalid log chunk from ${server.id}: ${parsed.error.message}`);
          return;
        }
        const chunk = parsed.data;
        const execSession = this.execSessionRegistry.get(chunk.sessionId);
        if (!execSession || execSession.serverId !== server.id) {
          this.logger.warn(`Ignoring log chunk for an unowned exec session from server ${server.id}`);
          return;
        }
        try {
          this.logChunkTracker.dispatch(chunk);
        } catch (error) {
          // A dead/slow browser is scoped to its interactive session. Retire
          // that exec best-effort; never escalate it into Agent quarantine.
          this.logChunkTracker.removeSession(chunk.sessionId);
          this.execSessionRegistry.remove(chunk.sessionId);
          try { this.notify(server.id, 'execClose', { sessionId: chunk.sessionId }); } catch { /* fenced */ }
          this.logger.warn(
            `Closing failed console stream ${chunk.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
      if (envelope.kind === 'metricsBatch' && this.serverWorkTails.has(server.id)) {
        // Metrics are lossy. Never queue them behind authoritative work.
        return;
      }
    } catch {
      // The serialized handler owns protocol-error logging and connection close.
    }
    const depth = this.inboundWorkDepth.get(server.id) ?? 0;
    const rawBytes = Buffer.byteLength(raw);
    const pendingBytes = this.inboundWorkBytes.get(server.id) ?? 0;
    const serverCapacityExceeded =
      depth >= 128
      || rawBytes > MAX_AGENT_PENDING_INBOUND_BYTES_PER_SERVER
      || pendingBytes > MAX_AGENT_PENDING_INBOUND_BYTES_PER_SERVER - rawBytes;
    const globalCapacityExceeded =
      rawBytes > MAX_AGENT_PENDING_INBOUND_BYTES_GLOBAL
      || this.inboundWorkBytesTotal > MAX_AGENT_PENDING_INBOUND_BYTES_GLOBAL - rawBytes;
    if (globalCapacityExceeded && !serverCapacityExceeded) {
      // Global pressure can be caused by otherwise-correct Agents whose
      // independent state reports happen to overlap. Revoke this session's
      // routes and reconnect it, but do not turn Backend load into durable
      // evidence that this physical host is unsafe.
      this.logger.warn(`Backend Agent inbound global capacity reached; reconnecting ${server.id}`);
      this.proxySnapshots.blockServerRoutes(
        server.id,
        'Backend Agent inbound global capacity reached',
      );
      session.rejectAll('Backend Agent inbound global capacity reached');
      session.ws.terminate();
      return;
    }
    if (serverCapacityExceeded) {
      this.logger.warn(`Agent inbound work limit exceeded for server ${server.id}`);
      if (this.overloadedSessions.has(session)) {
        session.ws.terminate();
        return;
      }
      this.overloadedSessions.add(session);
      this.proxySnapshots.blockServer(server.id, 'Agent inbound work limit exceeded');
      session.rejectAll('Agent inbound work limit exceeded');
      void this.enqueueServerWork(server.id, async () => {
        await this.persistInventoryQuarantine(
          server.id,
          'Authenticated Agent inbound queue exceeded its bounded capacity',
        );
        if (this.retireProcessLocalSession(session, server.id, 'Agent inbound work limit exceeded')) {
          await this.handleDisconnect(server);
        }
      }).catch((error) => {
          this.logger.error(
            `Agent overload disconnect cleanup failed for ${server.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      session.ws.terminate();
      return;
    }
    this.inboundWorkDepth.set(server.id, depth + 1);
    this.inboundWorkBytes.set(server.id, pendingBytes + rawBytes);
    this.inboundWorkBytesTotal += rawBytes;
    const work = this.enqueueServerWork(
      server.id,
      () => this.handleMessage(session, server, raw, ingress),
    );
    void work.then(
      () => this.decrementInboundWork(server.id, rawBytes),
      () => this.decrementInboundWork(server.id, rawBytes),
    );
  }

  private decrementInboundWork(serverId: string, rawBytes: number): void {
    const next = (this.inboundWorkDepth.get(serverId) ?? 1) - 1;
    if (next <= 0) this.inboundWorkDepth.delete(serverId);
    else this.inboundWorkDepth.set(serverId, next);
    const nextBytes = (this.inboundWorkBytes.get(serverId) ?? rawBytes) - rawBytes;
    if (nextBytes <= 0) this.inboundWorkBytes.delete(serverId);
    else this.inboundWorkBytes.set(serverId, nextBytes);
    this.inboundWorkBytesTotal = Math.max(0, this.inboundWorkBytesTotal - rawBytes);
  }

  private handleNonAuthoritativeWorkFailure(
    session: AgentSession,
    serverId: string,
    context: string,
    error: unknown,
  ): void {
    this.logger.error(
      `Agent ${context} failed for ${serverId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (this.sessions.get(serverId) !== session) return;
    // The durable state is unknown only for this liveness update. Fence the
    // connection and let the close path revoke process-local routes; this is
    // reconnectable and is not authoritative-inventory quarantine evidence.
    session.rejectAll(`Agent ${context} failed`);
    session.ws.terminate();
  }

  private async handleMessage(
    session: AgentSession,
    server: ServerEntity,
    raw: string,
    ingress: MessageIngress = { wallMs: Date.now(), monotonicMs: performance.now() },
  ): Promise<void> {
    if (this.sessions.get(server.id) !== session) {
      this.logger.warn(`Ignoring message from stale agent session for server ${server.id}`);
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      this.logger.warn(`Invalid envelope from agent ${server.id}`);
      try {
        await this.taskResults.quarantineProtocolFault(server.id, error);
      } finally {
        await this.rejectSession(session, server.id, 'Invalid Agent envelope');
      }
      return;
    }
    const parsedEnvelope = zEnvelope.safeParse(decoded);
    if (!parsedEnvelope.success) {
      this.logger.warn(`Invalid envelope from agent ${server.id}`);
      try {
        await this.taskResults.quarantineProtocolFault(server.id, parsedEnvelope.error);
      } finally {
        await this.rejectSession(session, server.id, 'Invalid Agent envelope');
      }
      return;
    }

    const msg = parsedEnvelope.data as AgentToBackendMessage;
    session.markInbound();

    if (msg.kind === 'hello') {
      if (!session.beginHello()) {
        await this.rejectSession(session, server.id, 'Duplicate hello');
        return;
      }
    } else if (!session.hasReceivedHello) {
      await this.rejectSession(session, server.id, 'Hello required');
      return;
    }

    if (
      msg.kind === 'stateReport'
      && performance.now() - ingress.monotonicMs > MAX_AGENT_STATE_REPORT_QUEUE_AGE_MS
    ) {
      this.logger.warn(
        `Dropping stale state report queued for server ${server.id}; a fresh full report is required`,
      );
      return;
    }

    try {
      switch (msg.kind) {
        case 'hello':
          await this.onHello(server, zHelloPayload.parse(msg.payload), session);
          break;
        case 'heartbeat': {
          const heartbeat = zHeartbeatPayload.parse(msg.payload);
          if (heartbeat.serverId !== server.id) {
            await this.rejectSession(session, server.id, 'Heartbeat server identity mismatch');
            break;
          }
          await this.onHeartbeat(server, heartbeat, session);
          break;
        }
        case 'inventoryFault': {
          const fault = zInventoryFaultPayload.parse(msg.payload) as InventoryFaultPayload;
          if (fault.serverId !== server.id) {
            await this.rejectSession(session, server.id, 'Inventory fault server identity mismatch');
            break;
          }
          await this.onInventoryFault(server, fault, session);
          break;
        }
        case 'stateReport': {
          const report = zStateReportPayload.parse(msg.payload);
          if (report.serverId !== server.id) {
            await this.persistInventoryQuarantine(
              server.id,
              'State report server identity mismatch',
            );
            await this.rejectSession(session, server.id, 'State report server identity mismatch');
            break;
          }
          if (!session.acceptReportSequence('state', report.sequence)) {
            this.logger.warn(`Ignoring stale stateReport sequence ${report.sequence} for server ${server.id}`);
            break;
          }
          if (!await this.validStateReportInventory(server.id, report)) {
            await this.persistInventoryQuarantine(
              server.id,
              'State report inventory identity or address claim mismatch',
            );
            await this.rejectSession(session, server.id, 'State report inventory identity mismatch');
            break;
          }
          await this.onStateReport(
            server,
            report,
            session,
            ingress.wallMs,
            ingress.monotonicMs,
          );
          break;
        }
        case 'metricsBatch': {
          const parsed = zMetricsBatchPayload.safeParse(msg.payload);
          if (!parsed.success) {
            this.logger.warn(
              `Ignoring invalid lossy metrics batch from ${server.id}: ${parsed.error.message}`,
            );
            break;
          }
          const batch = parsed.data as MetricsBatchPayload;
          if (batch.serverId !== session.serverId) {
            this.logger.warn(`metricsBatch serverId mismatch: payload=${batch.serverId} connection=${session.serverId}, ignoring`);
            break;
          }
          try {
            await this.onMetricsBatch(batch);
          } catch (error) {
            this.logger.warn(
              `Dropping lossy metrics batch from ${server.id}: `
              + `${error instanceof Error ? error.message : String(error)}`,
            );
          }
          break;
        }
        case 'commandAck': {
          const ack = zCommandAckPayload.parse(msg.payload);
          session.resolveAck(ack.commandId, ack.ok, ack.error, ack.data);
          break;
        }
        case 'task.result.v1': {
          const parsed = zTaskResultPayload.safeParse(msg.payload);
          if (!parsed.success) {
            await this.taskResults.quarantineMalformedResult(
              server.id,
              msg.payload,
              parsed.error,
            );
            throw new Error('Malformed Agent task result quarantined');
          }
          const result = parsed.data;
          const accepted = await this.taskResults.handle(server.id, result);
          // A terminal or incomplete result releases the physical execution
          // slot. Wake immediately so safety cleanup throughput is bounded by
          // execution, not the periodic dispatcher tick.
          this.taskDispatcher.wake();
          if (accepted) {
            session.send({
              id: undefined,
              ts: Date.now(),
              kind: 'task.accepted.v1',
              payload: accepted,
            });
          }
          // A recovery session deliberately remains proxy-blocked while it
          // executes Pending safety work. Fence only a durable fail-stop
          // quarantine, not the route-only recovery gate itself.
          const durableServer = await this.serversRepo.findOneBy({ id: server.id });
          if (!durableServer || durableServer.status === ServerStatus.AgentQuarantined) {
            await this.rejectSession(session, server.id, 'Agent task result entered fail-stop quarantine');
          }
          break;
        }
        // Authenticated log chunks are handled synchronously in receiveMessage
        // so interactive output can never consume durable queue capacity.
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
          await this.taskResults.quarantineProtocolFault(
            server.id,
            new Error(`Unsupported Agent message kind ${(msg as { kind: string }).kind}`),
          );
          await this.rejectSession(session, server.id, 'Unsupported Agent message kind');
      }
    } catch (err) {
      this.logger.error(`Error handling message ${msg.kind} from ${server.id}: ${err}`);
      if (msg.kind === 'stateReport') {
        const authoritativeFault = err instanceof ZodError
          || err instanceof AgentInventoryFaultError
          || err instanceof DataDirInventoryFaultError
          || err instanceof BackendBootstrapStateFaultError;
        if (authoritativeFault) {
          try {
            await this.persistInventoryQuarantine(
              server.id,
              `State report processing failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            await this.rejectSession(session, server.id, 'State report inventory failed');
          }
        } else {
          // A valid full report may fail while Backend reads or commits its own
          // durable projections. No Agent-authored negative evidence exists;
          // retire this generation and rebuild from the next complete report.
          await this.rejectSession(session, server.id, 'State report Backend processing failed');
        }
        return;
      }
      if (err instanceof ZodError) {
        try {
          await this.taskResults.quarantineProtocolFault(server.id, err);
        } finally {
          await this.rejectSession(session, server.id, 'Invalid Agent protocol payload');
        }
        return;
      }
      if (msg.kind === 'hello') await this.rejectSession(session, server.id, 'Invalid hello');
      // A rejected terminal result may be cached by the stateless Agent for
      // this connection. Retire it so transient storage failures can recover
      // on a fresh reconciliation; structurally impossible evidence has
      // already durably quarantined the server and will reject reconnects.
      if (msg.kind === 'task.result.v1') await this.rejectSession(session, server.id, 'Task result rejected');
      if (this.sessions.get(server.id) === session) {
        await this.rejectSession(session, server.id, 'Agent message processing failed');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------

  private async onHello(
    server: ServerEntity,
    payload: HelloPayload,
    session?: AgentSession,
  ): Promise<void> {
    if (!await this.bindHostFingerprint(server, payload, session)) return;

    this.logger.log(
      `Hello from ${server.name}: ${payload.hostname}, ${payload.gpus.length} GPUs, agentVersion=${payload.agentVersion}`,
    );

    // A socket and hello are not enough to expose the Agent as ready. Keep the
    // durable server status explicit until the authoritative mount bootstrap
    // has converged and the task dispatch gate is opened.
    const helloStatus = await this.transitionServerLiveness(
      server.id,
      () => ServerStatus.AgentStateUnready,
    );
    if (helloStatus === ServerStatus.AgentQuarantined) {
      if (session) await this.rejectSession(session, server.id, 'Agent server is quarantined');
      return;
    }

    // Reset stateCache so stale containers from the previous agent lifecycle are
    // cleared before the fresh stateReport arrives.
    const snap: ServerSnapshot = {
      serverId: server.id,
      runtimeReady: false,
      sessionId: session?.id ?? this.sessions.get(server.id)?.id ?? '',
      helloAt: Date.now(),
      lastFullReportAt: null,
      lastFullReportReceivedAt: null,
      lastUpdated: Date.now(),
      agentVersion: payload.agentVersion,
      hostname: payload.hostname,
      cpuCores: payload.cpuCores,
      totalMemBytes: payload.totalMemBytes,
      dockerRoot: payload.dockerRoot,
      containers: new Map(),
      disks: payload.disks,
      gpus: payload.gpus,
      xfsProjects: [],
      unknownXfsNumericIds: [],
      localImages: payload.localImages,
      dataDirs: [],
      dataDirIssues: { orphans: [], missing: [] },
      remoteFsMounts: [],
      dockerDaemon: null,
    };
    this.stateCache.set(server.id, snap);

    if (!session) return;
    let bootstrapRpcStarted = false;
    try {
      const remoteFsMounts = await this.activeRemoteFsBootstrap(server.id);
      let bootstrapPayload: ReturnType<typeof zAgentBootstrapPayload.parse>;
      try {
        bootstrapPayload = zAgentBootstrapPayload.parse({ remoteFsMounts });
      } catch (error) {
        throw new BackendBootstrapStateFaultError(
          'Durable RemoteFS bootstrap payload is invalid',
          { cause: error },
        );
      }
      const bootstrapFrameBytes = Buffer.byteLength(JSON.stringify({
        id: '00000000-0000-0000-0000-000000000000',
        ts: Number.MAX_SAFE_INTEGER,
        kind: 'agent.bootstrap.v1',
        payload: bootstrapPayload,
      }));
      if (bootstrapFrameBytes > MAX_AGENT_WS_FRAME_BYTES) {
        throw new BackendBootstrapStateFaultError(
          `RemoteFS bootstrap frame is ${bootstrapFrameBytes} bytes; maximum is ${MAX_AGENT_WS_FRAME_BYTES}`,
        );
      }
      bootstrapRpcStarted = true;
      const bootstrap = zAgentBootstrapResult.parse(
        await session.rpc<AgentBootstrapResult>(
          'agent.bootstrap.v1',
          bootstrapPayload,
          AGENT_BOOTSTRAP_RPC_TIMEOUT_MS,
        ),
      );
      this.assertBootstrapReady(remoteFsMounts, bootstrap);
      if (this.sessions.get(server.id) !== session) return;
      // Bootstrap precedes the first full runtime report, so the ordinary
      // runtime-ready event guard intentionally cannot be used here.
      snap.remoteFsMounts = bootstrap.remoteFsMounts;
      snap.lastUpdated = Date.now();
      session.markBootstrapReady();
      session.send({
        id: undefined,
        ts: Date.now(),
        kind: 'reconcile',
        payload: { serverId: server.id },
      } as BackendToAgentMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Agent bootstrap failed [${server.name}]: ${message}`,
      );
      if (this.destroyed) return;
      if (!bootstrapRpcStarted) {
        if (error instanceof BackendBootstrapStateFaultError) {
          await this.persistInventoryQuarantine(
            server.id,
            `Backend bootstrap state invalid: ${message}`,
            { preserveExisting: true },
          );
        }
        // A repository/transaction failure before any bootstrap frame was
        // sent has no Agent-authored evidence. The deterministic state-fault
        // branch above remains quarantined; ordinary Backend availability
        // errors simply retry from the durable model on a later connection.
        if (this.sessions.get(server.id) === session) {
          await this.rejectSession(session, server.id, 'Backend bootstrap preparation failed');
        }
        return;
      }
      if (
        error instanceof AgentRpcTransportError
        || this.sessions.get(server.id) !== session
        || session.ws.readyState !== WebSocket.OPEN
      ) {
        // No Agent-authored bootstrap evidence exists. A lost socket may have
        // interrupted either the observation-only snapshot adoption or the
        // bounded static Docker bootstrap, both of which are serialized again
        // on reconnect. Retire this generation without inventing quarantine.
        if (this.sessions.get(server.id) === session) {
          await this.rejectSession(session, server.id, 'Agent bootstrap transport lost');
        }
        return;
      }
      // Bootstrap is an authoritative observation. Reconnecting to the same
      // explicitly rejected or structurally invalid desired state is an
      // unbounded loop, so persist a fail-stop state that requires operator
      // repair. An open-socket RPC timeout is likewise a bounded initialization
      // failure, but a transport-class rejection above is not evidence.
      await this.persistInventoryQuarantine(
        server.id,
        `Agent bootstrap failed: ${message}`,
        { preserveExisting: true },
      );
      if (this.sessions.get(server.id) === session) {
        await this.rejectSession(session, server.id, 'Agent bootstrap failed');
      }
    }
  }

  private async bindHostFingerprint(
    server: ServerEntity,
    payload: HelloPayload,
    session?: AgentSession,
  ): Promise<boolean> {
    if (payload.serverId !== server.id) {
      if (session) {
        await this.rejectAgentIdentityFault(
          session,
          server.id,
          'Agent server identity mismatch',
        );
      }
      return false;
    }
    const reservedIps = [...(payload.macvlanReservedIps ?? [])].sort();
    const staticAddresses = [payload.macvlanGateway, ...reservedIps];
    let networkIdentityValid = false;
    try {
      const { prefixLen } = parseCidr(payload.macvlanCidr);
      networkIdentityValid = prefixLen >= 16
        && prefixLen <= 30
        && canonicalIpv4Cidr(payload.macvlanCidr) === payload.macvlanCidr
        && canonicalIpv4Address(payload.macvlanGateway) === payload.macvlanGateway
        && reservedIps.every((ip) => canonicalIpv4Address(ip) === ip)
        && isUsableHostInCidr(payload.macvlanCidr, payload.macvlanGateway)
        && new Set(reservedIps).size === reservedIps.length
        && !reservedIps.includes(payload.macvlanGateway)
        && reservedIps.every((ip) => isUsableHostInCidr(payload.macvlanCidr, ip));
    } catch {
      networkIdentityValid = false;
    }
    if (!networkIdentityValid) {
      if (session) {
        await this.rejectAgentIdentityFault(
          session,
          server.id,
          'Agent network identity is invalid',
        );
      }
      return false;
    }
    try {
      const persisted = await runSerializedTransaction(this.dataSource, async (manager) => {
        const current = await manager.findOneBy(ServerEntity, { id: server.id });
        if (!current) throw new Error('Server no longer exists');
        const boundHost = current.hostFingerprint ?? null;
        const boundConfig = current.agentConfigFingerprint ?? null;
        if ((boundHost === null) !== (boundConfig === null)) {
          throw new AgentIdentityFaultError('Agent identity binding is incomplete');
        }
        if (boundHost && boundHost !== payload.hostFingerprint) {
          throw new AgentIdentityFaultError('Agent host identity mismatch');
        }
        if (boundConfig && boundConfig !== payload.configFingerprint) {
          throw new AgentIdentityFaultError('Agent static configuration identity mismatch');
        }
        if (boundHost) {
          const currentReserved = [...(current.macvlanReservedIps ?? [])].sort();
          if (
            current.macvlanCidr !== payload.macvlanCidr
            || current.macvlanGateway !== payload.macvlanGateway
            || JSON.stringify(currentReserved) !== JSON.stringify(reservedIps)
          ) throw new AgentIdentityFaultError('Agent network identity mismatch');
        }

        await gcExpiredNetworkClaims(manager);

        const [staticClaimRows, runtimeClaimRows, networkServers] = await Promise.all([
          manager.find(NetworkAddressClaimEntity, {
            where: {
              address: In(staticAddresses),
              ownerKind: In(['gateway', 'host']),
            },
          }),
          manager.find(NetworkAddressClaimEntity, {
            where: {
              address: In(staticAddresses),
              ownerKind: In(['container', 'runtime_cleanup']),
            },
          }),
          manager.find(ServerEntity),
        ]);
        const existingNetworkKeys = new Set(
          networkServers.flatMap((row) => row.macvlanCidr ? [row.macvlanCidr] : []),
        );
        if (networkServers.some((candidate) =>
          candidate.id !== current.id
          && candidate.hostFingerprint === payload.hostFingerprint)) {
          throw new AgentIdentityFaultError('Agent host is already bound to another Server');
        }
        for (const networkKey of existingNetworkKeys) {
          if (networkKey !== payload.macvlanCidr && ipv4CidrsOverlap(networkKey, payload.macvlanCidr)) {
            throw new AgentIdentityFaultError(`Agent CIDR overlaps existing network ${networkKey}`);
          }
        }

        const conflictingRuntime = runtimeClaimRows.find((row) =>
          !(boundHost && row.ownerKind === 'runtime_cleanup' && row.serverId === current.id));
        if (conflictingRuntime) {
          throw new AgentIdentityFaultError(
            `Agent static address ${conflictingRuntime.address} is already owned by a runtime`,
          );
        }
        for (const address of staticAddresses) {
          const existing = [
            ...staticClaimRows.filter((row) => row.address === address),
            ...runtimeClaimRows.filter((row) =>
              row.address === address
              && !(boundHost && row.ownerKind === 'runtime_cleanup' && row.serverId === current.id)),
          ];
          const incomingKind = address === payload.macvlanGateway ? 'gateway' : 'host';
          if (existing.length === 0) continue;
          const sameSharedGateway = incomingKind === 'gateway'
            && existing.every((claim) =>
              claim.ownerKind === 'gateway'
              && claim.networkKey === payload.macvlanCidr);
          const samePhysicalHost = incomingKind === 'host'
            && existing.every((claim) =>
              claim.ownerKind === 'host'
              && claim.ownerId === payload.hostFingerprint);
          if (!sameSharedGateway && !samePhysicalHost) {
            throw new AgentIdentityFaultError(
              `Agent static address ${address} is already owned by another network identity`,
            );
          }
        }
        const newRows = staticAddresses.filter((address) => {
          const expectedKind = address === payload.macvlanGateway ? 'gateway' : 'host';
          const expectedOwnerId = expectedKind === 'gateway'
            ? payload.macvlanCidr
            : payload.hostFingerprint;
          return !staticClaimRows.some((row) =>
            row.address === address
            && row.ownerKind === expectedKind
            && row.ownerId === expectedOwnerId
            && row.state === 'active');
        }).map((address) => manager.create(
          NetworkAddressClaimEntity,
          {
            id: createHash('sha256').update(
              `static:${address === payload.macvlanGateway ? payload.macvlanCidr : payload.hostFingerprint}:${address}`,
            ).digest('hex'),
            address,
            networkKey: payload.macvlanCidr,
            ownerKind: address === payload.macvlanGateway ? 'gateway' : 'host',
            ownerId: address === payload.macvlanGateway ? payload.macvlanCidr : payload.hostFingerprint,
            serverId: null,
            state: 'active',
            reusableAt: null,
          },
        ));
        await assertNetworkClaimCapacity(manager, newRows.length);
        if (newRows.length > 0) await manager.save(NetworkAddressClaimEntity, newRows);
        if (boundHost) {
          return current;
        }
        const update = await manager.update(
          ServerEntity,
          { id: server.id, hostFingerprint: IsNull(), agentConfigFingerprint: IsNull() },
          {
            hostFingerprint: payload.hostFingerprint,
            agentConfigFingerprint: payload.configFingerprint,
            macvlanCidr: payload.macvlanCidr,
            macvlanGateway: payload.macvlanGateway,
            macvlanReservedIps: reservedIps,
          },
        );
        if (update.affected !== 1) {
          throw new AgentIdentityFaultError('Another Agent won the identity binding race');
        }
        return manager.findOneByOrFail(ServerEntity, { id: server.id });
      });
      server.hostFingerprint = persisted.hostFingerprint;
      server.agentConfigFingerprint = persisted.agentConfigFingerprint;
      server.macvlanCidr = persisted.macvlanCidr;
      server.macvlanGateway = persisted.macvlanGateway;
      server.macvlanReservedIps = [...persisted.macvlanReservedIps];
      return true;
    } catch (error) {
      if (session) {
        const message = error instanceof Error ? error.message : 'Agent identity binding failed';
        if (error instanceof AgentIdentityFaultError) {
          await this.rejectAgentIdentityFault(session, server.id, message);
        } else {
          // Database availability and other internal failures provide no
          // negative Agent identity evidence. Fence this socket generation and
          // let a later connection retry the same serialized binding.
          await this.rejectSession(session, server.id, message);
        }
      }
      return false;
    }
  }

  private async rejectAgentIdentityFault(
    session: AgentSession,
    serverId: string,
    message: string,
  ): Promise<void> {
    await this.persistInventoryQuarantine(
      serverId,
      message,
      { preserveExisting: true },
    );
    await this.rejectSession(session, serverId, message);
  }

  private async activeRemoteFsBootstrap(serverId: string): Promise<RemoteFsMountSpec[]> {
    // Assignment, proof task and mount spec form one durable authority
    // snapshot. Retention GC and unassignment use the same serialized
    // transaction boundary, so they cannot create a mixed-read false
    // bootstrap quarantine between these three reads.
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const assignments = await manager.find(RemoteFsServerAssignmentEntity, {
        where: { serverId, desiredState: 'active' },
        order: { remoteFsMountId: 'ASC' },
      });
      if (assignments.length === 0) return [];
      if (assignments.length > MAX_AGENT_REMOTE_FS_MOUNTS) {
        throw new BackendBootstrapStateFaultError(
          `RemoteFS bootstrap has ${assignments.length} assignments; maximum is `
          + `${MAX_AGENT_REMOTE_FS_MOUNTS}`,
        );
      }

      const assignmentIds = assignments.map((assignment) => assignment.remoteFsMountId);
      if (new Set(assignmentIds).size !== assignmentIds.length) {
        throw new BackendBootstrapStateFaultError(
          'RemoteFS bootstrap desired assignments contain duplicate mount ids',
        );
      }

      if (assignments.some((assignment) => !assignment.lastTaskId)) {
        throw new BackendBootstrapStateFaultError(
          'RemoteFS bootstrap has an active assignment without a successful task identity',
        );
      }
      const lastTaskIds = assignments.map((assignment) => assignment.lastTaskId as string);
      const tasks = await manager.find(AgentTaskEntity, {
        select: {
          id: true,
          kind: true,
          status: true,
          serverId: true,
          resourceType: true,
          resourceId: true,
        },
        where: { id: In(lastTaskIds) },
      });
      const tasksById = new Map(tasks.map((task) => [task.id, task]));
      for (const assignment of assignments) {
        const task = tasksById.get(assignment.lastTaskId as string);
        if (
          !task
          || task.kind !== AgentTaskKind.RemoteFsEnsure
          || task.status !== AgentTaskStatus.Succeeded
          || task.serverId !== serverId
          || task.resourceType !== 'remote_fs_mount'
          || task.resourceId !== assignment.remoteFsMountId
        ) {
          throw new BackendBootstrapStateFaultError(
            `RemoteFS bootstrap assignment ${assignment.remoteFsMountId} has no matching successful ensure task`,
          );
        }
      }

      const mounts = await manager.find(RemoteFsMountEntity, {
        where: {
          id: In(assignmentIds),
          desiredState: 'active',
        },
        order: { id: 'ASC' },
      });
      const mountsById = new Map(mounts.map((mount) => [mount.id, mount]));
      if (
        mounts.length !== assignmentIds.length
        || mountsById.size !== mounts.length
        || assignmentIds.some((id) => !mountsById.has(id))
      ) {
        throw new BackendBootstrapStateFaultError(
          'RemoteFS bootstrap has an active assignment without one active mount',
        );
      }
      try {
        return zAgentBootstrapPayload.parse({
          remoteFsMounts: this.taskPayloadCodec.forRemoteFsBootstrap(mounts.map((mount) => ({
            id: mount.id,
            hostMountPoint: mount.hostMountPoint,
            options: mount.options,
            params: mount.params,
          }))),
        }).remoteFsMounts;
      } catch (error) {
        throw new BackendBootstrapStateFaultError(
          'RemoteFS bootstrap durable mount specification is invalid',
          { cause: error },
        );
      }
    });
  }

  private assertBootstrapReady(
    expected: readonly RemoteFsMountSpec[],
    result: AgentBootstrapResult,
  ): void {
    const expectedById = new Map(expected.map((spec) => [spec.id, spec]));
    if (expectedById.size !== expected.length) {
      throw new Error('RemoteFS bootstrap snapshot contains duplicate ids');
    }
    if (result.remoteFsMounts.length !== expected.length) {
      throw new Error('RemoteFS bootstrap result does not match the desired id set');
    }

    const observedIds = new Set<string>();
    for (const status of result.remoteFsMounts) {
      if (observedIds.has(status.id)) {
        throw new Error(`RemoteFS bootstrap returned duplicate id ${status.id}`);
      }
      observedIds.add(status.id);
      const spec = expectedById.get(status.id);
      if (!spec) {
        throw new Error(`RemoteFS bootstrap returned unexpected id ${status.id}`);
      }
      if (status.hostMountPoint !== spec.hostMountPoint) {
        throw new Error(`RemoteFS bootstrap path mismatch for ${status.id}`);
      }
    }
  }

  /**
   * A host reboot loses kernel mounts while Backend still owns a successful
   * desired assignment. Convert that observation into ordinary durable Ensure
   * tasks; bootstrap itself remains free of mount side effects.
   */
  private async scheduleRemoteFsRecoveryTasks(
    serverId: string,
    expected: readonly RemoteFsMountSpec[],
    observed: readonly RemoteFsMountStatus[],
    containers: readonly ContainerSnapshot[],
  ): Promise<string[]> {
    const expectedById = new Map(expected.map((spec) => [spec.id, spec]));
    const observedById = new Map(observed.map((status) => [status.id, status]));
    const repairIds = expected
      .filter((spec) => {
        const status = observedById.get(spec.id);
        return !status
          || status.status !== 'mounted'
          || status.hostMountPoint !== spec.hostMountPoint;
      })
      .map((spec) => spec.id);
    if (repairIds.length === 0) return [];

    const runningContainerIds = containers
      .filter((container) => container.status === ContainerStatus.Running)
      .map((container) => container.labels?.[LABEL.CONTAINER_ID])
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const runningRefs = runningContainerIds.length === 0
      ? []
      : await this.containerMountsRepo.find({
          where: {
            serverId,
            containerId: In(runningContainerIds),
            sourceKind: 'remote',
            sourceId: In(repairIds),
          },
        });
    const blockedByRunningContainer = new Set(runningRefs.map((ref) => ref.sourceId));
    const created: string[] = [];
    const refsByContainer = new Map<string, Set<string>>();
    for (const ref of runningRefs) {
      const mountIds = refsByContainer.get(ref.containerId) ?? new Set<string>();
      mountIds.add(ref.sourceId);
      refsByContainer.set(ref.containerId, mountIds);
    }
    const snapshotsByContainerId = new Map<string, ContainerSnapshot[]>();
    for (const candidate of containers) {
      const productId = candidate.labels?.[LABEL.CONTAINER_ID];
      if (!productId) continue;
      const grouped = snapshotsByContainerId.get(productId) ?? [];
      grouped.push(candidate);
      snapshotsByContainerId.set(productId, grouped);
    }
    for (const [containerId, mountIds] of refsByContainer) {
      try {
        const taskId = await runSerializedTransaction(this.dataSource, async (manager) => {
          const [container, lifecycle, refs, pending] = await Promise.all([
            manager.findOneBy(ContainerEntity, { id: containerId, serverId }),
            manager.findOne(ContainerLifecycleEntity, { where: { containerId } }),
            manager.find(ContainerMountEntity, {
              where: {
                serverId,
                containerId,
                sourceKind: 'remote',
                sourceId: In([...mountIds]),
              },
            }),
            manager.find(AgentTaskEntity, {
              select: { id: true, kind: true },
              where: {
                serverId,
                resourceType: 'container',
                resourceId: containerId,
                status: AgentTaskStatus.Pending,
              },
              order: { createdAt: 'DESC' },
              take: 2,
            }),
          ]);
          if (pending.length > 1) {
            throw new BackendBootstrapStateFaultError(
              `Container ${containerId} has multiple pending task owners during RemoteFS recovery`,
            );
          }
          const snapshot = snapshotsByContainerId.get(containerId)
            ?.find((candidate) => candidate.runtime.runtimeId === lifecycle?.boundRuntimeId);
          if (
            !container
            || !lifecycle
            || !snapshot
            || snapshot.status !== ContainerStatus.Running
            || lifecycle.boundRuntimeId !== snapshot.runtime.runtimeId
            || refs.length === 0
          ) return null;

          // A stop or delete already establishes the required safety barrier.
          // Keep its immutable identity instead of replacing it every report.
          const safetyTask = pending.find((task) =>
            task.kind === AgentTaskKind.ContainerStop
            || task.kind === AgentTaskKind.ContainerDelete);
          if (safetyTask) return safetyTask.id;

          await this.agentTasks.supersedePendingForResourceInTransaction(manager, {
            serverId,
            resourceType: 'container',
            resourceId: containerId,
            reason: 'RemoteFS recovery requires a fresh stopped-container safety barrier',
          });
          const task = await this.agentTasks.enqueueInTransaction(manager, {
            kind: AgentTaskKind.ContainerStop,
            serverId,
            resourceType: 'container',
            resourceId: containerId,
            requestedBy: null,
            request: {
              action: 'safety_stop',
              reason: 'remote_fs_recovery',
              remoteFsMountIds: [...mountIds].sort(),
            },
            payload: {
              containerId,
              runtimeId: snapshot.runtime.runtimeId,
              timeoutSeconds: 30,
            },
            resourceKeys: [this.resourceKeys.container(containerId)],
            admissionClass: 'safety',
            beforeCommit: async (taskManager, context) => {
              await taskManager.update(ContainerLifecycleEntity, containerId, {
                phase: ContainerPhase.Updating,
                activeTaskId: context.taskId,
                lastTransitionAt: new Date(),
                failureReason: null,
                failureCode: null,
              });
            },
          });
          return task.taskId;
        });
        if (taskId && !created.includes(taskId)) created.push(taskId);
      } catch (error) {
        this.logger.warn(
          `RemoteFS safety stop for container ${containerId} deferred on ${serverId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const mountId of repairIds) {
      if (!expectedById.has(mountId)) {
        this.logger.warn(`Ignoring unexpected RemoteFS recovery id ${mountId} on ${serverId}`);
        continue;
      }
      if (blockedByRunningContainer.has(mountId)) {
        this.logger.warn(
          `RemoteFS ${mountId} recovery waiting on ${serverId}: referenced containers must reach stopped state first`,
        );
        continue;
      }
      try {
        const taskId = await runSerializedTransaction(this.dataSource, async (manager) => {
          const [assignment, mount] = await Promise.all([
            manager.findOne(RemoteFsServerAssignmentEntity, {
              where: { serverId, remoteFsMountId: mountId, desiredState: 'active' },
            }),
            manager.findOne(RemoteFsMountEntity, {
              where: { id: mountId, desiredState: 'active' },
            }),
          ]);
          // An administrator may have changed intent while the Agent observed
          // the snapshot. The newer projection wins; never revive it here.
          if (!assignment || !mount) return null;

          await this.agentTasks.supersedePendingForResourceInTransaction(manager, {
            serverId,
            resourceType: 'remote_fs_mount',
            resourceId: mountId,
            reason: 'A newer RemoteFS recovery ensure replaced this task',
          });
          assignment.desiredState = 'ensuring';
          assignment.generation = (assignment.generation ?? 0) + 1;
          await manager.save(RemoteFsServerAssignmentEntity, assignment);
          const task = await this.agentTasks.enqueueInTransaction(manager, {
            kind: AgentTaskKind.RemoteFsEnsure,
            serverId,
            resourceType: 'remote_fs_mount',
            resourceId: mountId,
            requestedBy: null,
            payload: {
              id: mount.id,
              hostMountPoint: mount.hostMountPoint,
              options: mount.options,
              params: mount.params,
            },
            request: {
              scope: 'assign',
              reason: 'state_report_recovery',
              mountId: mount.id,
              serverId,
              mount: {
                id: mount.id,
                name: mount.name,
                displayName: mount.displayName,
                description: mount.description,
                type: mount.type,
                hostMountPoint: mount.hostMountPoint,
                options: mount.options,
                params: mount.params,
                generation: mount.generation,
              },
            },
            // Consumer tasks may already hold mount_source while waiting for
            // this mount. Per-server Agent execution is serial, so recovery
            // owns only the immutable global definition lock.
            resourceKeys: [this.resourceKeys.remoteFsAssignment(serverId, mountId)],
            admissionClass: 'reconciliation',
          });
          assignment.lastTaskId = task.taskId;
          await manager.save(RemoteFsServerAssignmentEntity, assignment);
          return task.taskId;
        });
        if (taskId) created.push(taskId);
      } catch (error) {
        // A lock on one mount or a concurrent intent must not make every other
        // resource on this Agent unavailable. A later full report retries.
        this.logger.warn(
          `RemoteFS ${mountId} recovery scheduling deferred on ${serverId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return created;
  }

  private async onHeartbeat(
    server: ServerEntity,
    _payload: HeartbeatPayload,
    session: AgentSession,
  ): Promise<void> {
    if (this.sessions.get(server.id) !== session) return;
    const status = await this.transitionServerLiveness(
      server.id,
      (current) => current === ServerStatus.AgentStateUnready
        ? ServerStatus.AgentStateUnready
        : ServerStatus.Online,
    );
    if (status === ServerStatus.AgentQuarantined && this.sessions.get(server.id) === session) {
      await this.rejectSession(session, server.id, 'Agent server is quarantined');
    }
  }

  private async onInventoryFault(
    server: ServerEntity,
    fault: InventoryFaultPayload,
    session: AgentSession,
  ): Promise<void> {
    await this.persistInventoryQuarantine(server.id, fault.message);
    await this.rejectSession(session, server.id, 'Authoritative Agent inventory failed');
  }

  private async persistInventoryQuarantine(
    serverId: string,
    message: string,
    options: { preserveExisting?: boolean } = {},
  ): Promise<void> {
    this.proxySnapshots.blockServer(
      serverId,
      `authoritative Agent inventory failed on ${serverId}`,
    );
    try {
      await runSerializedTransaction(this.dataSource, async (manager) => {
        const current = await manager.findOneBy(ServerEntity, { id: serverId });
        if (!current) return;
        if (options.preserveExisting && current.status === ServerStatus.AgentQuarantined) return;
        await manager.update(ServerEntity, serverId, {
          status: ServerStatus.AgentQuarantined,
          quarantineCode: AGENT_INVENTORY_FAULT_QUARANTINE_CODE,
          quarantineMessage: message.slice(0, 2048),
          lastSeenAt: new Date(),
        });
      });
    } catch (error) {
      this.failStop.terminate(new Error(
        `Cannot persist authoritative inventory quarantine for ${serverId}`,
        { cause: error },
      ));
    }
  }

  private async onStateReport(
    server: ServerEntity,
    payload: StateReportPayload,
    reportSession?: AgentSession,
    receivedAt = Date.now(),
    receivedMonotonicAt = performance.now(),
  ): Promise<void> {
    const expectedSession = reportSession ?? this.sessions.get(server.id);
    const blockEpoch = this.proxySnapshots.currentBlockEpoch(server.id);
    const current = this.stateCache.get(server.id)
      ?? this.emptySnapshot(server.id, this.sessions.get(server.id)?.id ?? '', Date.now());

    // Build a complete replacement projection. No reader can observe a report
    // that was only half-applied because a later lookup or route update failed.
    const containers = new Map<string, ContainerSnapshot>();
    for (const c of payload.containers) {
      containers.set(c.runtime.runtimeId, c);
    }

    // Resolve numericUserId → UUID for each xfsProject entry.
    const numericIds = payload.xfsProjects.map((p) => p.numericUserId);
    const uuidMap = await this.usersService.getUserIdsByNumericIds(numericIds);
    const unknownNumericIds = new Set<number>();
    const xfsProjects = payload.xfsProjects
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

    const remoteFsMounts = [...payload.remoteFsMounts];
    const stableRemoteFs = await this.activeRemoteFsBootstrap(server.id);
    await this.scheduleRemoteFsRecoveryTasks(
      server.id,
      stableRemoteFs,
      remoteFsMounts,
      payload.containers,
    );
    const runtimeReconcile = await this.runtimeDriftReconciler.reconcile(
      server.id,
      payload.containers,
      current.dockerRoot,
    );
    if (runtimeReconcile.claimsChanged) {
      // Claim commit is the revocation linearization point. Snapshot builders
      // consult the same ledger, so even a broadcast racing route projection
      // cannot renew a physically conflicted address.
      this.proxySnapshots.invalidate('runtime address claim changed');
    }
    if (runtimeReconcile.quarantineReason) {
      this.proxySnapshots.blockServer(
        server.id,
        `runtime cleanup ledger corruption: ${runtimeReconcile.quarantineReason}`,
      );
      if (expectedSession) {
        await this.rejectSession(expectedSession, server.id, 'Runtime cleanup ledger is corrupted');
      }
      return;
    }
    if (runtimeReconcile.taskIds.length) this.taskDispatcher.wake();
    const dataDirInventory = await this.dataDirReconciler.reconcileReport(
      server.id,
      payload.dataDirs,
      payload.disks,
    );
    if (dataDirInventory.blockingReason) {
      throw new AgentInventoryFaultError(dataDirInventory.blockingReason);
    }
    if (expectedSession && !this.isCurrentOpenSession(server.id, expectedSession)) return;
    const pendingSafetyRecovery = await this.agentTasksRepo.existsBy({
      serverId: server.id,
      status: AgentTaskStatus.Pending,
      admissionClass: 'safety',
    });
    if (pendingSafetyRecovery && !this.proxySnapshots.isServerBlocked(server.id)) {
      this.proxySnapshots.blockServerRoutes(
        server.id,
        'Agent safety recovery is pending',
      );
    }
    const routableContainers = await this.routableContainers(
      server.id,
      payload.containers,
      remoteFsMounts,
    );
    await this.sshRoutes.updateFromStateReport(
      server.id,
      routableContainers,
      receivedAt,
    );
    if (expectedSession && !this.isCurrentOpenSession(server.id, expectedSession)) return;
    await this.sshConvergence.reconcileServer(server.id);
    if (expectedSession && !this.isCurrentOpenSession(server.id, expectedSession)) return;

    const next: ServerSnapshot = {
      ...current,
      containers,
      dataDirs: [...payload.dataDirs],
      dataDirIssues: dataDirInventory.issues,
      xfsProjects,
      unknownXfsNumericIds: [...unknownNumericIds].sort((a, b) => a - b),
      disks: [...payload.disks],
      localImages: [...payload.localImages],
      remoteFsMounts,
      // Freshness and route projection use the Backend receive clock. The
      // Agent timestamp remains diagnostic evidence in lastFullReportAt.
      lastUpdated: receivedAt,
    };
    next.runtimeReady = true;
    next.lastFullReportAt = payload.observedAt;
    next.lastFullReportReceivedAt = receivedAt;
    const session = this.sessions.get(server.id);
    if (expectedSession && !this.isCurrentOpenSession(server.id, expectedSession)) return;
    const promoteSession = Boolean(session?.bootstrapReady && !session.dispatchReady);
    const reportStatus = await this.transitionServerLiveness(
      server.id,
      (currentStatus) => promoteSession ? ServerStatus.Online : currentStatus,
      { clearInventoryFault: true },
    );
    if (reportStatus === ServerStatus.AgentQuarantined) {
      if (session) await this.rejectSession(session, server.id, 'Agent server is quarantined');
      return;
    }
    if (expectedSession && !this.isCurrentOpenSession(server.id, expectedSession)) {
      await this.transitionServerLiveness(
        server.id,
        (currentStatus) => this.disconnectedServerStatus(currentStatus),
      );
      return;
    }
    this.stateCache.set(server.id, next);
    this.committedStateReportSequences.set(server.id, {
      sessionId: expectedSession?.id ?? next.sessionId,
      sequence: payload.sequence,
    });
    this.commitServerDeletionInventoryProof(
      server.id,
      expectedSession,
      payload,
      receivedMonotonicAt,
      next,
    );
    expectedSession?.markFullReportReceived();
    if (expectedSession && !pendingSafetyRecovery) {
      this.proxySnapshots.unblockServerIfEpoch(
        server.id,
        blockEpoch,
        'authoritative agent state report',
      );
    }
    this.httpProxyGateway.scheduleBroadcast('container_state_report');
    if (promoteSession && session) {
      session.markDispatchReady();
      this.taskDispatcher.wake();
    }
    try {
      await this.sshProxyGateway.broadcastSnapshot();
    } catch (error) {
      // The authoritative Agent projection is already committed. Proxy
      // snapshots have independent short leases and fail closed, so a build
      // or transport failure must not misclassify a healthy Agent inventory.
      this.logger.error(
        `SSH proxy snapshot broadcast failed after state report from ${server.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private isCurrentOpenSession(serverId: string, session: AgentSession): boolean {
    return this.sessions.get(serverId) === session
      && session.ws.readyState === WebSocket.OPEN;
  }

  private async validStateReportInventory(serverId: string, payload: StateReportPayload): Promise<boolean> {
    const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
    const dockerRoot = this.stateCache.get(serverId)?.dockerRoot;
    if (!dockerRoot || !path.isAbsolute(dockerRoot) || path.resolve(dockerRoot) !== dockerRoot) return false;
    if (!unique(payload.containers.map((container) => container.runtime.runtimeId))) return false;
    const durableServer = await this.serversRepo.findOneBy({ id: serverId });
    if (!durableServer?.macvlanCidr || !durableServer.macvlanGateway) return false;
    for (const container of payload.containers) {
      const labels = container.labels ?? {};
      const productContainerId = labels[LABEL.CONTAINER_ID];
      const runtimeSpecHash = labels[LABEL.RUNTIME_SPEC_HASH];
      const specGeneration = labels[LABEL.SPEC_GENERATION];
      if (
        container.runtime.serverId !== serverId
        || !isUsableHostInCidr(durableServer.macvlanCidr, container.runtime.ip)
        || labels[LABEL.MANAGED] !== 'true'
        || labels[LABEL.SERVER_ID] !== serverId
        || typeof productContainerId !== 'string'
        || productContainerId.length === 0
        || productContainerId.length > 128
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(productContainerId)
        || typeof specGeneration !== 'string'
        || !/^[1-9]\d{0,19}$/.test(specGeneration)
        || container.runtime.specGeneration !== specGeneration
        || typeof runtimeSpecHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(runtimeSpecHash)
        || container.runtime.quotaPaths.length !== 2
        || !unique(container.runtime.quotaPaths)
        || container.runtime.quotaPaths.some((quotaPath) => !path.isAbsolute(quotaPath)
          || path.resolve(quotaPath) !== quotaPath
          || !quotaPath.startsWith(`${dockerRoot}${path.sep}`))
      ) return false;
    }
    const reportedContainerIds = [...new Set(payload.containers.map((container) =>
      container.labels?.[LABEL.CONTAINER_ID]).filter((id): id is string => Boolean(id)))];
    if (reportedContainerIds.length > 0) {
      const reportedIps = payload.containers.map((container) => container.runtime.ip);
      const [durableContainers, lifecycles, addressClaims] = await Promise.all([
        this.containersRepo.find({ where: { id: In(reportedContainerIds) } }),
        this.containerLifecyclesRepo.find({ where: { containerId: In(reportedContainerIds) } }),
        this.addressClaimsRepo.find({ where: [
          { ownerId: In(reportedContainerIds) },
          { address: In(reportedIps) },
        ] }),
      ]);
      const durableById = new Map(durableContainers.map((container) => [container.id, container]));
      const lifecycleById = new Map(lifecycles.map((lifecycle) => [lifecycle.containerId, lifecycle]));
      const reservationById = new Map(addressClaims
        .filter((claim) => claim.ownerKind === 'container')
        .map((claim) => [claim.ownerId, claim]));
      for (const snapshot of payload.containers) {
        const containerId = snapshot.labels?.[LABEL.CONTAINER_ID];
        if (!containerId) return false;
        const durable = durableById.get(containerId);
        if (!durable) continue;
        const lifecycle = lifecycleById.get(containerId);
        // Noncanonical duplicates and cross-server claimants are accepted only
        // as drift evidence so the Backend can enqueue exact cleanup. The one
        // runtime that is durably bound and eligible for routing must match the
        // authoritative reservation exactly.
        if (durable.serverId !== serverId || lifecycle?.boundRuntimeId !== snapshot.runtime.runtimeId) continue;
        const reservation = reservationById.get(containerId);
        if (
          !reservation
          || reservation.serverId !== serverId
          || reservation.networkKey !== durableServer.macvlanCidr
          || reservation.state !== 'active'
        ) return false;
      }
    }
    if (!unique(payload.disks.map((disk) => disk.diskId))) return false;
    if (!unique(payload.xfsProjects.map((project) => project.numericUserId))) return false;
    if (!unique(payload.remoteFsMounts.map((status) => status.id))) return false;

    const statusByRemoteId = new Map(payload.remoteFsMounts.map((status) => [status.id, status]));
    const remoteDataDirs = payload.dataDirs.filter((entry) => entry.sourceKind === 'remote');
    for (const entry of remoteDataDirs) {
      const status = statusByRemoteId.get(entry.sourceId);
      const canonicalRoot = `/mnt/remote-fs/${entry.sourceId}`;
      const canonicalDataPath = path.posix.join(
        canonicalRoot,
        '.nyabase',
        'dirs',
        entry.resourceId,
        'data',
      );
      if (
        !status
        || status.status !== 'mounted'
        || status.hostMountPoint !== canonicalRoot
        || entry.hostPath !== canonicalDataPath
      ) return false;
    }

    const remoteIds = [...new Set([
      ...payload.remoteFsMounts.map((status) => status.id),
      ...remoteDataDirs.map((entry) => entry.sourceId),
    ])];
    if (remoteIds.length === 0) return true;
    const [mounts, assignments] = await Promise.all([
      this.remoteFsMountsRepo.find({
        where: { id: In(remoteIds), desiredState: 'active' },
      }),
      this.remoteFsAssignmentsRepo.find({
        // A durable unassignment first changes the row to `removing`, then the
        // Agent executes remote_fs.absent. A full report collected immediately
        // before that task may still legitimately contain the exact mounted
        // filesystem. Keep validating it against the still-present immutable
        // assignment instead of treating this normal transition as an Agent
        // identity fault. The finalizer deletes the row only after absence is
        // proved, so a report with no remaining assignment still fails closed.
        where: { serverId, remoteFsMountId: In(remoteIds) },
      }),
    ]);
    const mountsById = new Map(mounts.map((mount) => [mount.id, mount]));
    const assignedIds = new Set(assignments.map((assignment) => assignment.remoteFsMountId));
    const activeAssignedIds = new Set(assignments
      .filter((assignment) => assignment.desiredState === 'active')
      .map((assignment) => assignment.remoteFsMountId));

    for (const status of payload.remoteFsMounts) {
      const canonicalPath = `/mnt/remote-fs/${status.id}`;
      const mount = mountsById.get(status.id);
      if (
        status.hostMountPoint !== canonicalPath
        || (mount && mount.hostMountPoint !== canonicalPath)
      ) return false;
      if (mount && assignedIds.has(status.id)) continue;
      // Report collection/send and task execution share the Agent execution
      // lane, but an independent HTTP unassignment transaction may commit while
      // an earlier full report is already in flight. While an Absent finalizer
      // is pending the assignment row is still present (normally `removing`).
      // Once it is deleted, any later report containing the id is real drift.
      // Cross-host wall clocks are never a causal barrier.
      return false;
    }
    for (const entry of remoteDataDirs) {
      // A transitional assignment is sufficient to identify an already
      // reported mount, but Remote DataDirs are usable only while the
      // assignment remains durably active.
      if (!mountsById.has(entry.sourceId) || !activeAssignedIds.has(entry.sourceId)) return false;
    }
    return true;
  }

  private record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private async routableContainers(
    serverId: string,
    containers: ContainerSnapshot[],
    remoteFsMounts: readonly RemoteFsMountStatus[],
  ): Promise<ContainerSnapshot[]> {
    const ids = containers
      .map((container) => container.labels?.[LABEL.CONTAINER_ID])
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) return [];
    const [lifecycles, remoteMountRefs] = await Promise.all([
      this.containerLifecyclesRepo.find({ where: { containerId: In(ids) } }),
      this.containerMountsRepo.find({
        where: { serverId, containerId: In(ids), sourceKind: 'remote' },
      }),
    ]);
    const byId = new Map(lifecycles.map((lifecycle) => [lifecycle.containerId, lifecycle]));
    const remoteIds = [...new Set(remoteMountRefs.map((ref) => ref.sourceId))];
    const activeAssignments = remoteIds.length === 0
      ? []
      : await this.remoteFsAssignmentsRepo.find({
          where: { serverId, remoteFsMountId: In(remoteIds), desiredState: 'active' },
        });
    const activeRemoteIds = new Set(activeAssignments.map((assignment) => assignment.remoteFsMountId));
    const mountedRemoteIds = new Set(remoteFsMounts
      .filter((status) =>
        status.status === 'mounted'
        && status.hostMountPoint === `/mnt/remote-fs/${status.id}`)
      .map((status) => status.id));
    const refsByContainer = new Map<string, string[]>();
    for (const ref of remoteMountRefs) {
      const refs = refsByContainer.get(ref.containerId) ?? [];
      refs.push(ref.sourceId);
      refsByContainer.set(ref.containerId, refs);
    }
    return containers.filter((container) => {
      const id = container.labels?.[LABEL.CONTAINER_ID];
      const lifecycle = id ? byId.get(id) : undefined;
      const remoteSourcesHealthy = (id ? refsByContainer.get(id) : undefined)?.every((sourceId) =>
        activeRemoteIds.has(sourceId) && mountedRemoteIds.has(sourceId)) ?? true;
      return remoteSourcesHealthy
        && lifecycle?.phase === ContainerPhase.Active
        && lifecycle.activeTaskId === null
        && lifecycle.boundRuntimeId === container.runtime.runtimeId
        && lifecycle.runtimeSpecHash === container.labels?.[LABEL.RUNTIME_SPEC_HASH];
    });
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
    for (const id of newIds.slice(0, Math.max(0, 128 - reported.size))) reported.add(id);
    this.logger.warn(
      `[StateReport] Unknown XFS numericUserIds from server ${serverId} — skipping new=${newIds.join(',')} reportUnknownCount=${unknownNumericIds.size}`,
    );
  }

  private async onMetricsBatch(payload: MetricsBatchPayload): Promise<void> {
    await this.metricsWriter.writeBatch(payload.serverId, payload.points);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getSession(serverId: string): AgentSession | undefined {
    if (this.sessionAdmissionBlocks.has(serverId)) return undefined;
    return this.sessions.get(serverId);
  }

  async fenceSession(serverId: string, reason: string): Promise<void> {
    await this.enqueueServerWork(serverId, async () => {
      await this.retireSession(serverId, reason);
    });
  }

  /**
   * Prevent both the current and an already-authenticated-but-not-yet-admitted
   * socket from becoming authoritative while durable server identity changes.
   */
  async runWithSessionFence<T>(
    serverId: string,
    reason: string,
    work: () => Promise<T>,
    options: SessionFenceOptions = {},
  ): Promise<T> {
    let ownsFence = false;
    let deletionProof: ServerDeletionInventoryProofChallenge | null = null;
    try {
      const prepared = await this.enqueueServerWork(serverId, async () => {
        const claim = () => {
          if (ownsFence) {
            throw new Error(`Server ${serverId} session admission fence was claimed twice`);
          }
          if (this.sessionAdmissionBlocks.has(serverId)) {
            throw new Error(`Server ${serverId} already has an active session admission fence`);
          }
          this.sessionAdmissionBlocks.add(serverId);
          ownsFence = true;
        };
        if (options.authorizeAndClaim) await options.authorizeAndClaim(claim);
        else claim();
        if (!ownsFence) {
          throw new Error(`Server ${serverId} session admission fence was not claimed`);
        }
        if (options.requireBoundServerEmptyInventory) {
          const proof = await this.beginBoundServerDeletionInventoryProof(serverId);
          if (proof) return proof;
        }
        await this.retireSession(serverId, reason);
        return null;
      });
      deletionProof = prepared;
      if (deletionProof) {
        const proof = await deletionProof.promise;
        await this.enqueueServerWork(serverId, async () => {
          if (!this.sessionAdmissionBlocks.has(serverId)) {
            throw new Error(`Server ${serverId} deletion inventory fence was released early`);
          }
          await this.assertBoundServerDeletionInventory(serverId, proof);
          await this.retireSession(serverId, reason);
        });
      }
      return await work();
    } finally {
      if (deletionProof) this.cancelServerDeletionInventoryProof(serverId, deletionProof);
      // Only the invocation that inserted this fence may remove it. Cover both
      // retirement and work failures so a transient revocation observer cannot
      // strand the server behind a process-local 4410 until Backend restart.
      if (ownsFence) {
        await this.enqueueServerWork(serverId, async () => {
          this.sessionAdmissionBlocks.delete(serverId);
        });
      }
    }
  }

  private async beginBoundServerDeletionInventoryProof(
    serverId: string,
  ): Promise<ServerDeletionInventoryProofChallenge | null> {
    const durable = await this.serversRepo.findOneBy({ id: serverId });
    if (!durable) return null;
    if (
      !durable.hostFingerprint
      && !durable.agentConfigFingerprint
      && !durable.macvlanCidr
      && !durable.macvlanGateway
    ) {
      return null;
    }
    if (
      !durable.hostFingerprint
      || !durable.agentConfigFingerprint
      || !durable.macvlanCidr
      || !durable.macvlanGateway
    ) {
      throw new ConflictException({
        code: 'SERVER_IDENTITY_BINDING_INCOMPLETE',
        message: 'Server identity binding is internally incomplete and cannot be safely deleted',
        serverId,
      });
    }

    const session = this.sessions.get(serverId);
    const snapshot = this.stateCache.get(serverId);
    const current = durable.status === ServerStatus.Online
      && !this.proxySnapshots.isServerBlocked(serverId)
      && session?.dispatchReady === true
      && session.ws.readyState === WebSocket.OPEN
      && snapshot?.runtimeReady === true
      && snapshot.sessionId === session.id;
    if (!current) {
      throw new ConflictException({
        code: 'SERVER_DELETE_REQUIRES_CURRENT_INVENTORY',
        message: 'A bound Server can be deleted only while its Agent is online with a current authoritative full inventory',
        serverId,
      });
    }

    const committed = this.committedStateReportSequences.get(serverId);
    const proof = this.createServerDeletionInventoryProof(
      serverId,
      session,
      committed?.sessionId === session.id ? committed.sequence : -1,
    );
    if (!session.send({
      id: undefined,
      ts: Date.now(),
      kind: 'reconcile',
      payload: { serverId, proofNonce: proof.nonce },
    })) {
      this.cancelServerDeletionInventoryProof(serverId, proof);
      throw new ConflictException({
        code: 'SERVER_DELETE_REQUIRES_CURRENT_INVENTORY',
        message: 'The Agent could not accept a fresh deletion inventory challenge',
        serverId,
      });
    }
    return proof;
  }

  private async assertBoundServerDeletionInventory(
    serverId: string,
    proof: ServerDeletionInventoryProofResult,
  ): Promise<void> {
    const durable = await this.serversRepo.findOneBy({ id: serverId });
    const session = this.sessions.get(serverId);
    const snapshot = this.stateCache.get(serverId);
    const current = durable?.status === ServerStatus.Online
      && this.sessionAdmissionBlocks.has(serverId)
      && !this.proxySnapshots.isServerBlocked(serverId)
      && session?.id === proof.sessionId
      && session.dispatchReady
      && session.ws.readyState === WebSocket.OPEN
      && snapshot === proof.snapshot
      && snapshot.runtimeReady
      && snapshot.sessionId === proof.sessionId;
    if (!current) {
      throw new ConflictException({
        code: 'SERVER_DELETE_REQUIRES_CURRENT_INVENTORY',
        message: 'The deletion inventory proof is no longer current for the fenced Agent session',
        serverId,
      });
    }

    const residuals: string[] = [];
    if (snapshot.containers.size > 0) residuals.push('containers');
    if (snapshot.dataDirs.length > 0) residuals.push('data directories');
    if (snapshot.remoteFsMounts.some((mount) => mount.status === 'mounted')) {
      residuals.push('remote FS mounts');
    }
    // Known project records may outlive their now-empty paths and are safe to
    // discard with the Server. An unknown numeric owner cannot be attributed
    // to durable state and therefore remains unexplained physical state.
    if (snapshot.unknownXfsNumericIds.length > 0) residuals.push('unknown XFS projects');
    if (snapshot.xfsProjects.some((project) => project.usedBytes > 0)) {
      residuals.push('non-empty XFS projects');
    }
    if (residuals.length > 0) {
      throw new ConflictException({
        code: 'SERVER_RUNTIME_INVENTORY_NOT_EMPTY',
        message: 'The Agent still reports physical state owned by this Server',
        serverId,
        residuals,
      });
    }
  }

  private createServerDeletionInventoryProof(
    serverId: string,
    session: AgentSession,
    minimumSequence: number,
  ): ServerDeletionInventoryProofChallenge {
    let resolve!: (proof: ServerDeletionInventoryProofResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ServerDeletionInventoryProofResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // A shutdown can reject between challenge creation and the caller's next
    // microtask attaching its await. Keep the original Promise rejectable for
    // the caller while preventing that narrow window from becoming unhandled.
    void promise.catch(() => undefined);
    if (this.serverDeletionInventoryProofs.has(serverId)) {
      throw new Error(`Server ${serverId} already has a deletion inventory proof challenge`);
    }
    const proof = {
      nonce: randomBytes(32).toString('hex'),
      sessionId: session.id,
      minimumSequence,
      startedMonotonicAt: performance.now(),
      promise,
      resolve,
      reject,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    proof.timer = setTimeout(() => {
      this.rejectServerDeletionInventoryProof(
        serverId,
        proof,
        new ConflictException({
          code: 'SERVER_DELETE_INVENTORY_PROOF_TIMEOUT',
          message: 'The Agent did not commit the challenged deletion inventory before the deadline',
          serverId,
        }),
      );
    }, SERVER_DELETE_INVENTORY_PROOF_TIMEOUT_MS);
    proof.timer.unref?.();
    this.serverDeletionInventoryProofs.set(serverId, proof);
    return proof;
  }

  private commitServerDeletionInventoryProof(
    serverId: string,
    session: AgentSession | undefined,
    payload: StateReportPayload,
    receivedMonotonicAt: number,
    snapshot: ServerSnapshot,
  ): void {
    const proof = this.serverDeletionInventoryProofs.get(serverId);
    if (
      !proof
      || !session
      || payload.reconcileProofNonce !== proof.nonce
      || session.id !== proof.sessionId
      || snapshot.sessionId !== proof.sessionId
      || payload.sequence <= proof.minimumSequence
      || receivedMonotonicAt < proof.startedMonotonicAt
    ) return;
    this.serverDeletionInventoryProofs.delete(serverId);
    clearTimeout(proof.timer);
    proof.resolve({
      nonce: proof.nonce,
      sessionId: proof.sessionId,
      sequence: payload.sequence,
      receivedMonotonicAt,
      snapshot,
    });
  }

  private cancelServerDeletionInventoryProof(
    serverId: string,
    proof: ServerDeletionInventoryProofChallenge,
  ): void {
    if (this.serverDeletionInventoryProofs.get(serverId) !== proof) return;
    this.serverDeletionInventoryProofs.delete(serverId);
    clearTimeout(proof.timer);
  }

  private rejectServerDeletionInventoryProof(
    serverId: string,
    proof: ServerDeletionInventoryProofChallenge,
    error: Error,
  ): void {
    if (this.serverDeletionInventoryProofs.get(serverId) !== proof) return;
    this.serverDeletionInventoryProofs.delete(serverId);
    clearTimeout(proof.timer);
    proof.reject(error);
  }

  private async retireSession(serverId: string, reason: string): Promise<void> {
    const session = this.sessions.get(serverId);
    if (session) {
      await this.quarantineIncompleteInitialization(session, serverId, reason);
      this.retireProcessLocalSession(session, serverId, reason);
      session.ws.terminate();
    } else {
      this.proxySnapshots.blockServer(serverId, reason);
    }
    await this.revokeRetiredSessionRoutes(serverId, 'agent_session_retired');
  }

  private async quarantineIncompleteInitialization(
    session: AgentSession,
    serverId: string,
    reason: string,
    closeCode?: number,
  ): Promise<void> {
    const explicitInventoryFault = closeCode === 4502;
    if (explicitInventoryFault) {
      await this.persistInventoryQuarantine(
        serverId,
        'Agent reported an authoritative inventory failure',
        { preserveExisting: true },
      );
      return;
    }
    if (session.dispatchReady) return;
    const preHelloInitializationFault = !session.hasReceivedHello && closeCode === 4501;
    if (!session.hasReceivedHello && !preHelloInitializationFault) return;
    if (session.hasReceivedHello) {
      // A normal socket close after hello (during bootstrap or before the first
      // full report) carries no authoritative negative evidence. Explicit
      // bootstrap rejection is persisted by onHello; inventory collectors use
      // reserved close code 4502 above. Everything else is reconnectable.
      return;
    }
    await this.persistInventoryQuarantine(
      serverId,
      preHelloInitializationFault
        ? 'Agent pre-hello initialization failed'
        : `Agent initialization interrupted: ${reason}`,
      { preserveExisting: true },
    );
  }

  private async rejectSession(
    session: AgentSession,
    serverId: string,
    reason: string,
  ): Promise<void> {
    if (this.sessions.get(serverId) === session) {
      await this.retireSession(serverId, reason);
      return;
    }
    session.rejectAll(reason);
    session.ws.terminate();
  }

  isOnline(serverId: string): boolean {
    const session = this.sessions.get(serverId);
    return !this.sessionAdmissionBlocks.has(serverId)
      && !this.proxySnapshots.isServerBlocked(serverId)
      && !!session
      && session.dispatchReady
      && session.ws.readyState === WebSocket.OPEN;
  }

  onlineServerIds(): string[] {
    return [...this.sessions.entries()]
      .filter(([serverId, session]) =>
        !this.sessionAdmissionBlocks.has(serverId)
        && !this.proxySnapshots.isServerBlocked(serverId)
        && session.ws.readyState === WebSocket.OPEN)
      .map(([serverId]) => serverId);
  }

  private dispatchReadyServerIds(): string[] {
    return [...this.sessions.entries()]
      .filter(([serverId, session]) =>
        !this.sessionAdmissionBlocks.has(serverId)
        && session.dispatchReady && session.ws.readyState === WebSocket.OPEN)
      .map(([serverId]) => serverId);
  }

  private disconnectedServerStatus(current: ServerStatus): ServerStatus {
    if (current === ServerStatus.AgentStateUnready) return ServerStatus.AgentStateUnready;
    return ServerStatus.Offline;
  }

  /** All ordinary liveness transitions serialize with fail-closed quarantine. */
  private async transitionServerLiveness(
    serverId: string,
    next: (current: ServerStatus) => ServerStatus,
    options: { clearInventoryFault?: boolean } = {},
  ): Promise<ServerStatus | null> {
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const current = await manager.findOneBy(ServerEntity, { id: serverId });
      if (!current) return null;
      if (current.status === ServerStatus.AgentQuarantined) return current.status;
      const status = next(current.status);
      await manager.update(ServerEntity, serverId, {
        status,
        lastSeenAt: new Date(),
        ...(options.clearInventoryFault
          && current.quarantineCode === AGENT_INVENTORY_FAULT_QUARANTINE_CODE
          ? { quarantineCode: null, quarantineMessage: null }
          : {}),
      });
      return status;
    });
  }

  /**
   * Revoke published routes using two independent durable facts: Server is no
   * longer Online, or its observed route rows are gone. Broadcast only after
   * at least one fact commits; otherwise renewing the previous snapshot would
   * extend unsafe access, so existing proxy leases are allowed to expire.
   */
  private async revokeRetiredSessionRoutes(serverId: string, reason: string): Promise<void> {
    const failures: unknown[] = [];
    let revoked = false;
    try {
      await this.transitionServerLiveness(
        serverId,
        (current) => this.disconnectedServerStatus(current),
      );
      revoked = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.sshRoutes.clearServer(serverId);
      revoked = true;
    } catch (error) {
      failures.push(error);
    }

    if (!revoked) {
      this.failStop.terminate(new AggregateError(
        failures,
        `Agent session route revocation failed completely for ${serverId}`,
      ));
    }
    if (revoked) {
      this.httpProxyGateway.scheduleBroadcast(reason);
      try {
        await this.sshProxyGateway.broadcastSnapshot();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Agent session route revocation was only partially applied for ${serverId}`,
      );
    }
  }

  async rpc<T = unknown>(
    serverId: string,
    kind: PublicDirectRpcKind,
    payload: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!isPublicDirectRpcKind(kind)) {
      throw new Error(`Direct command ${kind} is disabled; use an AgentTask`);
    }
    const session = this.sessions.get(serverId);
    if (
      this.sessionAdmissionBlocks.has(serverId)
      || this.proxySnapshots.isServerBlocked(serverId)
      || !session?.dispatchReady
    ) {
      throw new Error('Agent offline, initializing, or quarantined');
    }
    return session.rpc<T>(kind, payload, timeoutMs);
  }

  /** Fire-and-forget: send a message without waiting for acknowledgement. */
  notify(serverId: string, kind: AgentNotifyKind, payload: unknown): void {
    if (!isAgentNotifyKind(kind)) {
      throw new Error(`One-way Agent message ${kind} is not allowed`);
    }
    const session = this.sessions.get(serverId);
    if (
      this.sessionAdmissionBlocks.has(serverId)
      || this.proxySnapshots.isServerBlocked(serverId)
      || !session?.dispatchReady
    ) return;
    session.send(
      { id: undefined, ts: Date.now(), kind, payload } as BackendToAgentMessage,
    );
  }

  private sendTask(
    serverId: string,
    payload: Extract<BackendToAgentMessage, { kind: 'task.execute.v1' }>['payload'],
  ): void {
    const session = this.sessions.get(serverId);
    if (this.sessionAdmissionBlocks.has(serverId) || !session?.dispatchReady) return;
    session.send({
      id: undefined,
      ts: Date.now(),
      kind: 'task.execute.v1',
      payload,
    });
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

  touchLogSession(sessionId: string): void {
    this.logChunkTracker.touch(sessionId);
  }

  private expireSilentSessions(now = performance.now()): void {
    const activeInboundTimeoutMs = 20_000;
    // After durable admission acknowledgement the Agent performs one
    // fail-stop-bounded Docker daemon/network convergence before hello.
    const preHelloTimeoutMs = 150_000;
    for (const [serverId, session] of this.sessions) {
      if (!session.inboundExpired(now, activeInboundTimeoutMs, preHelloTimeoutMs)) continue;
      this.logger.warn(`Agent heartbeat deadline exceeded for server ${serverId}`);
      session.rejectAll('Agent heartbeat deadline exceeded');
      session.ws.terminate();
    }
    for (const [serverId, session] of this.sessions) {
      if (!session.initializationExpired(now, AGENT_INITIAL_STATE_REPORT_TIMEOUT_MS)) continue;
      this.logger.warn(`Agent initial state report deadline exceeded for server ${serverId}`);
      session.rejectAll('Agent initial state report deadline exceeded');
      session.ws.terminate();
    }
    for (const [serverId, session] of this.sessions) {
      if (!session.fullReportExpired(now, AGENT_STEADY_STATE_REPORT_TIMEOUT_MS)) continue;
      this.logger.warn(`Agent full state report deadline exceeded for server ${serverId}`);
      session.rejectAll('Agent full state report deadline exceeded');
      session.ws.terminate();
    }
  }

  private emptySnapshot(serverId: string, sessionId: string, now: number): ServerSnapshot {
    return {
      serverId,
      runtimeReady: false,
      sessionId,
      helloAt: null,
      lastFullReportAt: null,
      lastFullReportReceivedAt: null,
      lastUpdated: now,
      agentVersion: '',
      hostname: '',
      cpuCores: 0,
      totalMemBytes: 0,
      dockerRoot: '',
      containers: new Map(),
      disks: [],
      gpus: [],
      xfsProjects: [],
      unknownXfsNumericIds: [],
      localImages: [],
      dataDirs: [],
      dataDirIssues: { orphans: [], missing: [] },
      remoteFsMounts: [],
      dockerDaemon: null,
    };
  }

}
