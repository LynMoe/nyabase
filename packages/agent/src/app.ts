import * as os from 'os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { v4 as uuidv4 } from 'uuid';
import { AgentConfig } from './config.js';
import { AgentWsClient } from './ws/client.js';
import { DOCKER_READ_DEADLINES, DockerClient } from './docker/docker-client.js';
import { DockerPhysicalReferenceGuard } from './docker/physical-reference-guard.js';
import { DaemonManager } from './docker/daemon-manager.js';
import { DockerEventNdjsonDecoder } from './docker/docker-event-decoder.js';
import { XfsQuotaManager } from './quota/xfs-quota.js';
import { DataDirsManager, readLocalDataSourceIdentity } from './datadirs/data-dirs.js';
import { RemoteFsMounter } from './fs/remote-fs-mounter.js';
import { GpuMonitor, probeGpuAvailability, type GpuContainerIdentity } from './gpu/gpu-monitor.js';
import { HostMetricsCollector } from './metrics/host-metrics.js';
import { DropbearManager } from './dropbear/dropbear-manager.js';
import { DirectCommandDispatcher } from './rpc/direct-command-dispatcher.js';
import { AgentTaskRunner } from './tasks/task-runner.js';
import { AgentMessageRouter } from './tasks/task-router.js';
import { createAgentTaskHandlerRegistry } from './tasks/handlers/index.js';
import { withContainerMutex } from './tasks/handlers/container-mutex.js';
import { getAgentConfigFingerprint, getHostFingerprint } from './host-identity.js';
import { CoalescedJob } from './coalesced-job.js';
import { HostStorageIdentityGuard } from './host-storage.js';
import { quiesceDockerBeforeAgentStartup } from './docker/startup-mutation-barrier.js';
import {
  ContainerStatus,
  AgentTaskKind,
  ContainerSnapshot,
  AgentToBackendMessage,
  LABEL,
  type MetricPoint,
  type LocalImageInfo,
  type RemoteFsMountSpec,
  remoteFsSourceIdentity,
  RemoteFsMountStatus,
  normalizeDockerImageRef,
  MAX_MANAGED_CONTAINERS_PER_AGENT,
  MAX_MANAGED_DATA_DIRS_PER_AGENT,
  MAX_AGENT_WS_FRAME_BYTES,
  MAX_METRIC_POINTS_PER_BATCH,
} from '@nyabase/common';

const EXEC_BARRIER_TASK_KINDS = new Set<AgentTaskKind>([
  AgentTaskKind.ContainerStart,
  AgentTaskKind.ContainerStop,
  AgentTaskKind.ContainerRestart,
  AgentTaskKind.ContainerDelete,
  AgentTaskKind.ContainerRuntimeAbsent,
  AgentTaskKind.ContainerSshEnsure,
]);

export function taskExecBarrierRuntimeId(
  kind: AgentTaskKind,
  parsedPayload: unknown,
): string | null {
  if (!EXEC_BARRIER_TASK_KINDS.has(kind)) return null;
  return parsedPayload &&
    typeof parsedPayload === 'object' &&
    !Array.isArray(parsedPayload) &&
    typeof (parsedPayload as { runtimeId?: unknown }).runtimeId === 'string'
    ? (parsedPayload as { runtimeId: string }).runtimeId
    : null;
}

/**
 * Pick up to `size` items starting at `start`, wrapping around. Returns the
 * full array when `arr.length <= size` (no sharding needed).
 */
function pickShard<T>(arr: T[], start: number, size: number): T[] {
  if (arr.length === 0) return [];
  if (arr.length <= size) return arr;
  const out: T[] = [];
  for (let i = 0; i < size; i++) out.push(arr[(start + i) % arr.length]);
  return out;
}

const DOCKER_STATE_TO_STATUS: Record<string, ContainerStatus> = {
  running: ContainerStatus.Running,
  exited: ContainerStatus.Exited,
  paused: ContainerStatus.Paused,
  restarting: ContainerStatus.Restarting,
  dead: ContainerStatus.Dead,
  created: ContainerStatus.Exited,
};

/** Round-robin shard size for per-container `stats` calls (see collectAndSendMetrics). */
const CONTAINER_STATS_SHARD_SIZE = 20;
const DOCKER_EVENT_RECONNECT_MS = 1_000;
export const STATE_REPORT_CONTAINER_CONCURRENCY = 64;
/** Three exact inspect reads, three graph-path fallbacks, one absence probe, and one SSH read. */
export const STATE_REPORT_CONTAINER_WORST_CASE_MS = 7 * DOCKER_READ_DEADLINES.inspect + 10_000;
/** Fires well before the Backend's 5-minute initial report gate. */
export const AUTHORITATIVE_INVENTORY_DEADLINE_MS = 90_000;
/** A transient Docker lifecycle race gets at most two complete re-samples. */
export const AUTHORITATIVE_INVENTORY_RESAMPLE_LIMIT = 3;
/** Re-sampling never extends the outer authoritative inventory deadline. */
export const AUTHORITATIVE_INVENTORY_RESAMPLE_DEADLINE_MS = 45_000;
/** Bounded opportunity for inventoryFault / close 4502 to reach the Backend. */
export const AUTHORITATIVE_INVENTORY_FAIL_STOP_GRACE_MS = 750;
const execFileAsync = promisify(execFile);

async function inspectLocalDisk(mountPoint: string): Promise<{
  exists: boolean;
  fsType: string;
  isXfs: boolean;
}> {
  if (!fs.existsSync(mountPoint)) return { exists: false, fsType: '', isXfs: false };
  try {
    const { stdout } = await execFileAsync('stat', ['-f', '-c', '%T', mountPoint], {
      timeout: 5_000,
    });
    const fsType = stdout.trim();
    return { exists: true, fsType, isXfs: fsType.toLowerCase() === 'xfs' };
  } catch {
    return { exists: true, fsType: 'unknown', isXfs: false };
  }
}

