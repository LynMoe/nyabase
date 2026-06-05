import {
  ActionAvailability,
  ContainerSnapshot,
  DataDirEntry,
  DataDirIssueDto,
  DiskInfo,
  GpuInfo,
  ContainerStatsSummary,
  ContainerStatus,
  LocalImageInfo,
  RemoteFsMountStatus,
  DockerDaemonStatus,
} from '@nyabase/common';

const AGENT_STATE_UNREADY_MESSAGE = 'Agent runtime state is not ready; wait for the first full state report';

/**
 * UUID-resolved version of an XFS project usage entry.
 * The agent reports numericUserId only; agent-gateway resolves it to UUID before
 * storing here so the rest of the backend can continue to index by UUID.
 */
export interface XfsProjectUsageResolved {
  userId: string;
  projectId: number;
  usedBytes: number;
  hardLimitBytes: number;
}

export interface ServerSnapshot {
  serverId: string;
  runtimeReady: boolean;
  sessionId: string;
  helloAt: number | null;
  lastFullReportAt: number | null;
  lastFullReportReceivedAt: number | null;
  lastIncrementalReportAt: number | null;
  lastIncrementalReportReceivedAt: number | null;
  lastUpdated: number;
  agentVersion: string;
  hostname: string;
  cpuCores: number;
  totalMemBytes: number;
  containers: Map<string, ContainerSnapshot>;
  disks: DiskInfo[];
  gpus: GpuInfo[];
  xfsProjects: XfsProjectUsageResolved[];
  /** Locally available images reported by agent */
  localImages: LocalImageInfo[];
  /** Full list of data dirs reported by agent (no userId — agent doesn't know owner) */
  dataDirs: DataDirEntry[];
  /** Reconciliation issues: orphans (FS only) and missing (DB only) */
  dataDirIssues: { orphans: DataDirIssueDto[]; missing: DataDirIssueDto[] };
  /** Remote FS mount statuses reported by agent */
  remoteFsMounts: RemoteFsMountStatus[];
  /** Live docker daemon status reported by agent */
  dockerDaemon: DockerDaemonStatus | null;
}

export class StateCache {
  private snapshots: Map<string, ServerSnapshot> = new Map();

  get(serverId: string): ServerSnapshot | undefined {
    return this.snapshots.get(serverId);
  }

  isRuntimeReady(serverId: string): boolean {
    return this.snapshots.get(serverId)?.runtimeReady === true;
  }

  requireRuntimeReady(serverId: string): ServerSnapshot {
    const snap = this.snapshots.get(serverId);
    if (!snap?.runtimeReady) {
      throw new Error(AGENT_STATE_UNREADY_MESSAGE);
    }
    return snap;
  }

  getRuntimeBlockReason(serverId: string): ActionAvailability {
    if (this.isRuntimeReady(serverId)) return { enabled: true };
    return {
      enabled: false,
      reason: 'agent_state_unready',
      message: AGENT_STATE_UNREADY_MESSAGE,
    };
  }

  set(serverId: string, snapshot: ServerSnapshot) {
    this.snapshots.set(serverId, snapshot);
  }

  delete(serverId: string) {
    this.snapshots.delete(serverId);
  }

  getAll(): ServerSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  getContainer(serverId: string, dockerId: string): ContainerSnapshot | undefined {
    return this.snapshots.get(serverId)?.containers.get(dockerId);
  }

  getContainerByContainerId(serverId: string, containerId: string): ContainerSnapshot | undefined {
    const snap = this.snapshots.get(serverId);
    if (!snap) return undefined;
    for (const container of snap.containers.values()) {
      const labels = container.labels ?? {};
      if (labels['nyabase.containerId'] === containerId || labels['nyabase.container_id'] === containerId) {
        return container;
      }
    }
    return undefined;
  }

  /** Get all containers across all servers, optionally filtered by ownerId */
  getContainers(ownerId?: string): Array<ContainerSnapshot & { serverId: string; serverHostname: string }> {
    const result: Array<ContainerSnapshot & { serverId: string; serverHostname: string }> = [];
    for (const snap of this.snapshots.values()) {
      for (const c of snap.containers.values()) {
        if (!ownerId || c.spec.ownerId === ownerId) {
          result.push({ ...c, serverId: snap.serverId, serverHostname: snap.hostname });
        }
      }
    }
    return result;
  }

  /** Aggregate resource usage for a user on a specific server (from stateCache) */
  getUserUsageOnServer(userId: string, serverId: string) {
    const snap = this.snapshots.get(serverId);
    if (!snap) return { cpuMillis: 0, memBytes: 0, diskBytes: 0 };

    let cpuMillis = 0, memBytes = 0;
    for (const c of snap.containers.values()) {
      if (c.spec.ownerId !== userId) continue;
      cpuMillis += c.spec.cpuMillis;
      memBytes += c.spec.memBytes;
    }

    const xfsProject = snap.xfsProjects.find((p) => p.userId === userId);
    const diskBytes = xfsProject?.usedBytes ?? 0;

    return { cpuMillis, memBytes, diskBytes };
  }

  /** Get GPU index → container count map for a server */
  getGpuLoadMap(serverId: string): Map<number, number> {
    const snap = this.snapshots.get(serverId);
    const map = new Map<number, number>();
    if (!snap) return map;

    for (const gpu of snap.gpus) {
      map.set(gpu.index, 0);
    }

    for (const c of snap.containers.values()) {
      for (const idx of c.spec.gpuIndices) {
        if (map.has(idx)) {
          map.set(idx, (map.get(idx) ?? 0) + 1);
        }
      }
    }
    return map;
  }

