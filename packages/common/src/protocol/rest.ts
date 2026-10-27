import {
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  FailureCode,
  IntentKind,
  IntentResourceType,
  IntentStatus,
  PreflightStatus,
  ResourceLifecyclePhase,
  Role,
  ServerStatus,
  StoragePoolDriver,
  StoragePoolResizeFamily,
  UserStatus,
} from '../enums.js';
import type {
  LocalVolumeScope,
  NodeMetricsHealth,
  PreflightReport,
} from './rest-schema.js';
import type { GpuContainerState, GpuHealthDto } from '../gpu/dto.js';
import type { ConfigSourceName, ConfigValueKind } from '../config/definition.js';

export type {
  AddGroupMemberRequest,
  AddSshKeyRequest,
  AttachVolumeRequest,
  RotateServerEnrollmentRequest,
  CreateContainerRequest,
  CreateGroupRequest,
  AddCatalogImageRequest,
  CreateImageRequest,
  CreateIpPoolRequest,
  CreateServerRequest,
  CreateSharedBackendRequest,
  CreateUserRequest,
  CreateVolumeRequest,
  CreateSharedVolumeRequest,
  ErrorResponse,
  CreateExecSessionRequest,
  IntentListQuery,
  ListScope,
  ListSharedVolumesQuery,
  LocalVolumeScope,
  LoginRequest,
  PatchAdminGroupRequest,
  PatchContainerLimitsRequest,
  PatchContainerRootSizeRequest,
  PatchImageRequest,
  PatchIpPoolRequest,
  PatchServerRequest,
  PatchSharedBackendRequest,
  PatchSharedBackendExecutorRequest,
  PatchStoragePoolRequest,
  DiscoverSharedExecutorsRequest,
  PatchSystemSettingsRequest,
  PatchVolumeRequest,
  PreflightReport,
  PutImageAssignmentRequest,
  PutServerGrantRequest,
  PutSharedBackendGrantRequest,
  PutStoragePoolGrantRequest,
  RetryIntentRequest,
  RotateRefreshTokenRequest,
  RunPreflightRequest,
  ServerNetworkFields,
  SharedVolumeScope,
  UpdateGroupRequest,
  UpdateUserRequest,
  VolumeScope,
} from './rest-schema.js';

export interface ExecSessionResponse {
  sessionId: string;
  consoleUrl: string;
  expiresAt: string;
}

export interface CursorPaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
}

/** The refresh secret travels only in the HttpOnly `nyabase_refresh` cookie. */
export interface LoginResponse {
  accessToken: string;
  user: UserDto;
}

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  status: UserStatus;
  createdAt: string;
  role: Role;
  groups: GroupSummaryDto[];
}

export interface SshPublicKeyDto {
  id: string;
  name: string;
  keyText: string;
  createdAt: string;
}

export interface PublicSettingsDto {
  branding: {
    title: string;
    description: string;
  };
  sshProxy: {
    host: string;
    port: number;
    hostSuffix: string;
  } | null;
}

export interface GroupSummaryDto {
  id: string;
  name: string;
}

export interface GroupDto {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  serverIds?: string[];
  serverGrants?: ServerGrantDto[];
  storagePoolGrants?: StoragePoolGrantDto[];
  sharedBackendGrants?: SharedBackendGrantDto[];
  members?: GroupMemberDto[];
  memberCount?: number;
}

export interface GroupMemberDto {
  userId: string;
  username: string;
  displayName: string;
}

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
  /** Editable online: false when env-overridden. */
  editable: boolean;
  restartRequired: boolean;
  public: boolean;
  label: string;
  description: string;
}

export interface SystemSettingsDto {
  revision: number;
  configFile: string;
  fields: SystemSettingFieldDto[];
  editable: SystemSettingFieldDto[];
  readOnly: SystemSettingFieldDto[];
  publicSettings: PublicSettingsDto;
}

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

