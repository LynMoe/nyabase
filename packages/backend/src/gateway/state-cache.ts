import {
  ActionAvailability,
  ContainerSnapshot,
  DataDirEntry,
  DataDirIssueDto,
  DiskInfo,
  GpuInfo,
  LocalImageInfo,
  RemoteFsMountStatus,
  DockerDaemonStatus,
  normalizeDockerImageRef,
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
  lastUpdated: number;
  agentVersion: string;
  hostname: string;
  cpuCores: number;
  totalMemBytes: number;
  dockerRoot: string;
  containers: Map<string, ContainerSnapshot>;
  disks: DiskInfo[];
  gpus: GpuInfo[];
  xfsProjects: XfsProjectUsageResolved[];
  /** Raw numeric XFS owners that cannot be resolved to a durable Backend user. */
  unknownXfsNumericIds: number[];
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

  /** Check one canonical, explicitly tagged/digested Docker reference. */
  hasImage(serverId: string, dockerRef: string): boolean {
    return this.resolveImageDockerId(serverId, dockerRef) !== null;
  }

  resolveImageDockerId(serverId: string, dockerRef: string): string | null {
    const snap = this.snapshots.get(serverId);
    if (!snap) return null;
    let canonical: string;
    try {
      canonical = normalizeDockerImageRef(dockerRef);
    } catch {
      return null;
    }
    const matches = snap.localImages.filter((img) =>
      img.repoTags.some((tag) => {
        try {
          return normalizeDockerImageRef(tag) === canonical;
        } catch {
          return false;
        }
      }),
    );
    return matches.length === 1 && matches[0].id.trim() !== '' ? matches[0].id : null;
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

  updateXfsProjects(
    serverId: string,
    projects: XfsProjectUsageResolved[],
    unknownNumericIds: number[] = [],
  ) {
    const snap = this.snapshots.get(serverId);
    if (snap) {
      snap.xfsProjects = projects;
      snap.unknownXfsNumericIds = unknownNumericIds;
    }
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

  getRemoteFsMountStatus(serverId: string, mountId: string): RemoteFsMountStatus | undefined {
    return this.snapshots.get(serverId)?.remoteFsMounts.find((m) => m.id === mountId);
  }

  updateDockerDaemonStatus(serverId: string, status: DockerDaemonStatus) {
    const snap = this.snapshots.get(serverId);
    if (!snap) return; // hello has not been processed yet; status will be re-sent on next interval
    snap.dockerDaemon = status;
  }

}