  /** Pick N GPU indices with least containers (for auto-assignment) */
  pickGpuIndices(serverId: string, count: number): number[] {
    const loadMap = this.getGpuLoadMap(serverId);
    return [...loadMap.entries()]
      .sort((a, b) => a[1] - b[1] || a[0] - b[0])
      .slice(0, count)
      .map(([idx]) => idx);
  }

  /** Whether a specific GPU index has no running containers */
  isGpuFree(serverId: string, gpuIndex: number): boolean {
    const loadMap = this.getGpuLoadMap(serverId);
    const load = loadMap.get(gpuIndex);
    return typeof load === 'number' && load === 0;
  }

  updateContainerStats(serverId: string, dockerId: string, stats: ContainerStatsSummary) {
    const snap = this.snapshots.get(serverId);
    if (!snap?.runtimeReady) return;
    const container = snap.containers.get(dockerId);
    if (!container) return;
    container.stats = stats;
  }

  /** Check whether a docker image ref exists on a server.
   *
   * Matching rules:
   *  - `ref:tag`  → exact match only (e.g. "ubuntu:22.04" must match "ubuntu:22.04")
   *  - `ref`      → matches "ref" or "ref:latest" (Docker implicit-latest convention)
   */
  hasImage(serverId: string, dockerRef: string): boolean {
    const snap = this.snapshots.get(serverId);
    if (!snap) return false;
    const hasTag = dockerRef.includes(':');
    return snap.localImages.some((img) =>
      img.repoTags.some((tag) => {
        if (tag === dockerRef) return true;
        if (!hasTag && tag === `${dockerRef}:latest`) return true;
        return false;
      }),
    );
  }

  /** Get image status for all online servers */
  getImageStatusOnServers(dockerRef: string): Array<{ serverId: string; hostname: string; present: boolean }> {
    return Array.from(this.snapshots.values()).map((snap) => ({
      serverId: snap.serverId,
      hostname: snap.hostname,
      present: this.hasImage(snap.serverId, dockerRef),
    }));
  }

  updateLocalImages(serverId: string, images: LocalImageInfo[]) {
    const snap = this.snapshots.get(serverId);
    if (snap) snap.localImages = images;
  }

  updateDiskInfo(serverId: string, disks: DiskInfo[]) {
    const snap = this.snapshots.get(serverId);
    if (snap) snap.disks = disks;
  }

  updateXfsProjects(serverId: string, projects: XfsProjectUsageResolved[]) {
    const snap = this.snapshots.get(serverId);
    if (snap) snap.xfsProjects = projects;
  }

  updateDataDirs(serverId: string, dirs: DataDirEntry[]) {
    const snap = this.snapshots.get(serverId);
    if (snap) snap.dataDirs = dirs;
  }

  updateDataDirIssues(serverId: string, issues: { orphans: DataDirIssueDto[]; missing: DataDirIssueDto[] }) {
    const snap = this.snapshots.get(serverId);
    if (snap) snap.dataDirIssues = issues;
  }

  getDataDirIssues(sourceKind?: string, sourceId?: string): DataDirIssueDto[] {
    const all: DataDirIssueDto[] = [];
    for (const snap of this.snapshots.values()) {
      const issues = [...snap.dataDirIssues.orphans, ...snap.dataDirIssues.missing];
      for (const issue of issues) {
        if (sourceKind && issue.entry.sourceKind !== sourceKind) continue;
        if (sourceId && issue.entry.sourceId !== sourceId) continue;
        all.push(issue);
      }
    }
    return all;
  }

  updateRemoteFsMountStatus(serverId: string, status: RemoteFsMountStatus) {
    const snap = this.snapshots.get(serverId);
    if (!snap?.runtimeReady) return;
    const idx = snap.remoteFsMounts.findIndex((m) => m.id === status.id);
    if (idx >= 0) snap.remoteFsMounts[idx] = status;
    else snap.remoteFsMounts.push(status);
  }

  getRemoteFsMountStatus(serverId: string, mountId: string): RemoteFsMountStatus | undefined {
    return this.snapshots.get(serverId)?.remoteFsMounts.find((m) => m.id === mountId);
  }

  updateDockerDaemonStatus(serverId: string, status: DockerDaemonStatus) {
    const snap = this.snapshots.get(serverId);
    if (!snap) return; // hello has not been processed yet; status will be re-sent on next interval
    snap.dockerDaemon = status;
  }

  /** Get raw data dirs reported by agent for a server */
  getDataDirs(serverId: string): DataDirEntry[] {
    return this.snapshots.get(serverId)?.dataDirs ?? [];
  }

  applyContainerEvent(serverId: string, dockerId: string, action: string) {
    const snap = this.snapshots.get(serverId);
    if (!snap) return;
    const container = snap.containers.get(dockerId);
    if (!container) return;

    switch (action) {
      case 'start':
        container.status = ContainerStatus.Running;
        break;
      case 'stop':
      case 'die':
        container.status = ContainerStatus.Exited;
        break;
      case 'destroy':
        snap.containers.delete(dockerId);
        break;
      case 'pause':
        container.status = ContainerStatus.Paused;
        break;
      case 'unpause':
        container.status = ContainerStatus.Running;
        break;
    }
  }
}