export interface OffsetPaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** The Backend's last SSH proxy snapshot build (`GET /admin/ssh-proxy/status`). */
export interface SshProxySnapshotSummaryDto {
  generation: number;
  builtAt: string | null;
  /** Encoded size against the hard cap; a build over the cap fails and the proxies keep the last one. */
  bytes: number;
  maxBytes: number;
  users: number;
  routes: number;
  /** Set when the most recent build failed; the counts above are from the last good build. */
  failedAt: string | null;
  error: string | null;
}

/** `GET /users/:id/ssh-client-config` (yourself only): reach every container as `<name>.<hostSuffix>`. */
export interface SshClientConfigDto {
  hostSuffix: string;
  /** Null until an administrator sets the SSH proxy's public address. */
  proxy: { host: string; port: number; hostKey: string } | null;
  /** Your host CA (`ssh-ed25519 …`); it signs only your containers' host keys. */
  hostCertificateAuthority: string;
  /** Ready to paste into ~/.ssh/config and ~/.ssh/known_hosts; null without a proxy address. */
  sshConfig: string | null;
  knownHosts: string | null;
}

export interface SshProxyHostKeySummaryDto {
  publicKey: string | null;
  fingerprint: string | null;
  generation: number | null;
  rotatedAt: string | null;
}

