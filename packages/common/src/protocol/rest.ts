/**
 * REST DTOs and response shapes.
 *
 * Request schemas are defined in `./rest-schema.ts` (Zod, parsed on the
 * server). This file only re-exports the inferred request types and adds
 * response/DTO interfaces that are not validated at runtime.
 */

import {
  UserStatus,
  ServerStatus,
  Capability,
  GpuGrantMode,
  ContainerPowerIntent,
  ContainerStatus,
  AgentTaskKind,
  AgentTaskStatus,
  RuntimeDriftKind,
} from '../enums.js';
import type {
  ContainerStatsSummary,
  ContainerSshServerStatus,
  DiskInfo,
  GpuInfo,
  DataDirEntry,
  DockerDaemonStatus,
  CephFsParams,
  NfsParams,
  RemoteFsParams,
  RemoteFsMountStatus,
} from './agent-messages.js';
import type { ImageRuntimeOverrides } from './rest-schema.js';

// Re-export all inferred request types from the Zod schema module so consumers
// can keep importing them from this barrel.
export type {
  LoginRequest,
  RefreshTokenRequest,
  RotateRefreshTokenRequest,
  CreateApiTokenRequest,
  CreateUserRequest,
  UpdateUserRequest,
  AddSshKeyRequest,
  CreateServerRequest,
  UpdateServerRequest,
  ImageRuntimeOverrides,
  CreateImageRequest,
  UpdateImageRequest,
  UpdateAdminImageRequest,
  PullImageRequest,
  CreateContainerRequest,
  UpdateContainerMountsRequest,
  ExecSessionRequest,
  CreateDataDirRequest,
  RemoteFsCreateParams,
  CreateRemoteFsMountRequest,
  UpdateRemoteFsMountRequest,
  CreateGroupRequest,
  UpdateGroupRequest,
  UpdateAdminGroupRequest,
  UpsertServerGrantRequest,
  AddGroupMemberRequest,
  AddImageGrantRequest,
  SyncImageGrantServersRequest,
  PatchSystemSettingsRequest,
} from './rest-schema.js';
import type { ConfigSourceName, ConfigValueKind } from '../config/definition.js';

export interface ExecSessionResponse {
  sessionId: string;
  /** Owner-affine WebSocket URL. This routes only; JWT + PostgreSQL claim authorize. */
  consoleUrl: string;
}

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OffsetPaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: UserDto;
}

export interface RefreshTokenResponse {
  accessToken: string;
  refreshToken: string;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  status: UserStatus;
  createdAt: string;
  /** Resolved union of all group capabilities */
  capabilities: Capability[];
  /** Groups the user belongs to */
  groups: GroupSummaryDto[];
}

export interface ActionAvailabilityDto {
  allowed: boolean;
  reason: string | null;
  missingCapabilities: Capability[];
}

export interface UserAdministrationAvailabilityDto {
  canAdminister: ActionAvailabilityDto;
  canDelete: ActionAvailabilityDto;
}

export interface GroupAdministrationAvailabilityDto {
  canEditMetadata: ActionAvailabilityDto;
  canEditPriority: ActionAvailabilityDto;
  canManageMembers: ActionAvailabilityDto;
  /** Current-member removals may be narrower than generic membership edits. */
  canRemoveMembers: Record<string, ActionAvailabilityDto>;
  canDelete: ActionAvailabilityDto;
}

/** Current, authoritative administration decisions for one actor snapshot. */
export interface AdministrationActionsDto {
  actorCapabilities: Capability[];
  assignableGroupCapabilities: Capability[];
  createUser: ActionAvailabilityDto;
  createGroup: ActionAvailabilityDto;
  users: Record<string, UserAdministrationAvailabilityDto>;
  groups: Record<string, GroupAdministrationAvailabilityDto>;
}

export interface SshPublicKeyDto {
  id: string;
  name: string;
  keyText: string;
  createdAt: string;
}

