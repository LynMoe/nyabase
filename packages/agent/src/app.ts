import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { AgentConfig } from './config.js';
import { AgentWsClient } from './ws/client.js';
import { DockerClient } from './docker/docker-client.js';
import { DaemonManager, SOCKET_PATH } from './docker/daemon-manager.js';
import { XfsQuotaManager } from './quota/xfs-quota.js';
import { DataDirsManager } from './datadirs/data-dirs.js';
import { RemoteFsMounter } from './fs/remote-fs-mounter.js';
import { GpuMonitor, probeGpuAvailability, type GpuContainerIdentity } from './gpu/gpu-monitor.js';
import { HostMetricsCollector } from './metrics/host-metrics.js';
import { CommandDispatcher, withDockerMutex } from './commands/dispatcher.js';
import { DropbearManager } from './dropbear/dropbear-manager.js';
import {
  ContainerStatus,
  ContainerSnapshot,
  AgentToBackendMessage,
  LABEL,
  type MetricPoint,
  type LocalImageInfo,
  type ContainerStatsSummary,
  RemoteFsMountStatus,
} from '@nyabase/common';

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

export class AgentApplication {
  private readonly docker: DockerClient;
  private readonly quota: XfsQuotaManager;
  private readonly dataDirs: DataDirsManager;
  private readonly gpuMonitor: GpuMonitor;
  private readonly hostMetrics: HostMetricsCollector;
  private readonly remoteFsMounter: RemoteFsMounter;
  private readonly dropbearManager: DropbearManager;
  private readonly wsClient: AgentWsClient;
  private readonly dispatcher: CommandDispatcher;

  /** Set to false once the one-time nvidia-smi probe fails (or if config disables it). */
  private gpuActive: boolean;
  /** Round-robin cursor for container stats sharding. */
  private statsShardCursor = 0;

  constructor(
    private readonly config: AgentConfig,
    private readonly mountHelperOk: boolean,
    private readonly daemonManager: DaemonManager,
  ) {
    this.docker = new DockerClient(config);
    this.quota = new XfsQuotaManager(config.dockerRoot);
    this.dataDirs = new DataDirsManager(this.quota, config.dockerRoot);
    this.gpuMonitor = new GpuMonitor(config.isGpuServer);
    this.gpuActive = config.isGpuServer;
    this.hostMetrics = new HostMetricsCollector();
    this.dropbearManager = new DropbearManager(this.docker, withDockerMutex);

    this.remoteFsMounter = new RemoteFsMounter((status: RemoteFsMountStatus) => {
      this.sendIfConnected({
        id: uuidv4(), ts: Date.now(), kind: 'remoteFsMountStatus', payload: status,
      } as AgentToBackendMessage);
    });

    this.wsClient = new AgentWsClient({
      url: config.backendUrl,
      token: config.agentToken,
      onConnect: () => this.onConnect(),
      onDisconnect: () => console.log('[Agent] Disconnected from backend'),
    });

    this.dispatcher = new CommandDispatcher(
      config, this.docker, this.quota, this.dataDirs,
      this.remoteFsMounter, this.wsClient, this.dropbearManager, this.daemonManager,
      (dockerId) => this.getContainerGpuMemUsedMiB(dockerId),
    );

    // Wire the message handler after both wsClient and dispatcher are fully constructed.
    this.wsClient.setMessageHandler((msg) => this.dispatcher.handle(msg));
  }