class AuthoritativeInventoryTooLargeError extends Error {
  constructor(readonly encodedBytes: number) {
    super(
      `Authoritative inventory frame is ${encodedBytes} bytes; maximum is ${MAX_AGENT_WS_FRAME_BYTES}`,
    );
  }
}

/**
 * A managed runtime may be stopped or removed by an external actor while a
 * read-only full inventory is in flight. That observation is not a corrupt
 * inventory: the whole sample must be discarded and the coalesced Docker
 * event (or periodic report) must collect one fresh authoritative snapshot.
 */
class RetryableAuthoritativeInventoryRaceError extends Error {}

function isDockerContainerNotFound(error: unknown): boolean {
  return (
    ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

function scheduleAgentKillAfterAuthoritativeInventoryDeadline(error: Error): void {
  console.error(
    `[Agent] ${error.message}; allowing ${AUTHORITATIVE_INVENTORY_FAIL_STOP_GRACE_MS}ms for durable fault delivery before replacement`,
  );
  // Intentionally keep this timer referenced. Once the authoritative collector
  // misses its hard deadline, no late success may cancel the fail-stop. The
  // short grace only lets the already-requested inventoryFault / close 4502
  // leave the socket before systemd starts a fresh stateless observer.
  setTimeout(() => {
    process.kill(process.pid, 'SIGKILL');
  }, AUTHORITATIVE_INVENTORY_FAIL_STOP_GRACE_MS);
}

export async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error('concurrency must be a positive safe integer');
  }
  const results = new Array<U>(values.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export class AgentApplication {
  private stateReportSequence = 0;
  private reportingGeneration = 0;
  private pendingReconcileProofNonce: string | null = null;
  private helloGeneration = 0;
  private readonly docker: DockerClient;
  private readonly quota: XfsQuotaManager;
  private readonly dataDirs: DataDirsManager;
  private readonly gpuMonitor: GpuMonitor;
  private readonly hostMetrics: HostMetricsCollector;
  private readonly remoteFsMounter: RemoteFsMounter;
  private readonly dropbearManager: DropbearManager;
  private readonly wsClient: AgentWsClient;
  private readonly direct: DirectCommandDispatcher;
  private readonly taskRunner: AgentTaskRunner;
  private readonly router: AgentMessageRouter;
  private readonly metricsJob = new CoalescedJob();
  private readonly dockerStatusJob = new CoalescedJob();
  private dockerEventListenerGeneration = 0;
  private periodicTimers: NodeJS.Timeout[] = [];
  private dockerEventReconnectTimer: NodeJS.Timeout | null = null;
  private dockerEventStream: (NodeJS.ReadableStream & { destroy?: () => void }) | null = null;
  private stopped = false;
  private runtimeBootstrap: Promise<void> | null = null;

  /** Set to false once the one-time nvidia-smi probe fails (or if config disables it). */
  private gpuActive: boolean;
  /** Round-robin cursor for container stats sharding. */
  private statsShardCursor = 0;

  constructor(
    private readonly config: AgentConfig,
    private readonly daemonManager: DaemonManager,
    private readonly storageIdentity: HostStorageIdentityGuard,
  ) {
    this.docker = new DockerClient(config);
    const physicalReferenceGuard = new DockerPhysicalReferenceGuard(this.docker);
    this.quota = new XfsQuotaManager(
      config.dockerRoot,
      config.localDataSources.map((source) => source.mountPoint),
    );
    this.dataDirs = new DataDirsManager(this.quota, config.dockerRoot);
    for (const source of config.localDataSources) {
      this.dataDirs.addSource({
        kind: 'local',
        id: source.id,
        root: source.mountPoint,
        identity: readLocalDataSourceIdentity(source.mountPoint),
        label: source.label,
        quotaEnabled: true,
      });
    }
    this.gpuMonitor = new GpuMonitor(config.isGpuServer);
    this.gpuActive = config.isGpuServer;
    this.hostMetrics = new HostMetricsCollector();
    this.dropbearManager = new DropbearManager(this.docker, withContainerMutex);

    this.remoteFsMounter = new RemoteFsMounter(
      (_status: RemoteFsMountStatus) => {
        // Runtime projections have one ordered path: a coalesced full report.
        // If a mount changes during collection, AgentTaskRunner retains one
        // fresh ordered follow-up rather than racing an incremental message.
        void this.sendStateReport();
      },
      {
        physicalReferenceGuard,
        forbiddenHostPaths: [
          config.dockerRoot,
          ...config.localDataSources.map((source) => source.mountPoint),
        ],
      },
    );
    this.dataDirs.setRemoteSourceVerifier(async (source) => {
      const spec = this.remoteFsMounter.getSpec(source.id);
      if (
        !spec
        || spec.hostMountPoint !== source.root
        || remoteFsSourceIdentity(spec.params) !== source.identity
      ) return null;
      return this.remoteFsMounter.observeMountedIdentity(spec);
    });

    this.wsClient = new AgentWsClient({
      url: config.backendUrl,
      token: config.agentToken,
      serverId: config.serverId,
      onConnect: (generation) => this.onConnect(generation),
      onDisconnect: () => {
        this.reportingGeneration = 0;
        this.pendingReconcileProofNonce = null;
        this.helloGeneration = 0;
        this.taskRunner.resetConnection();
        this.direct.resetConnection();
        const previousRemoteFsIds = this.remoteFsMounter.getAllSpecs().map((spec) => spec.id);
        this.remoteFsMounter.resetConnection();
        this.syncRemoteFsSources([], previousRemoteFsIds);
        console.log('[Agent] Disconnected from backend');
      },
    });

    this.direct = new DirectCommandDispatcher(
      config,
      this.docker,
      this.remoteFsMounter,
      this.wsClient,
      this.dropbearManager,
      this.quota,
      (specs, previousIds) => this.syncRemoteFsSources(specs, previousIds),
      () => this.ensurePhysicalBootstrap(),
      () => this.assertRuntimePhysicalEnvironment(),
    );
    const handlers = createAgentTaskHandlerRegistry({
      config,
      docker: this.docker,
      physicalReferenceGuard,
      quota: this.quota,
      dataDirs: this.dataDirs,
      remoteFsMounter: this.remoteFsMounter,
      dropbear: this.dropbearManager,
      ws: this.wsClient,
    });
    this.taskRunner = new AgentTaskRunner(
      handlers,
      (result) =>
        this.sendIfConnected({
          id: uuidv4(),
          ts: Date.now(),
          kind: 'task.result.v1',
          payload: result,
        }),
      () => this.assertRuntimePhysicalEnvironment(),
      async (task, parsedPayload) => {
        const runtimeId = taskExecBarrierRuntimeId(task.kind, parsedPayload);
        const release = runtimeId
          ? await this.direct.acquireRuntimeTaskFence(runtimeId)
          : undefined;
        await this.direct.waitForIdle();
        return release;
      },
    );
    this.router = new AgentMessageRouter(this.taskRunner, this.direct, () =>
      this.storageIdentity.assertCurrent(),
    );

    this.wsClient.setMessageHandler((msg) => this.router.handle(msg));
  }

  async start(): Promise<void> {
    if (this.periodicTimers?.length) {
      throw new Error('AgentApplication is already started');
    }
    this.stopped = false;
    // Stateless recovery is local and unconditional. It must finish before a
    // WebSocket exists so a replacement Agent also rolls back orphaned execs
    // while Backend is offline. Only static, already-proved host identity is
    // used; durable desired state remains exclusively in Backend.
    // Focused prototype harnesses may intentionally omit constructor-owned
    // dependencies; a real AgentApplication always owns the quota manager.
    this.quota?.recoverProjectsFileState?.();
    await this.ensureRuntimeBootstrap();
    await this.validateLocalDataSources();
    this.wsClient.on('diskChanged', () => {
      void this.sendStateReport();
    });
    this.wsClient.on('dataDirChanged', () => void this.sendStateReport());
    this.wsClient.on('reconcile', (payload: { proofNonce?: string }) => {
      this.reportingGeneration = this.wsClient.connectionGeneration;
      void this.sendStateReport(payload.proofNonce);
      void this.sendDockerDaemonStatus();
    });

    this.schedulePeriodic(() => {
      if (this.wsClient.connected && this.helloGeneration === this.wsClient.connectionGeneration) {
        this.wsClient.send({
          id: uuidv4(),
          ts: Date.now(),
          kind: 'heartbeat',
          payload: { serverId: this.config.serverId, uptime: process.uptime() },
        } as AgentToBackendMessage);
      }
    }, 5_000);

    this.schedulePeriodic(() => void this.sendStateReport(), 15_000);
    this.schedulePeriodic(() => void this.collectAndSendMetrics(), this.config.metricsIntervalMs);
    this.schedulePeriodic(() => void this.sendDockerDaemonStatus(), 30_000);

    void this.startDockerEventListener();
    // One-time host probe; permanently disables GPU collection if nvidia-smi
    // is missing or the host has no GPUs, even when isGpuServer=true.
    if (this.gpuActive) {
      void probeGpuAvailability().then((has) => {
        if (!has) {
          console.log(
            '[Agent] nvidia-smi probe failed or no GPUs detected — disabling GPU metrics.',
          );
          this.gpuActive = false;
        }
      });
    }
    this.wsClient.start();
  }

  stop(): void {
    this.stopped = true;
    this.reportingGeneration = 0;
    this.pendingReconcileProofNonce = null;
    this.helloGeneration = 0;
    for (const timer of this.periodicTimers ?? []) clearInterval(timer);
    this.periodicTimers = [];
    if (this.dockerEventReconnectTimer) clearTimeout(this.dockerEventReconnectTimer);
    this.dockerEventReconnectTimer = null;
    this.dockerEventListenerGeneration += 1;
    try {
      this.dockerEventStream?.destroy?.();
    } catch {
      /* stream already closed */
    }
    this.dockerEventStream = null;
    this.wsClient.stop();
  }

  private schedulePeriodic(work: () => void, intervalMs: number): void {
    const timer = setInterval(work, intervalMs);
    // Periodic observation alone must not keep an otherwise stopped Agent alive.
    timer.unref?.();
    (this.periodicTimers ??= []).push(timer);
  }

  private async assertRuntimePhysicalEnvironment(): Promise<void> {
    this.storageIdentity.assertCurrent();
    // Some focused prototype harnesses intentionally omit constructor-owned
    // dependencies. A real AgentApplication always has DaemonManager here.
    await this.daemonManager?.assertRuntimeIdentity?.();
    this.storageIdentity.assertCurrent();
  }

  private async validateLocalDataSources(): Promise<void> {
    for (const source of this.config.localDataSources) {
      const check = await inspectLocalDisk(source.mountPoint);
      if (!check.exists)
        throw new Error(`Local data source path does not exist: ${source.mountPoint}`);
      if (!check.isXfs) {
        throw new Error(
          `Local data source ${source.mountPoint} uses filesystem ${check.fsType}, must be XFS`,
        );
      }
      const observed = this.dataDirs.inspectSource(source.id);
      if (!observed.ready) {
        throw new Error(
          `Local data source ${source.mountPoint} must be an exact mounted XFS filesystem`,
        );
      }
      const capability = await this.quota.checkProjectQuotaEnforcement(source.mountPoint);
      if (!capability.accounting || !capability.enforcement) {
        const status = `accounting=${capability.accounting ? 'on' : 'off'}, enforcement=${capability.enforcement ? 'on' : 'off'}`;
        throw new Error(
          `Local data source ${source.mountPoint} has no XFS project quota enforcement (${status})${capability.output ? `: ${capability.output}` : ''}`,
        );
      }
    }
  }

  private sendIfConnected(msg: AgentToBackendMessage): void {
    if (this.wsClient.connected) {
      this.wsClient.send(msg);
    }
  }

  private async onConnect(generation: number): Promise<void> {
    // Do not start Backend's hello/bootstrap deadlines while work accepted on
    // an older connection still owns the single physical lane. Stateless
    // reconnect attempts may retire pre-hello, but none can falsely turn a
    // legitimate long task into an inventory quarantine.
    await this.router?.waitForBootstrapIdle();
    await this.direct.waitForIdle();
    await this.taskRunner.waitForIdle();
    if (generation !== this.wsClient.connectionGeneration) return;
    // Hello is a read-only static identity preflight. Backend binds the exact
    // host/config/network identity durably before it sends bootstrap authority.
    this.storageIdentity.assertCurrent();
    await this.sendHello(generation);
    if (generation === this.wsClient.connectionGeneration) this.helloGeneration = generation;
  }

  private async ensurePhysicalBootstrap(): Promise<void> {
    // A previous connection may still own a mutation after transport loss.
    // Join the same lane before using the Backend-granted bootstrap authority.
    await this.taskRunner.waitForIdle();
    this.storageIdentity.assertCurrent();
    await this.ensureRuntimeBootstrap();
    await this.assertRuntimePhysicalEnvironment();
    await this.docker.ensureMacvlanNetwork();
    await this.assertRuntimePhysicalEnvironment();
  }

  private ensureRuntimeBootstrap(): Promise<void> {
    if (!this.runtimeBootstrap) {
      const attempt = (async () => {
        this.storageIdentity.assertCurrent();
        console.log(
          '[Agent] Quiescing previous Docker mutation domain before network admission...',
        );
        await quiesceDockerBeforeAgentStartup();
        this.storageIdentity.assertCurrent();
        console.log('[Agent] Reconciling nyabase-docker daemon for stateless recovery...');
        await this.daemonManager.reconcile(this.config.serverId);
        await this.assertRuntimePhysicalEnvironment();
        console.log('[Agent] Quiescing managed containers for stateless process recovery...');
        await this.docker.quiesceManagedContainersForStatelessRecovery();
        await this.assertRuntimePhysicalEnvironment();
      })();
      this.runtimeBootstrap = attempt;
      void attempt.catch(() => {
        // Ambiguous mutation deadlines kill the process. A returned rejection
        // is therefore a completed, retryable startup attempt; do not poison
        // every later admitted connection with the same rejected Promise.
        if (this.runtimeBootstrap === attempt) this.runtimeBootstrap = null;
      });
    }
    return this.runtimeBootstrap;
  }

  private async sendHello(generation: number): Promise<void> {
    const [gpus, diskInfos] = [
      await this.gpuMonitor.getGpuInfo(),
      this.dataDirs.getLocalDiskInfos(),
    ];
    this.storageIdentity.assertCurrent();
    const configFingerprint = getAgentConfigFingerprint(
      this.config,
      diskInfos,
      this.storageIdentity.dockerRootIdentity,
    );

    const sent = this.wsClient.send(
      {
        id: uuidv4(),
        ts: Date.now(),
        kind: 'hello',
        payload: {
          serverId: this.config.serverId,
          hostFingerprint: getHostFingerprint(),
          configFingerprint,
          hostname: os.hostname(),
          kernelVersion: os.release(),
          cpuCores: os.cpus().length,
          totalMemBytes: os.totalmem(),
          disks: diskInfos,
          gpus,
          macvlanCidr: this.config.macvlanCidr,
          macvlanGateway: this.config.macvlanGateway,
          macvlanReservedIps: [...this.config.reservedIps],
          macvlanIface: this.config.parentIface,
          dockerRoot: this.config.dockerRoot,
          agentVersion: this.config.agentVersion,
          // Docker is deliberately untouched until Backend accepts this static
          // identity and grants bootstrap. The first full report carries the
          // authoritative image inventory.
          localImages: [],
        },
      } as AgentToBackendMessage,
      generation,
    );
    if (!sent) throw new Error('Agent connection changed before hello could be sent');
  }

  private syncRemoteFsSources(
    specs: readonly RemoteFsMountSpec[],
    previousIds: readonly string[],
  ): void {
    const localIds = new Set(this.config.localDataSources.map((source) => source.id));
    const activeIds = new Set(specs.map((spec) => spec.id));
    for (const id of activeIds) {
      if (localIds.has(id)) {
        throw new Error(`RemoteFS source id ${id} conflicts with a static local data source`);
      }
    }
    for (const id of previousIds) {
      if (!activeIds.has(id)) this.dataDirs.removeSource(id);
    }
    for (const spec of specs) {
      this.dataDirs.addSource({
        kind: 'remote',
        id: spec.id,
        root: spec.hostMountPoint,
        identity: remoteFsSourceIdentity(spec.params),
        quotaEnabled: false,
      });
    }
  }

  private async listLocalImages(): Promise<LocalImageInfo[]> {
    const imgs = await this.docker.listImages();
    return imgs.map((img) => ({
      id: img.Id,
      repoTags: (img.RepoTags ?? []).flatMap((tag) => {
        try {
          return [normalizeDockerImageRef(tag)];
        } catch {
          return [];
        }
      }),
      size: img.Size,
      createdAt: img.Created,
    }));
  }

  async sendDockerDaemonStatus(): Promise<void> {
    const generation = this.wsClient.connectionGeneration;
    return this.dockerStatusJob.run(() => this.captureAndSendDockerDaemonStatus(generation));
  }

  private async captureAndSendDockerDaemonStatus(generation: number): Promise<void> {
    if (
      !this.wsClient.connected ||
      generation !== this.wsClient.connectionGeneration ||
      generation !== this.reportingGeneration
    )
      return;
    try {
      await this.assertRuntimePhysicalEnvironment();
      const status = await this.daemonManager.getStatus(this.config.serverId);
      await this.assertRuntimePhysicalEnvironment();
      this.wsClient.send(
        {
          id: uuidv4(),
          ts: Date.now(),
          kind: 'dockerDaemonStatus',
          payload: status,
        } as AgentToBackendMessage,
        generation,
      );
    } catch (e) {
      console.warn('[Agent] Failed to send dockerDaemonStatus:', e);
    }
  }

  private async sendStateReport(proofNonce?: string): Promise<void> {
    if (proofNonce) this.pendingReconcileProofNonce = proofNonce;
    // Capture eligibility when this closure is scheduled, but claim the
    // challenge only when the closure actually starts. This prevents a
    // pre-challenge collector from reading a later nonce, lets a later
    // coalesced trigger retain a still-pending challenge, and ensures an
    // ordinary follow-up queued after proof collection starts cannot replay it.
    const eligibleProofNonce = proofNonce ?? this.pendingReconcileProofNonce ?? undefined;
    const generation = this.wsClient.connectionGeneration;
    return this.taskRunner.enqueueObservation('stateReport', () => {
      const requestedProofNonce = eligibleProofNonce
        && this.pendingReconcileProofNonce === eligibleProofNonce
        ? eligibleProofNonce
        : undefined;
      if (requestedProofNonce) this.pendingReconcileProofNonce = null;
      return this.captureAndSendStateReportWithDeadline(generation, requestedProofNonce);
    });
  }

  private async captureAndSendStateReportWithDeadline(
    generation: number,
    proofNonce?: string,
  ): Promise<void> {
    const timer = setTimeout(() => {
      const error = new Error(
        `Authoritative inventory capture exceeded ${AUTHORITATIVE_INVENTORY_DEADLINE_MS}ms`,
      );
      try {
        this.reportInventoryFault(generation, error);
      } finally {
        // A collector that ignored/could not observe its own read deadline
        // must not occupy the single physical lane forever. The Agent has no
        // durable task state, so process replacement is the smallest safe
        // recovery boundary.
        scheduleAgentKillAfterAuthoritativeInventoryDeadline(error);
      }
    }, AUTHORITATIVE_INVENTORY_DEADLINE_MS);
    timer.unref?.();
    try {
      // Keep awaiting the read-only collector after the deadline. This keeps
      // the physical task lane serialized while the retired connection is
      // replaced; reportInventoryFault prevents any late old-generation send.
      await this.captureAndSendStateReport(generation, proofNonce);
    } finally {
      clearTimeout(timer);
    }
  }

  private async captureAndSendStateReport(generation: number, proofNonce?: string): Promise<void> {
    if (
      !this.wsClient.connected ||
      generation !== this.wsClient.connectionGeneration ||
      generation !== this.reportingGeneration
    )
      return;
    const resampleDeadlineAt = Date.now() + AUTHORITATIVE_INVENTORY_RESAMPLE_DEADLINE_MS;
    try {
      for (let attempt = 1; attempt <= AUTHORITATIVE_INVENTORY_RESAMPLE_LIMIT; attempt += 1) {
        try {
          await this.assertRuntimePhysicalEnvironment();
          const sequence = ++this.stateReportSequence;
          const observedAt = Date.now();
          const containers = await this.docker.listNyabaseContainers();
          if (containers.length > MAX_MANAGED_CONTAINERS_PER_AGENT) {
            throw new Error(
              `Managed container inventory exceeds ${MAX_MANAGED_CONTAINERS_PER_AGENT}; refusing an unbounded state report`,
            );
          }

          const observations = await mapWithConcurrency(
            containers,
            STATE_REPORT_CONTAINER_CONCURRENCY,
            async (container): Promise<ContainerSnapshot> => {
              if (!container.Id)
                throw new Error('Managed runtime inventory contains an empty runtime id');
              const first = await this.inspectRuntimeForAuthoritativeInventory(container.Id);
              const firstLabels = first.Config?.Labels ?? {};
              const runtime = this.docker.parseContainerRuntimeObservation(firstLabels, first);
              if (
                !runtime ||
                first.Id !== container.Id ||
                runtime.serverId !== this.config.serverId
              ) {
                throw new Error(
                  `Managed runtime ${container.Id} has incomplete or foreign immutable identity/network evidence`,
                );
              }
              this.authoritativeContainerStatus(container.Id, first.State.Status);
              const firstPaths = await this.authoritativeRuntimeQuotaPaths(container.Id, first);

              // Graph path discovery may cross Docker/containerd boundaries. A
              // second inspect proves that the exact immutable runtime identity did
              // not change while those recovery paths were captured.
              const confirmed = await this.inspectRuntimeForAuthoritativeInventory(container.Id);
              const confirmedLabels = confirmed.Config?.Labels ?? {};
              const confirmedRuntime = this.docker.parseContainerRuntimeObservation(
                confirmedLabels,
                confirmed,
              );
              const identityKeys = [
                LABEL.MANAGED,
                LABEL.CONTAINER_ID,
                LABEL.SERVER_ID,
                LABEL.SPEC_GENERATION,
                LABEL.RUNTIME_SPEC_HASH,
              ] as const;
              if (
                !confirmedRuntime ||
                confirmed.Id !== first.Id ||
                confirmedRuntime.serverId !== this.config.serverId ||
                confirmedRuntime.ip !== runtime.ip ||
                identityKeys.some((key) => confirmedLabels[key] !== firstLabels[key])
              ) {
                throw new Error(
                  `Managed runtime ${container.Id} changed identity during full inventory capture`,
                );
              }
              const confirmedPaths = await this.authoritativeRuntimeQuotaPaths(
                container.Id,
                confirmed,
              );
              if (confirmedPaths[0] !== firstPaths[0] || confirmedPaths[1] !== firstPaths[1]) {
                throw new Error(
                  `Managed runtime ${container.Id} changed writable-layer paths during full inventory capture`,
                );
              }

              const status = this.authoritativeContainerStatus(
                container.Id,
                confirmed.State.Status,
              );
              const sshServer = await this.dropbearManager.inspectContainerSshState(
                container.Id,
                status,
              );

              // SSH observation uses the fail-stop read-only exec lane: it can
              // never change container power. A final exact inspect still proves
              // that the runtime identity and status did not change concurrently.
              const final = await this.inspectRuntimeForAuthoritativeInventory(container.Id);
              const finalLabels = final.Config?.Labels ?? {};
              const finalRuntime = this.docker.parseContainerRuntimeObservation(finalLabels, final);
              if (
                !finalRuntime ||
                final.Id !== confirmed.Id ||
                finalRuntime.serverId !== this.config.serverId ||
                finalRuntime.ip !== confirmedRuntime.ip ||
                identityKeys.some((key) => finalLabels[key] !== confirmedLabels[key])
              ) {
                throw new Error(
                  `Managed runtime ${container.Id} changed identity during SSH inventory capture`,
                );
              }
              const finalPaths = await this.authoritativeRuntimeQuotaPaths(container.Id, final);
              if (finalPaths[0] !== confirmedPaths[0] || finalPaths[1] !== confirmedPaths[1]) {
                throw new Error(
                  `Managed runtime ${container.Id} changed writable-layer paths during SSH inventory capture`,
                );
              }
              const finalStatus = this.authoritativeContainerStatus(
                container.Id,
                final.State.Status,
              );
              if (
                final.State.Status !== confirmed.State.Status ||
                final.State.Running !== confirmed.State.Running ||
                finalStatus !== status
              ) {
                throw new RetryableAuthoritativeInventoryRaceError(
                  `Managed runtime ${container.Id} changed power state during SSH inventory capture`,
                );
              }
              return {
                runtime: { ...finalRuntime, runtimeId: final.Id, quotaPaths: finalPaths },
                status: finalStatus,
                sshServer:
                  finalStatus === ContainerStatus.Running
                    ? sshServer
                    : { enabled: false, status: 'container_stopped', user: 'root', port: 22 },
                labels: {
                  [LABEL.MANAGED]: 'true',
                  [LABEL.CONTAINER_ID]: finalLabels[LABEL.CONTAINER_ID]!,
                  [LABEL.SERVER_ID]: finalLabels[LABEL.SERVER_ID]!,
                  [LABEL.SPEC_GENERATION]: finalLabels[LABEL.SPEC_GENERATION]!,
                  [LABEL.RUNTIME_SPEC_HASH]: finalLabels[LABEL.RUNTIME_SPEC_HASH]!,
                },
              };
            },
          );

          const [dataDirs, xfsProjects, diskInfos, remoteFsMountStatuses, localImages] =
            await Promise.all([
              this.dataDirs.listAllDirs(),
              this.quota.getAllUsages(),
              Promise.resolve(this.dataDirs.getLocalDiskInfos()),
              Promise.resolve(this.remoteFsMounter.getAllStatuses()),
              this.listLocalImages(),
            ]);
          await this.assertRuntimePhysicalEnvironment();
          if (dataDirs.length > MAX_MANAGED_DATA_DIRS_PER_AGENT) {
            throw new Error(
              `Managed data directory inventory exceeds ${MAX_MANAGED_DATA_DIRS_PER_AGENT}`,
            );
          }

          const reportMessage = {
            id: uuidv4(),
            ts: Date.now(),
            kind: 'stateReport',
            payload: {
              serverId: this.config.serverId,
              sequence,
              observedAt,
              ...(proofNonce ? { reconcileProofNonce: proofNonce } : {}),
              containers: observations,
              dataDirs,
              xfsProjects: xfsProjects.map(
                ({ numericUserId, projectId, usedBytes, hardLimitBytes }) => ({
                  numericUserId,
                  projectId,
                  usedBytes,
                  hardLimitBytes,
                }),
              ),
              disks: diskInfos,
              localImages,
              remoteFsMounts: remoteFsMountStatuses,
            },
          } as AgentToBackendMessage;
          const encodedBytes = Buffer.byteLength(JSON.stringify(reportMessage));
          if (encodedBytes > MAX_AGENT_WS_FRAME_BYTES) {
            throw new AuthoritativeInventoryTooLargeError(encodedBytes);
          }
          if (
            generation !== this.wsClient.connectionGeneration ||
            generation !== this.reportingGeneration
          )
            return;
          const sent = this.wsClient.send(reportMessage, generation);
          if (!sent) {
            // The complete inventory above is valid; failure to queue its frame
            // proves only transport loss/backpressure. Do not turn an ordinary
            // reconnect into a durable inventory quarantine. A stale collector
            // must also never clear or retire a newer reporting generation.
            if (
              generation === this.wsClient.connectionGeneration &&
              generation === this.reportingGeneration
            ) {
              this.reportingGeneration = 0;
              this.wsClient.retireGeneration(
                generation,
                1011,
                'Authoritative inventory transport unavailable',
              );
            }
            return;
          }
          return;
        } catch (sampleError) {
          const canResample =
            sampleError instanceof RetryableAuthoritativeInventoryRaceError &&
            attempt < AUTHORITATIVE_INVENTORY_RESAMPLE_LIMIT &&
            Date.now() < resampleDeadlineAt &&
            generation === this.wsClient.connectionGeneration &&
            generation === this.reportingGeneration;
          if (!canResample) throw sampleError;
          console.warn(
            `[Agent] Authoritative inventory sample raced a Docker lifecycle transition; ` +
              `re-sampling ${attempt + 1}/${AUTHORITATIVE_INVENTORY_RESAMPLE_LIMIT}:`,
            sampleError,
          );
        }
      }
    } catch (e) {
      console.warn('[Agent] Failed to send stateReport:', e);
      this.reportInventoryFault(generation, e);
    }
  }

  private reportInventoryFault(generation: number, error: unknown): void {
    if (
      generation !== this.wsClient.connectionGeneration ||
      generation !== this.reportingGeneration
    )
      return;
    const tooLarge = error instanceof AuthoritativeInventoryTooLargeError;
    const message =
      (error instanceof Error ? error.message : String(error)).slice(0, 2048) ||
      'Authoritative inventory capture failed';
    const faultSent = this.wsClient.send(
      {
        id: uuidv4(),
        ts: Date.now(),
        kind: 'inventoryFault',
        payload: {
          serverId: this.config.serverId,
          code: tooLarge ? 'AUTHORITATIVE_INVENTORY_TOO_LARGE' : 'AUTHORITATIVE_INVENTORY_FAILED',
          message,
          observedAt: Date.now(),
        },
      } as AgentToBackendMessage,
      generation,
    );
    if (!faultSent) {
      console.error(
        '[Agent] Inventory fault payload could not be queued; relying on close code 4502',
      );
    }
    this.reportingGeneration = 0;
    this.wsClient.retireGeneration(
      generation,
      4502,
      tooLarge ? 'Authoritative inventory too large' : 'Authoritative inventory failed',
    );
  }

  private canonicalRuntimeQuotaPaths(
    runtimeId: string,
    graph: { upperDir: string; workDir: string },
  ): [string, string] {
    const dockerRoot = path.resolve(this.config.dockerRoot);
    const quotaPaths = [graph.upperDir, graph.workDir] as const;
    if (
      new Set(quotaPaths).size !== 2 ||
      quotaPaths.some(
        (quotaPath) =>
          !path.isAbsolute(quotaPath) ||
          path.resolve(quotaPath) !== quotaPath ||
          !quotaPath.startsWith(`${dockerRoot}${path.sep}`),
      )
    ) {
      throw new Error(
        `Managed runtime ${runtimeId} has unavailable or non-canonical writable-layer paths`,
      );
    }
    return [quotaPaths[0], quotaPaths[1]];
  }

  private async inspectRuntimeForAuthoritativeInventory(
    runtimeId: string,
  ): Promise<Awaited<ReturnType<DockerClient['inspectContainer']>>> {
    try {
      return await this.docker.inspectContainer(runtimeId);
    } catch (error) {
      if (isDockerContainerNotFound(error)) {
        throw new RetryableAuthoritativeInventoryRaceError(
          `Managed runtime ${runtimeId} disappeared during authoritative inventory capture`,
        );
      }
      throw error;
    }
  }

  private authoritativeContainerStatus(runtimeId: string, dockerStatus: string): ContainerStatus {
    // Docker exposes `removing` while an exact rm is in progress. Treating
    // that transient as a durable Unknown snapshot can permanently classify
    // the control-plane resource as runtime_power_state_unsupported before
    // the next empty full inventory proves runtime_missing. Re-sample the
    // complete inventory instead, just like an inspect 404 or a power change.
    if (dockerStatus === 'removing') {
      throw new RetryableAuthoritativeInventoryRaceError(
        `Managed runtime ${runtimeId} is being removed during authoritative inventory capture`,
      );
    }
    return DOCKER_STATE_TO_STATUS[dockerStatus] ?? ContainerStatus.Unknown;
  }

  private async authoritativeRuntimeQuotaPaths(
    runtimeId: string,
    inspected: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  ): Promise<[string, string]> {
    const graph = await this.docker.getGraphDriverDirs(runtimeId, inspected);
    if (!graph.upperDir || !graph.workDir) {
      try {
        await this.docker.inspectContainer(runtimeId);
      } catch (error) {
        if (isDockerContainerNotFound(error)) {
          throw new RetryableAuthoritativeInventoryRaceError(
            `Managed runtime ${runtimeId} disappeared while writable-layer paths were captured`,
          );
        }
        // Preserve the missing-path integrity fault below. A timeout, transport
        // error, or any non-404 response cannot prove a lifecycle race.
      }
    }
    return this.canonicalRuntimeQuotaPaths(runtimeId, graph);
  }

  private async collectAndSendMetrics(): Promise<void> {
    const generation = this.wsClient.connectionGeneration;
    return this.metricsJob.run(async () => {
      try {
        await this.captureAndSendMetrics(generation);
      } catch (error) {
        console.warn('[Agent] Failed to collect metrics:', error);
      }
    });
  }

  private async captureAndSendMetrics(generation: number): Promise<void> {
    if (
      !this.wsClient.connected ||
      generation !== this.wsClient.connectionGeneration ||
      generation !== this.reportingGeneration
    )
      return;

    const disks = this.dataDirs.getLocalDiskInfos();
    const hostPoints = this.hostMetrics.collectHostMetrics(this.config.serverId, disks);

    const [gpuStats, gpuProcesses, containers] = await Promise.all([
      this.gpuActive ? this.gpuMonitor.getGpuStats() : Promise.resolve([]),
      this.gpuActive ? this.gpuMonitor.getGpuProcesses() : Promise.resolve([]),
      this.docker.listNyabaseContainers().catch(() => []),
    ]);

    const containerOwnerMap = this.gpuContainerIdentityMap(containers);
    const gpuPoints = this.gpuActive
      ? this.gpuMonitor.buildMetrics(
          gpuStats,
          gpuProcesses,
          containerOwnerMap,
          this.config.serverId,
        )
      : [];

    // Round-robin shard the per-container `stats` work to avoid hammering the
    // daemon when a host runs many containers. Each cycle covers up to
    // CONTAINER_STATS_SHARD_SIZE running containers; subsequent cycles rotate.
    const running = containers.filter((c) => c.State === 'running');
    const shard = pickShard(running, this.statsShardCursor, CONTAINER_STATS_SHARD_SIZE);
    this.statsShardCursor =
      running.length === 0 ? 0 : (this.statsShardCursor + shard.length) % running.length;

    const containerResults = await Promise.allSettled(
      shard.map((c) => this.collectContainerMetrics(c)),
    );
    const containerPoints: MetricPoint[] = containerResults.flatMap((r) =>
      r.status === 'fulfilled' ? r.value : [],
    );

    const userDiskPoints: MetricPoint[] = [];
    try {
      const usages = await this.quota.getAllUsages();
      const ts = Date.now();
      for (const { numericUserId, usedBytes } of usages) {
        userDiskPoints.push({
          name: 'nyabase_user_disk_used_bytes',
          labels: { server: this.config.serverId, user_id: String(numericUserId) },
          value: usedBytes,
          ts,
        });
      }
    } catch {
      /* quota unavailable */
    }

    const collectedPoints = [...hostPoints, ...gpuPoints, ...containerPoints, ...userDiskPoints];
    const allPoints = collectedPoints.slice(0, MAX_METRIC_POINTS_PER_BATCH);
    if (collectedPoints.length > allPoints.length) {
      console.warn(
        `[Agent] Metrics batch truncated from ${collectedPoints.length} to ` +
          `${MAX_METRIC_POINTS_PER_BATCH} points`,
      );
    }
    if (allPoints.length > 0) {
      this.wsClient.send(
        {
          id: uuidv4(),
          ts: Date.now(),
          kind: 'metricsBatch',
          payload: { serverId: this.config.serverId, points: allPoints },
        } as AgentToBackendMessage,
        generation,
      );
    }
  }

  private async collectContainerMetrics(
    c: Awaited<ReturnType<DockerClient['listNyabaseContainers']>>[number],
  ): Promise<MetricPoint[]> {
    const fullId = c.Id;
    const productContainerId = c.Labels[LABEL.CONTAINER_ID];
    if (!productContainerId) return [];
    const points: MetricPoint[] = [];

    try {
      const stats = await this.docker.fetchContainerStats(fullId);
      const labels = {
        server: this.config.serverId,
        container_id: productContainerId,
      };
      const ts = Date.now();
      points.push(
        { name: 'nyabase_container_cpu_usage_ratio', labels, value: stats.cpuUsageRatio, ts },
        { name: 'nyabase_container_mem_used_bytes', labels, value: stats.memUsedBytes, ts },
        { name: 'nyabase_container_mem_limit_bytes', labels, value: stats.memLimitBytes, ts },
        { name: 'nyabase_container_io_read_bytes_total', labels, value: stats.blockReadBytes, ts },
        {
          name: 'nyabase_container_io_write_bytes_total',
          labels,
          value: stats.blockWriteBytes,
          ts,
        },
        { name: 'nyabase_container_net_rx_bytes_total', labels, value: stats.netRxBytes, ts },
        { name: 'nyabase_container_net_tx_bytes_total', labels, value: stats.netTxBytes, ts },
      );
      if (stats.cpuUsageUsec !== undefined) {
        points.push({
          name: 'nyabase_container_cpu_usage_usec',
          labels,
          value: stats.cpuUsageUsec,
          ts,
        });
      }
    } catch {
      /* stats unavailable */
    }

    return points;
  }

  private gpuContainerIdentityMap(
    containers: Awaited<ReturnType<DockerClient['listNyabaseContainers']>>,
  ): Map<string, GpuContainerIdentity> {
    const result = new Map<string, GpuContainerIdentity>();
    for (const container of containers) {
      const fullId = container.Id;
      const shortId = fullId.slice(0, 12);
      const productContainerId = container.Labels[LABEL.CONTAINER_ID] ?? '';
      if (!productContainerId) continue;

      const identity = {
        metricContainerId: productContainerId,
      };
      result.set(fullId, identity);
      result.set(shortId, identity);
      if (productContainerId) result.set(productContainerId, identity);
    }
    return result;
  }

  private async startDockerEventListener(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.dockerEventListenerGeneration;
    let events: NodeJS.ReadableStream;
    try {
      events = await this.docker.openContainerEventStream();
    } catch (err) {
      console.error('[Agent] Failed to listen to docker events:', err);
      this.scheduleDockerEventReconnect(generation);
      return;
    }
    if (generation !== this.dockerEventListenerGeneration) {
      try {
        (events as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      } catch {
        /* stale stream */
      }
      return;
    }
    this.dockerEventStream = events as NodeJS.ReadableStream & { destroy?: () => void };

    let finished = false;
    const decoder = new DockerEventNdjsonDecoder();
    const reportManagedEvents = (decoded: readonly Record<string, unknown>[]) => {
      const managed = decoded.some((event) => {
        const actor = event.Actor;
        if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return false;
        const attributes = (actor as { Attributes?: unknown }).Attributes;
        if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return false;
        return (attributes as Record<string, unknown>)[LABEL.MANAGED] === 'true';
      });
      if (managed) void this.sendStateReport();
    };
    const onData = (chunk: Buffer | string) => {
      if (finished || generation !== this.dockerEventListenerGeneration) return;
      try {
        reportManagedEvents(decoder.push(chunk));
      } catch (error) {
        // The malformed frame may have hidden a managed lifecycle event.
        // Trigger a full observation before replacing the stream so state
        // convergence does not wait for the periodic reporting interval.
        void this.sendStateReport();
        reconnect(error);
      }
    };
    const reconnect = (error?: unknown) => {
      if (finished) return;
      finished = true;
      events.removeListener('data', onData);
      events.removeListener('error', onError);
      events.removeListener('end', onEnd);
      events.removeListener('close', onClose);
      try {
        (events as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      } catch {
        /* already closed */
      }
      if (this.dockerEventStream === events) this.dockerEventStream = null;
      if (error) console.error('[Agent] Docker event stream disconnected:', error);
      this.scheduleDockerEventReconnect(generation);
    };
    const onError = (error: unknown) => reconnect(error);
    const finishAndReconnect = () => {
      if (finished) return;
      try {
        reportManagedEvents(decoder.finish());
        reconnect();
      } catch (error) {
        void this.sendStateReport();
        reconnect(error);
      }
    };
    const onEnd = () => finishAndReconnect();
    const onClose = () => finishAndReconnect();
    events.on('data', onData);
    events.once('error', onError);
    events.once('end', onEnd);
    events.once('close', onClose);
    const streamState = events as NodeJS.ReadableStream & {
      destroyed?: boolean;
      readableEnded?: boolean;
    };
    if (streamState.destroyed || streamState.readableEnded) reconnect();
  }

  private scheduleDockerEventReconnect(generation: number): void {
    if (this.stopped || generation !== this.dockerEventListenerGeneration) return;
    if (this.dockerEventReconnectTimer) clearTimeout(this.dockerEventReconnectTimer);
    const timer = setTimeout(() => {
      if (this.dockerEventReconnectTimer === timer) this.dockerEventReconnectTimer = null;
      if (generation === this.dockerEventListenerGeneration) {
        void this.startDockerEventListener();
      }
    }, DOCKER_EVENT_RECONNECT_MS);
    timer.unref();
    this.dockerEventReconnectTimer = timer;
  }
}
