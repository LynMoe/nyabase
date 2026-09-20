import {
  Capability,
  CertificateRotationStatus,
  CertificateState,
  CertificateTrustState,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  FailureCode,
  IntentKind,
  IntentResourceType,
  IntentStatus,
  PreflightStatus,
  ResourceLifecyclePhase,
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
import type { OpaqueExtensionMap } from './server-card-extensions.js';
import type { ConfigSourceName, ConfigValueKind } from '../config/definition.js';

export type {
  AddGroupMemberRequest,
  AddSshKeyRequest,
  AttachVolumeRequest,
  ConnectServerRequest,
  CreateApiTokenRequest,
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
  AdminIntentListQuery,
  ListSharedVolumesQuery,
  LocalVolumeScope,
  LoginRequest,
  NodeMetricsCreateConfig,
  NodeMetricsPatchConfig,
  PatchAdminGroupRequest,
  PatchContainerExtensionRequest,
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
  PatchServerExtensionRequest,
  PatchVolumeRequest,
  PreflightReport,
  PutImageAssignmentRequest,
  PutServerGrantRequest,
  PutSharedBackendGrantRequest,
  PutStoragePoolGrantRequest,
  RefreshTokenRequest,
  RetryIntentRequest,
  RotateIncusClientCertificateRequest,
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

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CursorPaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: UserDto;
}

export interface RefreshTokenResponse {
  accessToken: string;
  refreshToken: string;
}

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  status: UserStatus;
  createdAt: string;
  capabilities: Capability[];
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
  canRemoveMembers: Record<string, ActionAvailabilityDto>;
  canDelete: ActionAvailabilityDto;
}

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
  secret: string;
}

export interface PublicSettingsDto {
  branding: {
    title: string;
    description: string;
  };
  sshProxy: {
    host: string;
    port: number;
  } | null;
}

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
  editable: boolean;
  restartRequired: boolean;
  public: boolean;
  label: string;
  description: string;
}