  start(): void {
    this.wsClient.on('diskChanged', () => {
      void this.sendStateReport();
      void this.sendDataDirReport();
    });
    this.wsClient.on('dataDirChanged', () => void this.sendDataDirReport());
    this.wsClient.on('reconcile', () => {
      void this.sendStateReport();
      void this.sendDataDirReport();
    });

    setInterval(() => {
      if (this.wsClient.connected) {
        this.wsClient.send({
          id: uuidv4(), ts: Date.now(), kind: 'heartbeat',
          payload: { serverId: this.config.serverId, uptime: process.uptime() },
        } as AgentToBackendMessage);
      }
    }, 5_000);

    setInterval(() => void this.sendStateReport(), 15_000);
    setInterval(() => void this.sendDataDirReport(), 60_000);
    setInterval(() => void this.collectAndSendMetrics(), this.config.metricsIntervalMs);
    setInterval(() => void this.sendDockerDaemonStatus(), 30_000);

    void this.startDockerEventListener();
    // One-time host probe; permanently disables GPU collection if nvidia-smi
    // is missing or the host has no GPUs, even when isGpuServer=true.
    if (this.gpuActive) {
      void probeGpuAvailability().then((has) => {
        if (!has) {
          console.log('[Agent] nvidia-smi probe failed or no GPUs detected — disabling GPU metrics.');
          this.gpuActive = false;
        }
      });
    }
    this.wsClient.start();
  }

  private sendIfConnected(msg: AgentToBackendMessage): void {
    if (this.wsClient.connected) {
      this.wsClient.send(msg);
    }
  }

  private async onConnect(): Promise<void> {
    try {
      await this.docker.ensureMacvlanNetwork();
    } catch (e) {
      console.warn('[Agent] Could not ensure macvlan network:', (e as Error).message);
    }
    await this.sendHello();
    await this.sendStateReport();
    await this.sendDataDirReport();
    await this.sendDockerDaemonStatus();
  }

  private async sendHello(): Promise<void> {
    const [gpus, diskInfos] = [await this.gpuMonitor.getGpuInfo(), this.dataDirs.getLocalDiskInfos()];
    const localImages = await this.listLocalImages();

    this.wsClient.send({
      id: uuidv4(), ts: Date.now(), kind: 'hello',
      payload: {
        serverId: this.config.serverId,
        hostname: os.hostname(),
        kernelVersion: os.release(),
        cpuCores: os.cpus().length,
        totalMemBytes: os.totalmem(),
        disks: diskInfos,
        gpus,
        macvlanCidr: this.config.macvlanCidr,
        macvlanGateway: this.config.macvlanGateway,
        macvlanIface: this.config.parentIface,
        agentVersion: this.config.agentVersion,
        localImages,
        mountHelperMissing: !this.mountHelperOk,
        dockerRoot: this.config.dockerRoot,
        dockerSocket: SOCKET_PATH,
      },
    } as AgentToBackendMessage & { payload: { mountHelperMissing?: boolean } });
  }

  private async listLocalImages(): Promise<LocalImageInfo[]> {
    try {
      const imgs = await this.docker.docker.listImages({ all: false });
      return imgs.map((img) => ({
        id: img.Id,
        repoTags: img.RepoTags ?? [],
        size: img.Size,
        createdAt: img.Created,
      }));
    } catch (e) {
      console.warn('[Agent] Failed to list images:', e);
      return [];
    }
  }

  async sendDockerDaemonStatus(): Promise<void> {
    if (!this.wsClient.connected) return;
    try {
      const status = await this.daemonManager.getStatus(this.config.serverId);
      this.wsClient.send({
        id: uuidv4(), ts: Date.now(), kind: 'dockerDaemonStatus', payload: status,
      } as AgentToBackendMessage);
    } catch (e) {
      console.warn('[Agent] Failed to send dockerDaemonStatus:', e);
    }
  }