export interface ServerDto {
  id: string;
  name: string;
  slug: string;
  incusVersion: string | null;
  apiExtensions: string[];
  systemPoolId: string | null;
  /** Human pool name for the server system disk pool; null when unset. */
  systemPoolName: string | null;
  storageOvercommitRatio: number;
  parentInterface: string;
  dnsServers: string[];
  gpuEnabled: boolean;
  gpuHealth: GpuHealthDto;
  status: ServerStatus;
  lastSeenAt: string | null;
  lastError: string | null;
  revision: number;
  preflightStatus: PreflightStatus;
  preflightCheckedAt: string | null;
  preflightReport: PreflightReport | null;
  agent: ServerAgentDto;
  metricsHealth: NodeMetricsHealthDto;
  /** Logical CPUs no container is pinned to. */
  reservedCpus: number[];
  /** Logical CPU topology from the last inventory refresh; null until the agent reported it. */
  cpuTopology: ServerCpuDto[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServerAgentDto {
  /** True while the host agent holds its control connection. */
  connected: boolean;
  /** True once an agent exchanged an enrollment token for its credential. */
  enrolled: boolean;
  version: string | null;
  hostname: string | null;
  connectedAt: string | null;
  /** Expiry of the outstanding enrollment token, if one was issued and not yet used. */
  enrollmentExpiresAt: string | null;
  /** ipv6Guard, firewall (FirewallSyncState): live from the agent, null while disconnected; guests need both. */
  ipv6Guard: { present: boolean; error: string | null } | null;
  firewall: { state: 'synced' | 'pending' | 'failed'; error: string | null } | null;
}

export interface ServerCpuDto {
  id: number;
  core: number;
  socket: number;
  numa: number;
}

/** A one-time agent enrollment token; shown once, only its digest is stored. */
export interface ServerEnrollmentDto {
  enrollmentToken: string;
  expiresAt: string;
}

export interface CreatedServerDto extends ServerDto {
  enrollment: ServerEnrollmentDto;
}

export interface UserServerDto {
  id: string;
  name: string;
  slug: string;
  status: ServerStatus;
  lastSeenAt: string | null;
  preflightStatus: PreflightStatus;
  gpuEnabled: boolean;
}

export interface NodeMetricsHealthDto extends NodeMetricsHealth {}

export interface StoragePoolCapabilityDto {
  growOnline: boolean;
  shrinkOnline: boolean;
  shrinkRequiresStop: boolean;
  shrinkNever: boolean;
  enforceUsageFloor: boolean;
}

export interface StoragePoolDto {
  id: string;
  serverId: string;
  incusName: string;
  displayName: string | null;
  /** Incus config.source. Admin list/discover/PATCH only; user GET is always null. */
  source: string | null;
  driver: StoragePoolDriver;
  resizeFamily: StoragePoolResizeFamily;
  rootDiskCapable: boolean;
  shareable: boolean;
  blockFilesystem: string | null;
  sharedBackendId: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
  quotaEffective: boolean | null;
  registered: boolean;
  capability: StoragePoolCapabilityDto;
  lastObservedAt: string | null;
  revision: number;
}

export interface StorageCapacityPoolDto {
  poolId: string;
  displayName: string | null;
  driver: StoragePoolDriver;
  shareable: boolean;
  totalBytes: number | null;
  committedBytes: number;
  availableBytes: number | null;
  quotaEffective: boolean | null;
  overcommitRatio: number;
  capability: StoragePoolCapabilityDto;
}

export interface StorageCapacityDto {
  grantLimitBytes: number | null;
  usedByRootDisksBytes: number;
  usedByLocalVolumesBytes: number;
  availableBytes: number | null;
  pools: StorageCapacityPoolDto[];
}

export interface SharedBackendExecutorDto {
  id: string;
  backendId: string;
  serverId: string;
  serverName: string;
  serverStatus: ServerStatus;
  incusName: string;
  registered: boolean;
  totalBytes: number | null;
  usedBytes: number | null;
  lastObservedAt: string | null;
  revision: number;
}

export interface StorageDiscoverIssueDto {
  code:
    | typeof FailureCode.SharedBackendIdentityConflict
    | typeof FailureCode.StoragePoolInUse
    | typeof FailureCode.ServerUnreachable;
  message: string;
  identityKey: string | null;
  expectedFsid: string | null;
  discoveredFsid: string | null;
  existingIdentityKey: string | null;
  serverId: string | null;
  incusName: string | null;
  poolId: string | null;
}

export interface StoragePoolDiscoverResult {
  pools: StoragePoolDto[];
  identityConflicts: StorageDiscoverIssueDto[];
}

export interface SharedBackendExecutorDiscoverResult {
  executors: SharedBackendExecutorDto[];
  identityConflicts: StorageDiscoverIssueDto[];
}

export interface SharedBackendDto {
  id: string;
  name: string;
  displayName: string | null;
  /** Infrastructure details: empty (`''` / `[]` for serverIds) outside the admin view. */
  identityKey: string;
  cephFsid: string;
  totalBytes: number | null;
  usedBytes: number | null;
  overcommitRatio: number;
  serverIds: string[];
  /** True when any registered shareable cephfs pool's server is online. */
  hasOnlineExecutor: boolean;
  /** Admin GET list/get only; omit the key on user GET. */
  executors?: SharedBackendExecutorDto[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface IpPoolDto {
  id: string;
  name: string;
  /** LAN CIDR used for guest prefix and claim network_key. */
  cidr: string;
  /** Subnet inside cidr from which container addresses are allocated. */
  allocationCidr: string;
  gateway: string;
  reservedIps: string[];
  serverIds: string[];
  allocatedCount: number;
  usableCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type VolumeBindState = 'attaching' | 'attached' | 'detaching';

export interface VolumeDto {
  id: string;
  ownerId: string;
  poolId: string;
  /** displayName or Incus pool name; UI must not fall back to the pool UUID. */
  poolName: string;
  serverId: string;
  name: string;
  incusName: string;
  sizeBytes: number;
  usedBytes: number | null;
  scope: LocalVolumeScope;
  /** Pool capability descriptor; UI must not hardcode driver tables. */
  capability: StoragePoolCapabilityDto;
  lifecyclePhase: ResourceLifecyclePhase;
  revision: number;
  observedRevision: number | null;
  needsAttention: boolean;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  /** Current mounts; populated in list/get without per-row queries. */
  attachments: VolumeAttachmentSummaryDto[];
}

export interface SharedVolumeDto {
  id: string;
  ownerId: string;
  sharedBackendId: string;
  sharedBackendName: string;
  name: string;
  incusName: string;
  sizeBytes: number;
  usedBytes: number | null;
  capability: StoragePoolCapabilityDto;
  lifecyclePhase: ResourceLifecyclePhase;
  revision: number;
  observedRevision: number | null;
  needsAttention: boolean;
  failureCode: string | null;
  dirEnsured: boolean;
  createdAt: string;
  updatedAt: string;
  attachments: VolumeAttachmentSummaryDto[];
}

export type SharedVolumeCatalogOccupancy =
  | 'in_use'
  | 'cache'
  | 'ensuring'
  | 'dangling_incus'
  | 'dangling_pg'
  | 'unreachable';

export interface SharedVolumeCatalogInspectItemDto {
  serverId: string;
  serverName: string;
  serverStatus: ServerStatus;
  poolId: string | null;
  poolName: string | null;
  pgCatalogState: 'ensuring' | 'present' | 'absent';
  incusPresent: boolean | null;
  occupancy: SharedVolumeCatalogOccupancy;
}

export interface SharedVolumeCatalogInspectDto {
  volumeId: string;
  incusName: string;
  sharedBackendId: string;
  items: SharedVolumeCatalogInspectItemDto[];
}

export interface SharedBackendCatalogInspectItemDto {
  serverId: string;
  serverName: string;
  poolId: string;
  poolName: string;
  incusName: string;
  volumeId: string | null;
  occupancy: 'in_use' | 'cache' | 'dangling_incus';
}

export interface SharedBackendCatalogInspectDto {
  sharedBackendId: string;
  items: SharedBackendCatalogInspectItemDto[];
}

/** Compact mount row on VolumeDto; containerName is joined in one batch query. */
export interface VolumeAttachmentSummaryDto {
  attachmentId: string;
  containerId: string;
  containerName: string;
  containerPath: string;
  bindState: VolumeBindState;
}

export interface VolumeAttachmentDto {
  id: string;
  containerId: string;
  volumeId: string;
  volumeName: string;
  deviceName: string;
  containerPath: string;
  readOnly: boolean;
  bindState: VolumeBindState;
  kind: 'local' | 'shared';
  onlineCancelAllowed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ImageDto {
  id: string;
  alias: string;
  fingerprint: string | null;
  description: string | null;
  loginUser: string;
  minRootSizeBytes: number | null;
  networkManagedExternally: boolean;
  isActive: boolean;
  deleting: boolean;
  cleanupGeneration: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImageAssignmentDto {
  id: string;
  imageId: string;
  serverId: string;
  revision: number;
  observedFingerprint: string | null;
  managedFingerprint: string | null;
  lifecyclePhase: ResourceLifecyclePhase;
  needsAttention: boolean;
  failureCode: string | null;
  failureReason: string | null;
  lastObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminImageDto extends ImageDto {
  assignments: ImageAssignmentDto[];
}

export interface CatalogImageDto {
  alias: string;
  aliases: string[];
  fingerprint: string;
  os: string;
  release: string;
  variant: string;
  version: string;
  sizeBytes: number | null;
  description: string;
  added: boolean;
}

export interface ServerGrantDto {
  id: string;
  scope: 'group' | 'user';
  scopeId: string;
  serverId: string;
  /** Whole logical CPUs pinned for the user; null = every unreserved CPU. */
  cpuCores: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  /** PCI addresses the grant allows; empty means no GPU access. */
  gpuPciAddresses: string[];
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoragePoolGrantDto {
  id: string;
  scope: 'group' | 'user';
  scopeId: string;
  poolId: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SharedBackendGrantDto {
  id: string;
  scope: 'group' | 'user';
  scopeId: string;
  sharedBackendId: string;
  /** null = unlimited. */
  limitBytes: number | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GrantExpiryPhase = 'live' | 'grace' | 'lost';

/** Current coverage of a server: the merged quotas of the user's current grants. */
export interface LiveServerAccessDto {
  accessPhase: 'live';
  serverId: string;
  /** Pinned logical CPUs; null = all of the server's `serverCpuCores` (null until its topology is reported). */
  cpuCores: number | null;
  serverCpuCores: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  /** PCI addresses the grant allows; empty means no GPU access. */
  gpuPciAddresses: string[];
  expiresAt: string | null;
  allowedImageIds: string[];
}

/** Coverage lapsed; the user's resources are kept until `purgeAt`. No quotas apply. */
export interface GraceServerAccessDto {
  accessPhase: 'grace';
  serverId: string;
  /** When coverage lapsed (the grace started). */
  expiresAt: string;
  purgeAt: string;
}

export type EffectiveServerAccessDto = LiveServerAccessDto | GraceServerAccessDto;

export interface EffectiveSharedBackendAccessDto {
  sharedBackendId: string;
  /** null = unlimited. */
  limitBytes: number | null;
  /** Committed sum(size_bytes); 0 = nothing booked, not unlimited. */
  usedBytes: number;
  expiresAt: string | null;
}

export interface EffectiveAccessDto {
  servers: EffectiveServerAccessDto[];
  /** Live shared-backend grants only; grace backends are omitted. */
  sharedBackends: EffectiveSharedBackendAccessDto[];
}

export type ContainerAction = 'start' | 'stop' | 'restart' | 'delete' | 'stats' | 'console';

export type ActionBlockedReason =
  | 'phase_not_active'
  | 'intent_pending'
  | 'server_unreachable'
  | 'instance_missing'
  | 'permission_denied'
  | 'storage_capacity'
  | 'image_not_available';

export interface ActionAvailability {
  enabled: boolean;
  reason?: ActionBlockedReason;
  message?: string;
}

export interface ContainerActualDto {
  instanceName: string | null;
  status: ContainerStatus;
  routedIp: string | null;
  observedAt: string | null;
}

export interface ContainerSshDto {
  enabled: boolean;
  status: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown' | 'key_applied_sshd_missing';
  ready: boolean;
  loginUser: string;
  /** `<name>.<suffix>`: the SSH proxy resolves it among the owner's containers. */
  hostName: string;
  proxyHost: string | null;
  proxyPort: number | null;
  observedAt: string | null;
  lastError: string | null;
}

export interface ContainerDto {
  id: string;
  serverId: string;
  serverName: string;
  ownerId: string;
  ownerName?: string;
  name: string;
  instanceName: string | null;
  imageId: string;
  imageName?: string;
  imageFingerprint: string;
  rootPoolId: string;
  /** displayName or Incus pool name for the container root disk pool. */
  rootPoolName: string;
  rootSizeBytes: number;
  rootSizePendingBytes: number | null;
  rootUsedBytes: number | null;
  rootCapability: StoragePoolCapabilityDto;
  /** Logical CPUs the instance is pinned to as last applied; null until reconciled. */
  cpuSet: number[] | null;
  memBytes: number;
  /** NVIDIA runtime and assigned cards; null when GPU was never configured. */
  gpu: GpuContainerState | null;
  powerIntent: ContainerPowerIntent;
  lifecyclePhase: ContainerPhase;
  routedIp: string | null;
  actual: ContainerActualDto;
  ssh: ContainerSshDto;
  volumes: VolumeAttachmentDto[];
  sharedVolumes: VolumeAttachmentDto[];
  needsAttention: boolean;
  failureCode: string | null;
  failureReason: string | null;
  revision: number;
  observedRevision: number | null;
  actions: Record<ContainerAction, ActionAvailability>;
  createdAt: string;
  updatedAt: string;
}

export interface IntentFailureDto {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface IntentAcceptedDto {
  intentId: string;
  resourceType: IntentResourceType;
  resourceId: string;
  serverId: string | null;
  targetRevision: number;
  status: IntentStatus.Pending;
  createdAt: string;
}

export interface IntentDto {
  id: string;
  kind: IntentKind;
  resourceType: IntentResourceType;
  resourceId: string;
  serverId: string | null;
  requestedBy: string | null;
  requestSummary: Record<string, unknown>;
  targetRevision: number;
  baseline: Record<string, unknown> | null;
  status: IntentStatus;
  failureCode: string | null;
  failure: IntentFailureDto | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface ServerPreflightDto {
  status: PreflightStatus;
  report: PreflightReport | null;
  checkedAt: string | null;
}
