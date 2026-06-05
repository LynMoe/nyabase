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
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  OperationKind,
  OperationStatus,
  HookKind,
  HookStatus,
  RuntimeDriftKind,
} from '../enums.js';
import type {
  ContainerStatsSummary,
  ContainerSshServerStatus,
  DiskInfo,
  GpuInfo,
  DataDirEntry,
  DockerDaemonStatus,
  RemoteFsParams,
  RemoteFsMountStatus,
} from './agent-messages.js';
import type { ImageRuntimeOverrides } from './rest-schema.js';

// Re-export all inferred request types from the Zod schema module so consumers
// can keep importing them from this barrel.
export type {
  LoginRequest,
  RefreshTokenRequest,
  CreateApiTokenRequest,
  CreateUserRequest,
  UpdateUserRequest,
  AddSshKeyRequest,
  CreateServerRequest,
  UpdateServerRequest,
  UpdateServerDefaultsRequest,
  AddDataDiskRequest,
  UpdateDataDiskRequest,
  ImageRuntimeOverrides,
  CreateImageRequest,
  UpdateImageRequest,
  PullImageRequest,
  CreateContainerRequest,
  ExecSessionRequest,
  CreateDataDirRequest,
  CreateGroupRequest,
  UpdateGroupRequest,
  UpsertServerGrantRequest,
  AddGroupMemberRequest,
  AddImageGrantRequest,
  SyncImageGrantServersRequest,
} from './rest-schema.js';

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
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
// Servers
// ---------------------------------------------------------------------------

export interface ServerDto {
  id: string;
  name: string;
  parentIface: string;
  ipCidr: string;
  gateway: string;
  isGpuServer: boolean;
  status: ServerStatus;
  lastSeenAt: string | null;
  /** Default resource limits applied when a grant leaves fields null */
  defaultCpuMillis: number;
  defaultMemBytes: number;
  defaultDiskBytes: number;
  defaultGpuMode: GpuGrantMode;
  defaultGpuIndices: number[];
  /** Latest persisted/runtime-reported host disk observations */
  disks?: DiskInfo[];
  gpus?: GpuInfo[];
  agentVersion?: string;
  /** Frozen on first agent hello; never changes after that */
  dockerRoot?: string | null;
  dockerSocket?: string | null;
  /** Latest persisted/runtime-reported docker daemon status */
  dockerDaemon?: DockerDaemonStatus | null;
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
  label?: string;
  totalBytes: number;
  usedBytes: number;
  pquotaEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ImageDto {
  id: string;
  name: string;
  dockerImage: string;
  runtimeOverrides: ImageRuntimeOverrides;
  /** @deprecated use runtimeOverrides.uid */
  defaultUid: number;
  description: string | null;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export interface ServerGrantDto {
  id: string;
  scope: 'group' | 'user';
  scopeId: string;
  serverId: string;
  /** null → fall back to server default */
  cpuMillis: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  /** null → fall back to server default */
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
  | 'enableSsh'
  | 'reconcileSsh';

export type ActionBlockedReason =
  | 'container_unbound'
  | 'phase_not_active'
  | 'operation_in_progress'
  | 'agent_offline'
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
  operationId?: string;
}

export interface ContainerRuntimeView {
  bound: boolean;
  runtimeId: string | null;
  status: ContainerStatus | null;
  ip?: string | null;
  observedAt: string | null;
  stale: boolean;
  drift: RuntimeDriftDto[];
}

export interface ContainerSshView {
  enabled: boolean;
  status: ContainerSshServerStatus;
  user?: 'root';
  port?: 22;
  lastError?: string;
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
  phase: ContainerPhase;
  failureCode?: string | null;
  failureReason?: string | null;
  powerIntent: ContainerPowerIntent;
  runtime: ContainerRuntimeView;
  activeOperation: OperationSummaryDto | null;
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
  phase?: ContainerPhase;
  activeOperationId?: string | null;
  message: string;
}

export interface ContainerStatsResponse {
  containerId: string;
  stats: ContainerStatsSummary | null;
  ts: number;
  lastObservedAt?: string;
}

export interface OperationRefResponse {
  ok: true;
  operationId: string;
  status: OperationStatus;
}

export interface OperationSummaryDto {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  resourceType: string;
  resourceId: string;
  serverId: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface HookSummaryDto {
  hook: HookKind;
  status: HookStatus;
  desiredGeneration: number | null;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
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

export interface RemoteFsMountDto {
  id: string;
  name: string;
  /** User-facing display name; falls back to name when not set */
  displayName?: string | null;
  description: string | null;
  type: RemoteFsParams['type'];
  options: string;
  hostMountPoint: string;
  params: RemoteFsParams;
  createdAt: string;
  updatedAt: string;
  /** Server IDs this mount is assigned to */
  serverIds: string[];
  /** Live mount status per server, keyed by serverId; undefined if agent offline */
  serverStatuses?: Record<string, RemoteFsMountStatus>;
}

export interface CreateRemoteFsMountRequest {
  name: string;
  /** User-facing display name */
  displayName?: string;
  description?: string;
  /** Optional: immediately assign to these servers after creation */
  serverIds?: string[];
  type: RemoteFsParams['type'];
  options?: string;
  hostMountPoint?: string;
  params: RemoteFsParams;
}

export interface UpdateRemoteFsMountRequest {
  name?: string;
  /** User-facing display name */
  displayName?: string;
  description?: string;
  options?: string;
  hostMountPoint?: string;
  params?: RemoteFsParams;
}

export type MountSourceKind = 'local' | 'remote';

export interface MountSourceGrantDto {
  id: string;
  scope: 'user' | 'group';
  scopeId: string;
  sourceKind: MountSourceKind;
  sourceId: string;
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
  /** mountPoint for local, hostMountPoint for remote */
  hostRoot: string;
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
  createIfMissing?: boolean;
}

// ---------------------------------------------------------------------------
// Data Directories
// ---------------------------------------------------------------------------

export interface DataDirDto extends DataDirEntry {
  /** DB row id */
  id: string;
  /** Owner user id (from DB, not filesystem) */
  userId: string;
  serverId: string;
  serverName: string;
}

export interface DataDirIssueDto {
  kind: 'orphan' | 'missing';
  /** Filesystem entry (orphan) or DB-derived entry (missing) */
  entry: DataDirEntry & { userId?: string };
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
  mountPoint: string;
  used: MetricSeries;
  total: MetricSeries;
}

export interface HostDiskIo {
  dev: string;
  /** read + write combined */
  bps: MetricSeries;
}

export interface HostNetIo {
  iface: string;
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