  private async sendStateReport(): Promise<void> {
    if (!this.wsClient.connected) return;
    try {
      const observedAt = Date.now();
      const containers = await this.docker.listNyabaseContainers();

      // Fetch stats for all running containers in parallel
      const runningIds = new Set(containers.filter((c) => c.State === 'running').map((c) => c.Id));
      const statsResults = await Promise.allSettled(
        [...runningIds].map((id) =>
          this.docker.fetchContainerStatsWithGpuMem(
            id,
            (dockerId) => this.getContainerGpuMemUsedMiB(dockerId),
          ).then((stats) => ({ id, stats })),
        ),
      );
      const statsMap = new Map<string, ContainerStatsSummary>();
      for (const r of statsResults) {
        if (r.status === 'fulfilled') statsMap.set(r.value.id, r.value.stats);
      }

      const snapshots: ContainerSnapshot[] = [];
      for (const c of containers) {
        const spec = this.docker.parseContainerSpec(c.Labels, c);
        if (!spec) continue;
        spec.runtimeId = c.Id;

        const status: ContainerStatus = DOCKER_STATE_TO_STATUS[c.State] ?? ContainerStatus.Unknown;
        const stats = statsMap.get(c.Id) ?? null;
        const sshServer = await this.dropbearManager.inspectContainerSshState(
          c.Id,
          false,
          status,
        );
        snapshots.push({ spec, status, stats, sshServer, labels: c.Labels });
      }

      const [xfsProjects, diskInfos, remoteFsMountStatuses, localImages] = await Promise.all([
        this.quota.getAllUsages(),
        Promise.resolve(this.dataDirs.getLocalDiskInfos()),
        Promise.resolve(this.remoteFsMounter.getAllStatuses()),
        this.listLocalImages(),
      ]);

      this.wsClient.send({
        id: uuidv4(), ts: Date.now(), kind: 'stateReport',
        payload: {
          serverId: this.config.serverId,
          observedAt,
          containers: snapshots,
          xfsProjects: xfsProjects.map(({ numericUserId, projectId, usedBytes, hardLimitBytes }) => ({
            numericUserId, projectId, usedBytes, hardLimitBytes,
          })),
          disks: diskInfos,
          localImages,
          remoteFsMounts: remoteFsMountStatuses,
          incremental: false,
        },
      } as AgentToBackendMessage);
    } catch (e) {
      console.warn('[Agent] Failed to send stateReport:', e);
    }
  }

  private async sendDataDirReport(): Promise<void> {
    if (!this.wsClient.connected) return;
    try {
      const observedAt = Date.now();
      const dirs = await this.dataDirs.listAllDirs();
      this.wsClient.send({
        id: uuidv4(), ts: Date.now(), kind: 'dataDirReport',
        payload: { serverId: this.config.serverId, observedAt, dirs },
      } as AgentToBackendMessage);
    } catch (e) {
      console.warn('[Agent] Failed to send dataDirReport:', e);
    }
  }

  private async collectAndSendMetrics(): Promise<void> {
    if (!this.wsClient.connected) return;

    const disks = this.dataDirs.getLocalDiskInfos();
    const hostPoints = this.hostMetrics.collectHostMetrics(this.config.serverId, disks);

    const [gpuStats, gpuProcesses, containers] = await Promise.all([
      this.gpuActive ? this.gpuMonitor.getGpuStats() : Promise.resolve([]),
      this.gpuActive ? this.gpuMonitor.getGpuProcesses() : Promise.resolve([]),
      this.docker.listNyabaseContainers().catch(() => []),
    ]);

    const containerOwnerMap = this.gpuContainerIdentityMap(containers);
    const gpuPoints = this.gpuActive
      ? this.gpuMonitor.buildMetrics(gpuStats, gpuProcesses, containerOwnerMap, this.config.serverId)
      : [];

    // Round-robin shard the per-container `stats` work to avoid hammering the
    // daemon when a host runs many containers. Each cycle covers up to
    // CONTAINER_STATS_SHARD_SIZE running containers; subsequent cycles rotate.
    const running = containers.filter((c) => c.State === 'running');
    const shard = pickShard(running, this.statsShardCursor, CONTAINER_STATS_SHARD_SIZE);
    this.statsShardCursor = running.length === 0
      ? 0
      : (this.statsShardCursor + shard.length) % running.length;

    const containerResults = await Promise.allSettled(
      shard.map((c) => this.collectContainerMetrics(c)),
    );
    const containerPoints: MetricPoint[] = containerResults
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

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
    } catch { /* quota unavailable */ }