export interface ApiTokenDto {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreateApiTokenResponse {
  token: ApiTokenDto;
  /** Raw token, shown only once */
  secret: string;
}

// ---------------------------------------------------------------------------
// Public settings
// ---------------------------------------------------------------------------

export interface PublicSettingsDto {
  branding: {
    title: string;
    description: string;
  };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface GroupSummaryDto {
  id: string;
  name: string;
  priority: number;
  isSystem: boolean;
}

export interface GroupDto {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  isSystem: boolean;
  capabilities: Capability[];
  /** Durable optimistic-concurrency token for metadata edits. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Server IDs that have grants for this group (populated in list endpoint) */
  serverIds?: string[];
  /** Full server grants with resource details (populated in list endpoint) */
  serverGrants?: ServerGrantDto[];
  /** Unique image IDs that have grants for this group (populated in list endpoint) */
  imageIds?: string[];
  /** Members with user details (populated in list endpoint) */
  members?: GroupMemberDto[];
  /** Number of members in this group (populated in list endpoint) */
  memberCount?: number;
}

export interface GroupMemberDto {
  userId: string;
  username: string;
  displayName: string;
}

// ---------------------------------------------------------------------------
// System settings
// ---------------------------------------------------------------------------

export interface SystemSettingFieldDto {
  key: string;
  yamlPath: string;
  env: string;
  valueKind: ConfigValueKind;
  effectiveValue: unknown;
  source: ConfigSourceName;
  yamlValue: unknown;
  envValuePresent: boolean;
  defaultValue: unknown;
  secret: boolean;
  editable: boolean;
  restartRequired: boolean;
  public: boolean;
  label: string;
  description: string;
}

export interface SystemSettingsDto {
  revision: number;
  /** Opaque PostgreSQL snapshot identity paired with the absolute CAS revision. */
  snapshotToken: string;
  configFile: string;
  fields: SystemSettingFieldDto[];
  editable: SystemSettingFieldDto[];
  readOnly: SystemSettingFieldDto[];
  publicSettings: PublicSettingsDto;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditResourceSnapshotDto {
  id: string | null;
  type: string | null;
  name: string | null;
  labels?: Record<string, string | number | boolean | null>;
}

export interface AuditLogDto {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorUsername: string | null;
  actorSnapshot: AuditResourceSnapshotDto | null;
  action: string;
  targetId: string | null;
  targetType: string | null;
  targetName: string | null;
  targetSnapshot: AuditResourceSnapshotDto | null;
  related: AuditResourceSnapshotDto[];
  payload: unknown;
  ts: string;
}

export type AuditListResponse = OffsetPaginatedResponse<AuditLogDto>;

export interface SshProxyHostKeySummaryDto {
  fingerprint: string | null;
  generation: number | null;
  rotatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export interface ServerDto {
  id: string;
  name: string;
  slug: string;
  /** Admin-only immutable host identity bound by the authenticated Agent hello. */
  hostFingerprint?: string | null;
  status: ServerStatus;
  quarantineCode: string | null;
  quarantineMessage: string | null;
  lastSeenAt: string | null;
  runtimeReady: boolean;
  runtimeObservedAt: string | null;
  /** Latest persisted/runtime-reported host disk observations */
  disks?: DiskInfo[];
  gpus?: GpuInfo[];
  agentVersion?: string;
  /** Latest persisted/runtime-reported docker daemon status */
  dockerDaemon?: DockerDaemonStatus | null;
}

/** Purpose-safe server selector returned to an ordinary current principal. */
export interface UserServerDto {
  id: string;
  name: string;
  slug: string;
  status: ServerStatus;
  lastSeenAt: string | null;
  runtimeReady: boolean;
}

export interface ServerAgentTokenResponse {
  /** Raw token, shown only once */
  token: string;
}

// ---------------------------------------------------------------------------
// Data Disks
// ---------------------------------------------------------------------------

/** Mirrors DiskInfo reported by agent; diskId is the stable identifier */
export interface DataDiskDto {
  diskId: string;
  mountPoint: string;
  sourceIdentity: string;
  label?: string;
  totalBytes: number;
  usedBytes: number;
  pquotaEnabled: boolean;
}

/** Ordinary-user disk selector; physical paths and source identities stay server-side. */
export interface UserDataDiskDto {
  diskId: string;
  displayName: string;
  totalBytes: number;
  usedBytes: number;
  pquotaEnabled: boolean;
}

/** Ordinary-user GPU selector without the host hardware UUID. */
export interface UserGpuDto {
  index: number;
  model: string;
  totalMemMiB: number;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ImageDto {
  id: string;
  name: string;
  dockerImage: string;
  runtimeOverrides: ImageRuntimeOverrides;
  description: string | null;
  isActive: boolean;
  disableSsh: boolean;
}

/** Explicit administrative lifecycle projection; never serialize ImageEntity directly. */
export interface AdminImageDto extends ImageDto {
  revision: number;
  deleting: boolean;
  cleanupGeneration: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export interface ServerGrantDto {
  id: string;
  scope: 'group' | 'user';
  scopeId: string;
  serverId: string;
  /** null (or resolved 0) means no CPU limit. */
  cpuMillis: number | null;
  /** null (or resolved 0) means no memory limit. */
  memBytes: number | null;
  /** null (or resolved 0) means no disk quota limit. */
  diskBytes: number | null;
  /** null retains the historical all-GPU policy; CPU-only grants use `none`. */
  gpuMode: GpuGrantMode | null;
  gpuIndices: number[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImageGrantDto {
  id: string;
  scope: 'group' | 'user';
  scopeId: string;
  imageId: string;
  serverId: string;
  createdAt: string;
}

/** The resolved access for a user on a specific server */
export interface EffectiveServerAccessDto {
  serverId: string;
  cpuMillis: number;
  memBytes: number;
  diskBytes: number;
  gpuMode: GpuGrantMode;
  gpuIndices: number[];
  /** imageIds accessible on this server */
  allowedImageIds: string[];
}

export interface EffectiveAccessDto {
  servers: EffectiveServerAccessDto[];
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export type ContainerAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'delete'
  | 'stats'
  | 'console'
  | 'updateMounts'
  | 'reconcileSsh';

export type ActionBlockedReason =
  | 'container_unbound'
  | 'phase_not_active'
  | 'task_in_progress'
  | 'agent_offline'
  | 'agent_state_unready'
  | 'runtime_missing'
  | 'runtime_stale'
  | 'permission_denied'
  | 'quota_exceeded'
  | 'gpu_inventory_unavailable'
  | 'insufficient_gpu_capacity'
  | 'image_not_available';

export interface ActionAvailability {
  enabled: boolean;
  reason?: ActionBlockedReason;
  message?: string;
  taskId?: string;
}

export interface ContainerRuntimeView {
  bound: boolean;
  runtimeId: string | null;
  status: ContainerStatus;
  ip?: string | null;
  observedAt: string | null;
  stale?: boolean;
  drift: RuntimeDriftDto[];
}

export interface ContainerSshView {
  enabled: boolean;
  status: ContainerSshServerStatus;
  ready: boolean;
  disabledReason?:
    | 'image_ssh_disabled'
    | 'runtime_not_running'
    | 'route_missing'
    | 'sync_pending'
    | 'unknown';
  login?: {
    omittedServer: string | null;
    explicitServer: string | null;
  };
  proxyHost?: string | null;
  proxyPort?: number | null;
  observedAt?: string | null;
  appliedInternalKeyGeneration?: number | null;
  hostKeyFingerprint?: string | null;
  user?: 'root';
  port?: 22;
  lastError?: string;
}

export interface UserInternalSshKeyDto {
  userId: string;
  publicKey: string;
  privateKey?: string;
  fingerprint: string;
  generation: number;
  rotatedAt: string;
}

export interface ContainerMountView {
  id: string;
  sourceKind: 'local' | 'remote';
  sourceId: string;
  dirName: string;
  containerPath: string;
}

export interface ContainerView {
  id: string;
  serverId: string;
  serverName: string;
  ownerId: string;
  ownerName?: string;
  name: string;
  imageId: string;
  imageName?: string;
  failureCode?: string | null;
  failureReason?: string | null;
  powerIntent: ContainerPowerIntent;
  runtimeReady: boolean;
  runtime: ContainerRuntimeView;
  activeTask: UserAgentTaskDto | null;
  resources: {
    cpuMillis: number;
    memBytes: number;
    diskBytes: number;
    gpuIndices: number[];
  };
  ssh: ContainerSshView;
  mounts: ContainerMountView[];
  actions: Record<ContainerAction, ActionAvailability>;
}

export interface ApiErrorV2 {
  statusCode: number;
  code: string;
  reason: ActionBlockedReason | string;
  action?: ContainerAction;
  resourceType?: string;
  resourceId?: string;
  activeTaskId?: string | null;
  message: string;
}

export interface ContainerStatsResponse {
  containerId: string;
  stats: ContainerStatsSummary | null;
  ts: number;
  lastObservedAt?: string;
}

export interface AgentTaskRefResponse {
  ok: true;
  taskId: string;
  status: AgentTaskStatus;
}

export interface AgentTaskDto {
  id: string;
  kind: AgentTaskKind;
  status: AgentTaskStatus;
  resourceType: string;
  resourceId: string;
  serverId: string;
  requestedBy: string | null;
  request: unknown | null;
  agentResult: unknown | null;
  result: unknown | null;
  error: unknown | null;
  failureStage: 'dispatch' | 'agent' | 'finalizer' | null;
  createdAt: string;
  startedAt: string | null;
  lastSentAt: string | null;
  /** Admin-only immutable dispatch identity; omitted from user task projections. */
  payloadHash?: string;
  /** Admin-only durable count of Backend sends for this task. */
  dispatchAttemptCount?: number;
  completedAt: string | null;
  /** Minimum guaranteed lookup horizon; referenced safety proofs may live longer. */
  retentionUntil: string | null;
}

/**
 * Requester-safe task progress. Raw requests, Agent outcomes and finalizer
 * evidence may contain host paths or privileged resource details and are only
 * present on the administrative task plane.
 */
export type UserAgentTaskErrorCode =
  | 'TASK_DISPATCH_FAILED'
  | 'TASK_EXECUTION_FAILED'
  | 'TASK_FINALIZATION_FAILED'
  | 'TASK_FAILED';

export interface UserAgentTaskDto {
  id: string;
  kind: AgentTaskKind;
  status: AgentTaskStatus;
  resourceType: string;
  resourceId: string;
  serverId: string;
  error: { code: UserAgentTaskErrorCode; message: string } | null;
  failureStage: 'dispatch' | 'agent' | 'finalizer' | null;
  createdAt: string;
  startedAt: string | null;
  lastSentAt: string | null;
  completedAt: string | null;
  retentionUntil: string | null;
}

export interface RuntimeDriftDto {
  kind: RuntimeDriftKind;
  message?: string;
  desired?: unknown;
  observed?: unknown;
}

export interface RuntimeStalenessDto {
  stale: boolean;
  observedAt: string | null;
  lastReportSeq?: number | null;
  missingSince?: string | null;
}

// ---------------------------------------------------------------------------
// Remote FS Mounts (system-level)
// ---------------------------------------------------------------------------

export type CephFsMountParamsDto = Omit<CephFsParams, 'secret'> & {
  secretConfigured: boolean;
};

export type RemoteFsMountParamsDto = NfsParams | CephFsMountParamsDto;

export interface RemoteFsMountDto {
  id: string;
  name: string;
  /** User-facing display name; falls back to name when not set */
  displayName?: string | null;
  description: string | null;
  type: RemoteFsParams['type'];
  options: string;
  hostMountPoint: string;
  params: RemoteFsMountParamsDto;
  createdAt: string;
  updatedAt: string;
  /** Server IDs this mount is assigned to */
  serverIds: string[];
  /** Live mount status per server, keyed by serverId; undefined if agent offline */
  serverStatuses?: Record<string, RemoteFsMountStatus>;
  taskIds?: string[];
}

export type MountSourceKind = 'local' | 'remote';

export interface MountSourceGrantDto {
  id: string;
  scope: 'user' | 'group';
  scopeId: string;
  sourceKind: MountSourceKind;
  sourceId: string;
  serverId: string | null;
  sourceIdentity: string | null;
  createdAt: string;
}

/** Returned by GET /mount-sources?serverId= — unified data-source picker */
export interface MountSourceDto {
  kind: MountSourceKind;
  id: string;
  serverId: string;
  /** Display label (e.g. "本地 · /data" or remote displayName/name) */
  label: string;
  /** Optional description for remote sources */
  description?: string;
}

// ---------------------------------------------------------------------------
// Container Mounts
// ---------------------------------------------------------------------------

export interface ContainerMountDto {
  id: string;
  serverId: string;
  containerId: string;
  containerName: string;
  sourceKind: 'local' | 'remote';
  sourceId: string;
  userId: string;
  dirName: string;
  containerPath: string;
}

export interface ContainerMountInputDto {
  sourceKind: 'local' | 'remote';
  sourceId: string;
  dirName: string;
  containerPath: string;
}

// ---------------------------------------------------------------------------
// Data Directories
// ---------------------------------------------------------------------------

export interface DataDirDto extends DataDirEntry {
  /** DB row id */
  id: string;
  /** User-facing name; stored only in Backend. */
  name: string;
  /** Owner user id (from DB, not filesystem) */
  userId: string;
  serverId: string;
  serverName: string;
  desiredState: 'creating' | 'active' | 'removing' | 'failed';
  generation: number;
  lastTaskId: string | null;
}

/** Ordinary-user projection: physical host paths remain Agent/admin internals. */
export type UserDataDirDto = Omit<DataDirDto, 'hostPath'>;

export interface DataDirIssueDto {
  kind: 'orphan' | 'missing';
  /** Filesystem entry (orphan) or DB-derived entry (missing) */
  entry: DataDirEntry & { name?: string; userId?: string };
  serverId: string;
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/** Current user's disk quota on a specific server */
export interface UserServerQuotaDto {
  /** XFS project used bytes (overlayfs + data dirs combined) */
  usedBytes: number;
  /** Grant limit in bytes; 0 = unlimited */
  limitBytes: number;
}

// ---------------------------------------------------------------------------
// Metrics — structured API
// ---------------------------------------------------------------------------

/** A single time-series: step in seconds, points ordered by time ascending */
export interface MetricSeries {
  step: number;
  points: Array<{ t: number /* unix seconds */; v: number | null }>;
}

export interface HostDiskCapacity {
  diskId: string;
  /** Purpose-safe label available on both ordinary and admin metrics planes. */
  displayName: string;
  /** Physical host path, present only on the ViewMetricsAll admin plane. */
  mountPoint?: string;
  used: MetricSeries;
  total: MetricSeries;
}

export interface HostDiskIo {
  /** Purpose-safe bounded series label; current telemetry aggregates devices. */
  label: string;
  /** Legacy optional field; bounded current telemetry does not emit device names. */
  dev?: string;
  /** read + write combined */
  bps: MetricSeries;
}

export interface HostNetIo {
  /** Purpose-safe bounded series label; current telemetry aggregates interfaces. */
  label: string;
  /** Legacy optional field; bounded current telemetry does not emit interface names. */
  iface?: string;
  /** rx + tx combined */
  bps: MetricSeries;
}

/** Response for GET /metrics/servers/:id/host */
export interface HostMetricsDto {
  cpu: MetricSeries;
  memUsed: MetricSeries;
  memTotal: MetricSeries;
  load1: MetricSeries;
  disks: HostDiskCapacity[];
  diskIo: HostDiskIo[];
  netIo: HostNetIo[];
}

export interface GpuMetrics {
  index: number;
  model: string;
  memTotalMiB: number;
  util: MetricSeries;
  memUsed: MetricSeries;
  temp: MetricSeries;
  power: MetricSeries;
  graphicsClockMHz: MetricSeries;
}

/** Response for GET /metrics/servers/:id/gpus */
export interface GpuMetricsDto {
  gpus: GpuMetrics[];
}

export interface UserMetrics {
  userId: string;
  username: string;
  displayName: string;
  cpu: MetricSeries;
  memUsed: MetricSeries;
  gpuMemUsed: MetricSeries;
  /** disk read + write combined */
  diskBps: MetricSeries;
  /** net rx + tx combined */
  netBps: MetricSeries;
  /** XFS project disk used bytes over time */
  diskUsed: MetricSeries;
}

/** Response for GET /metrics/servers/:id/users */
export interface UserMetricsDto {
  users: UserMetrics[];
}

export interface ContainerMetrics {
  containerId: string;
  name: string;
  ownerId: string;
  cpu: MetricSeries;
  memUsed: MetricSeries;
  gpuMemUsed: MetricSeries;
  /** disk read + write combined */
  diskBps: MetricSeries;
  /** net rx + tx combined */
  netBps: MetricSeries;
}

/** Response for GET /metrics/servers/:id/containers */
export interface ContainerMetricsDto {
  containers: ContainerMetrics[];
}