export interface SystemSettingsDto {
  revision: number;
  snapshotToken: string;
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

export interface SshProxyHostKeySummaryDto {
  fingerprint: string | null;
  generation: number | null;
  rotatedAt: string | null;
}

export interface ServerDto {
  id: string;
  name: string;
  slug: string;
  apiEndpoint: string;
  serverCertFingerprint: string | null;
  incusVersion: string | null;
  apiExtensions: string[];
  systemPoolId: string | null;
  /** Human pool name for the server system disk pool; null when unset. */
  systemPoolName: string | null;
  storageOvercommitRatio: number;
  parentInterface: string;
  dnsServers: string[];
  enabledExtensions: string[];
  extensionHealth: Record<string, OpaqueExtensionMap>;
  status: ServerStatus;
  lastSeenAt: string | null;
  lastError: string | null;
  revision: number;
  preflightStatus: PreflightStatus;
  preflightCheckedAt: string | null;
  preflightReport: PreflightReport | null;
  nodeMetrics: NodeMetricsConfigDto;
  createdAt: string;
  updatedAt: string;
}

export interface UserServerDto {
  id: string;
  name: string;
  slug: string;
  status: ServerStatus;
  lastSeenAt: string | null;
  preflightStatus: PreflightStatus;
  enabledExtensions: string[];
}

export interface ServerConnectionDto {
  serverId: string;
  status: ServerStatus;
  incusVersion: string | null;
  apiExtensions: string[];
  serverCertFingerprint: string | null;
  connectedAt: string | null;
}

export interface NodeMetricsConfigDto {
  endpoint: string | null;
  serverCertFingerprint: string | null;
  tokenFingerprint: string | null;
  health: NodeMetricsHealthDto;
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
  generation: number;
  observedGeneration: number | null;
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
  generation: number;
  observedGeneration: number | null;
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
  name: string;
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
  generation: number;
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
  cpuMillis: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  extensionGrants: OpaqueExtensionMap;
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
  limitBytes: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GrantExpiryPhase = 'live' | 'grace' | 'lost';

export interface EffectiveServerAccessDto {
  serverId: string;
  cpuMillis: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  extensionGrants: OpaqueExtensionMap;
  expiresAt: string | null;
  purgeAt: string | null;
  accessPhase: 'live' | 'grace';
  allowedImageIds: string[];
}

export interface EffectiveSharedBackendAccessDto {
  sharedBackendId: string;
  /** null = unlimited (effectiveSharedGrant folds 0 into null). */
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
  proxyHost: string | null;
  proxyPort: number | null;
  hostKeyFingerprint: string | null;
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
  cpuMillis: number;
  memBytes: number;
  extensions: OpaqueExtensionMap;
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
  generation: number;
  observedGeneration: number | null;
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
  targetGeneration: number;
  status: IntentStatus.Pending;
  createdAt: string;
}

export interface IntentBatchAcceptedDto {
  intents: IntentAcceptedDto[];
}

export interface IntentDto {
  id: string;
  kind: IntentKind;
  resourceType: IntentResourceType;
  resourceId: string;
  serverId: string | null;
  requestedBy: string | null;
  requestSummary: Record<string, unknown>;
  targetGeneration: number;
  baseline: Record<string, unknown> | null;
  status: IntentStatus;
  failureCode: string | null;
  failure: IntentFailureDto | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  createdAt: string;
  settledAt: string | null;
  blockedByIntentId?: string | null;
}

export interface IncusClientCertificateDto {
  generation: number;
  fingerprint: string;
  notBefore: string;
  notAfter: string;
  state: CertificateState;
  servers: Array<{
    serverId: string;
    trustState: CertificateTrustState;
    observedAt: string | null;
    lastError: string | null;
  }>;
}

export interface CertificateRotationDto {
  rotationId: string;
  generation: number;
  status: CertificateRotationStatus;
  certificate: IncusClientCertificateDto;
  failureCode: string | null;
}

export interface MetricSeries {
  step: number;
  points: Array<{ t: number; v: number | null }>;
}

export interface HostDiskMetrics {
  deviceId: string;
  displayName: string;
  used: MetricSeries;
  total: MetricSeries;
  readBytes: MetricSeries;
  writeBytes: MetricSeries;
  readSeconds: MetricSeries;
  writeSeconds: MetricSeries;
  smartHealth: MetricSeries;
}

export interface HostMetricsDto {
  source: NodeMetricsHealthDto;
  cpu: MetricSeries;
  memoryUsed: MetricSeries;
  memoryTotal: MetricSeries;
  load1: MetricSeries;
  cpuPsi: Record<'some' | 'full', Record<'10' | '60' | '300', MetricSeries>>;
  disks: HostDiskMetrics[];
}

export interface UserMetrics {
  userId: string;
  username: string;
  displayName: string;
  cpu: MetricSeries;
  memoryUsed: MetricSeries;
  diskBytesPerSecond: MetricSeries;
  networkBytesPerSecond: MetricSeries;
}

export interface UserMetricsDto {
  users: UserMetrics[];
}

export interface ContainerMetrics {
  containerId: string;
  name: string;
  ownerId: string;
  cpu: MetricSeries;
  memoryUsed: MetricSeries;
  diskBytesPerSecond: MetricSeries;
  networkBytesPerSecond: MetricSeries;
}

export interface ContainerMetricsDto {
  containers: ContainerMetrics[];
}

export interface PhysicalResultSucceeded {
  kind: 'succeeded';
}

export interface PhysicalResultFailed {
  kind: 'failed';
  code: string;
  details: Record<string, unknown>;
}

export interface PhysicalResultRetry {
  kind: 'retry';
  code: string;
  details: Record<string, unknown>;
}

export type PhysicalResult = PhysicalResultSucceeded | PhysicalResultFailed | PhysicalResultRetry;

export interface ServerPreflightDto {
  status: PreflightStatus;
  report: PreflightReport | null;
  checkedAt: string | null;
}