    const allPoints = [...hostPoints, ...gpuPoints, ...containerPoints, ...userDiskPoints];
    if (allPoints.length > 0) {
      this.wsClient.send({
        id: uuidv4(), ts: Date.now(), kind: 'metricsBatch',
        payload: { serverId: this.config.serverId, points: allPoints },
      } as AgentToBackendMessage);
    }
  }

  private async collectContainerMetrics(
    c: Awaited<ReturnType<DockerClient['listNyabaseContainers']>>[number],
  ): Promise<MetricPoint[]> {
    const fullId = c.Id;
    const shortId = fullId.slice(0, 12);
    const ownerId = c.Labels['nyabase.ownerId'] ?? '';
    const containerName = c.Labels[LABEL.CONTAINER_ID] ?? shortId;
    const points: MetricPoint[] = [];

    try {
      const stats = await this.docker.fetchContainerStats(fullId);
      const labels = {
        server: this.config.serverId,
        container_id: shortId,
        container_name: containerName,
        user_id: ownerId,
      };
      const ts = Date.now();
      points.push(
        { name: 'nyabase_container_cpu_usage_ratio', labels, value: stats.cpuUsageRatio, ts },
        ...(stats.cpuUsageUsec !== undefined
          ? [{ name: 'nyabase_container_cpu_usage_usec', labels, value: stats.cpuUsageUsec, ts }]
          : []),
        { name: 'nyabase_container_mem_used_bytes', labels, value: stats.memUsedBytes, ts },
        { name: 'nyabase_container_mem_limit_bytes', labels, value: stats.memLimitBytes, ts },
        { name: 'nyabase_container_io_read_bytes_total', labels, value: stats.blockReadBytes, ts },
        { name: 'nyabase_container_io_write_bytes_total', labels, value: stats.blockWriteBytes, ts },
        { name: 'nyabase_container_net_rx_bytes_total', labels, value: stats.netRxBytes, ts },
        { name: 'nyabase_container_net_tx_bytes_total', labels, value: stats.netTxBytes, ts },
      );
    } catch { /* stats unavailable */ }

    return points;
  }

  private async getContainerGpuMemUsedMiB(dockerId: string): Promise<Record<string, number>> {
    if (!this.gpuActive) return {};
    return this.gpuMonitor.getContainerGpuMemUsedMiB(dockerId);
  }

  private gpuContainerIdentityMap(
    containers: Awaited<ReturnType<DockerClient['listNyabaseContainers']>>,
  ): Map<string, GpuContainerIdentity> {
    const result = new Map<string, GpuContainerIdentity>();
    for (const container of containers) {
      const fullId = container.Id;
      const shortId = fullId.slice(0, 12);
      const ownerId = container.Labels['nyabase.ownerId'] ?? '';
      const productContainerId = container.Labels[LABEL.CONTAINER_ID] ?? '';

      const identity = {
        metricContainerId: shortId,
        ...(ownerId ? { ownerId } : {}),
      };
      result.set(fullId, identity);
      result.set(shortId, identity);
      if (productContainerId) result.set(productContainerId, identity);
    }
    return result;
  }

  private async startDockerEventListener(): Promise<void> {
    try {
      const events = await this.docker.docker.getEvents({ filters: { type: ['container'] } });
      events.on('data', (chunk: Buffer) => {
        try {
          const event = JSON.parse(chunk.toString());
          const action: string = event.Action;
          const runtimeId: string = event.Actor?.ID;
          const labels: Record<string, string> = event.Actor?.Attributes ?? {};
          if (labels[LABEL.MANAGED] !== 'true' && !labels['nyabase.spec_version']) return;
          this.wsClient.send({
            id: uuidv4(), ts: Date.now(), kind: 'containerEvent',
            payload: { serverId: this.config.serverId, runtimeId, action },
          } as AgentToBackendMessage);
        } catch { /* ignore parse errors */ }
      });
    } catch (err) {
      console.error('[Agent] Failed to listen to docker events:', err);
    }
  }
}
