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
  zDockerDaemonStatus,
} from '@nyabase/common';
import {
  Inject,
  Injectable,
  Optional,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';

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

@Injectable()
export class StateCache implements OnModuleInit, OnModuleDestroy {
  private snapshots: Map<string, ServerSnapshot> = new Map();
  private readonly logger = new Logger(StateCache.name);
  private projectionTimer: ReturnType<typeof setInterval> | null = null;
  private projectionPoll: Promise<void> | null = null;
  private projectionHealthy = false;
  private stopped = false;

  constructor(
    @Optional()
    @Inject(PG_DATABASE)
    private readonly database?: Kysely<NyabaseDatabase>,
    @Optional()
    private readonly runtimeRole?: RuntimeRoleService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (
      !this.database
      || !this.runtimeRole?.servesApi()
      || this.runtimeRole.servesGateway()
    ) return;
    this.stopped = false;
    await this.pollDurableProjections();
    if (this.stopped) return;
    this.projectionTimer = setInterval(
      () => void this.pollDurableProjections(),
      1_000,
    );
    this.projectionTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.projectionTimer) clearInterval(this.projectionTimer);
    this.projectionTimer = null;
    await this.projectionPoll;
  }

  isProjectionReady(): boolean {
    return !this.isApiProjectionRole() || this.projectionHealthy;
  }

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

  private async pollDurableProjections(): Promise<void> {
    if (this.stopped || !this.database) return;
    if (this.projectionPoll) return this.projectionPoll;
    const poll = this.refreshDurableProjections();
    this.projectionPoll = poll;
    try {
      await poll;
      if (!this.stopped) this.projectionHealthy = true;
    } catch (error) {
      if (!this.stopped) this.projectionHealthy = false;
      this.logger.warn(
        `Durable Agent projection refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (this.projectionPoll === poll) this.projectionPoll = null;
    }
  }

  private async refreshDurableProjections(): Promise<void> {
    if (this.stopped || !this.database) return;
    const rows = await this.database
      .selectFrom('workflow.agent_runtime_projections as projection')
      .innerJoin(
        'workflow.agent_sessions as session',
        'session.id',
        'projection.session_id',
      )
      .select([
        'projection.server_id',
        'projection.session_id',
        'projection.runtime_ready',
        'projection.state_report_json',
        'projection.docker_daemon_json',
      ])
      .where('session.state', '=', 'ready')
      .where('session.lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .whereRef('session.generation', '=', 'projection.session_generation')
      .whereRef('session.gateway_id', '=', 'projection.gateway_id')
      .execute();
    if (this.stopped) return;
    const active = new Set(rows.map((row) => row.server_id));
    for (const serverId of this.snapshots.keys()) {
      if (!active.has(serverId)) this.snapshots.delete(serverId);
    }
    for (const row of rows) {
      const snapshot = durableSnapshot(
        row.server_id,
        row.session_id,
        row.runtime_ready,
        row.state_report_json,
        row.docker_daemon_json,
      );
      if (snapshot) this.snapshots.set(row.server_id, snapshot);
    }
  }

  private isApiProjectionRole(): boolean {
    return Boolean(
      this.database
      && this.runtimeRole?.servesApi()
      && !this.runtimeRole.servesGateway(),
    );
  }

}

function durableSnapshot(
  serverId: string,
  sessionId: string,
  runtimeReady: boolean,
  value: unknown,
  dockerDaemonValue: unknown,
): ServerSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<ServerSnapshot> & {
    containers?: ContainerSnapshot[];
  };
  if (
    !Array.isArray(raw.containers)
    || !Array.isArray(raw.disks)
    || !Array.isArray(raw.gpus)
    || !Array.isArray(raw.localImages)
    || !Array.isArray(raw.dataDirs)
    || !Array.isArray(raw.remoteFsMounts)
  ) return null;
  const durableDockerDaemon = zDockerDaemonStatus.safeParse(dockerDaemonValue);
  const reportDockerDaemon = zDockerDaemonStatus.safeParse(raw.dockerDaemon);
  return {
    ...(raw as ServerSnapshot),
    serverId,
    sessionId,
    runtimeReady,
    containers: new Map(raw.containers.map((container) => [
      container.runtime.runtimeId,
      container,
    ])),
    xfsProjects: Array.isArray(raw.xfsProjects) ? raw.xfsProjects : [],
    unknownXfsNumericIds: Array.isArray(raw.unknownXfsNumericIds)
      ? raw.unknownXfsNumericIds
      : [],
    dataDirIssues: raw.dataDirIssues ?? { orphans: [], missing: [] },
    dockerDaemon:
      durableDockerDaemon.success
      && durableDockerDaemon.data.serverId === serverId
        ? durableDockerDaemon.data
        : reportDockerDaemon.success
          && reportDockerDaemon.data.serverId === serverId
          ? reportDockerDaemon.data
          : null,
  };
}
