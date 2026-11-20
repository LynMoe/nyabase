export enum UserStatus {
  Active = 'active',
  Disabled = 'disabled',
  Deleting = 'deleting',
  Deleted = 'deleted',
}

export enum ServerStatus {
  Online = 'online',
  Unreachable = 'unreachable',
  Unknown = 'unknown',
}

export enum ContainerStatus {
  Creating = 'creating',
  Running = 'running',
  Stopped = 'stopped',
  Frozen = 'frozen',
  Error = 'error',
  Unknown = 'unknown',
}

export enum ContainerPhase {
  Provisioning = 'provisioning',
  Active = 'active',
  Deleting = 'deleting',
  Failed = 'failed',
}

export enum ContainerPowerIntent {
  Running = 'running',
  Stopped = 'stopped',
}

export enum IntentStatus {
  Pending = 'pending',
  Succeeded = 'succeeded',
  Failed = 'failed',
}

export enum IntentResourceType {
  Container = 'container',
  Volume = 'volume',
  ImageAssignment = 'image_assignment',
  Server = 'server',
}

export enum IntentKind {
  ContainerCreate = 'container.create',
  ContainerUpdate = 'container.update',
  ContainerPower = 'container.power',
  ContainerDelete = 'container.delete',
  VolumeEnsure = 'volume.ensure',
  VolumeResize = 'volume.resize',
  VolumeDestroy = 'volume.destroy',
  ImageAssignmentEnsure = 'image_assignment.ensure',
  ImageAssignmentDelete = 'image_assignment.delete',
  ServerPreflight = 'server.preflight',
}

export enum StoragePoolDriver {
  Dir = 'dir',
  Btrfs = 'btrfs',
  Zfs = 'zfs',
  Lvm = 'lvm',
  LvmCluster = 'lvmcluster',
  Ceph = 'ceph',
  CephFs = 'cephfs',
}

export enum StoragePoolResizeFamily {
  QuotaOnline = 'quota_online',
  BlockBacked = 'block_backed',
}

/** How a server picks the system pool for a new container's root disk. */
export enum RootPlacement {
  /** At most one system pool; every new root disk goes there. */
  Single = 'single',
  /** A weighted random system pool (optionally sticky per user). */
  Random = 'random',
}

/** Why a system pool could not take a new root disk. */
export enum RootPlacementExclusion {
  QuotaIneffective = 'quota_ineffective',
  AboveWatermark = 'above_watermark',
  Capacity = 'capacity',
}

export enum ResourceLifecyclePhase {
  Provisioning = 'provisioning',
  Active = 'active',
  Deleting = 'deleting',
  Failed = 'failed',
}

export enum NodeMetricsStatus {
  Online = 'online',
  Unreachable = 'unreachable',
  Unknown = 'unknown',
}

export enum NodeMetricName {
  CpuUsageRatio = 'nyabase_node_cpu_usage_ratio',
  CpuPsiRatio = 'nyabase_node_cpu_psi_ratio',
  DiskIoReadBytesTotal = 'nyabase_node_disk_io_read_bytes_total',
  DiskIoWriteBytesTotal = 'nyabase_node_disk_io_write_bytes_total',
  DiskIoReadSecondsTotal = 'nyabase_node_disk_io_read_seconds_total',
  DiskIoWriteSecondsTotal = 'nyabase_node_disk_io_write_seconds_total',
  DiskSmartHealth = 'nyabase_node_disk_smart_health',
  NetworkForwarding = 'nyabase_node_network_forwarding',
  NetworkRpFilter = 'nyabase_node_network_rp_filter',
  NetworkFibRulePresent = 'nyabase_node_network_fib_rule_present',
  NetworkIsBridge = 'nyabase_node_network_is_bridge',
  NetworkIpv4Present = 'nyabase_node_network_ipv4_present',
  NetworkBridgeSlave = 'nyabase_node_network_bridge_slave',
  NetworkNftAvailable = 'nyabase_node_network_nft_available',
  NetworkBridgeFilterPresent = 'nyabase_node_network_bridge_filter_present',
  NetworkBridgeFilterAddress = 'nyabase_node_network_bridge_filter_address',
  Ipv6GuardPresent = 'nyabase_node_ipv6_guard_present',
  FirewallPresent = 'nyabase_node_firewall_present',
}

export enum PreflightStatus {
  NotRun = 'not_run',
  Running = 'running',
  Passed = 'passed',
  Failed = 'failed',
}

/**
 * Platform roles, strictly nested: admin ⊇ user_admin ⊇ user. A user admin
 * administers people and their resources (users, bundles, grants, every
 * container and volume); infrastructure and system settings are admin-only.
 */
export enum Role {
  User = 'user',
  UserAdmin = 'user_admin',
  Admin = 'admin',
}

const ROLE_RANK: Record<Role, number> = { [Role.User]: 0, [Role.UserAdmin]: 1, [Role.Admin]: 2 };

/** True when `role` is `minimum` or a role above it. */
export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export enum FailureCode {
  RevisionConflict = 'REVISION_CONFLICT',
  /** A concurrent write kept the request's transaction from committing; retry it. */
  TransactionConflict = 'TRANSACTION_CONFLICT',
  StorageGrantExceeded = 'STORAGE_GRANT_EXCEEDED',
  /** The user already holds a bundle on the server; resend with `replace: true` to swap it. */
  ServerGrantExists = 'SERVER_GRANT_EXISTS',
  /** The mount path collides with (equals or nests in) another disk's mount path. */
  StorageMountPathConflict = 'STORAGE_MOUNT_PATH_CONFLICT',
  /** The pool cannot be a data disk (not a registered local pool with an effective online quota). */
  StorageMountUnsupported = 'STORAGE_MOUNT_UNSUPPORTED',
  /** The pool cannot be a system disk (not a registered, root-capable local pool). */
  SystemDiskUnsupported = 'SYSTEM_DISK_UNSUPPORTED',
  /** Single root placement needs at most one system pool; turn the others off first. */
  SystemDiskNotSingle = 'SYSTEM_DISK_NOT_SINGLE',
  GrantBundleConflict = 'GRANT_BUNDLE_CONFLICT',
  GrantBundleInUse = 'GRANT_BUNDLE_IN_USE',
  MemoryGrantExceeded = 'MEMORY_GRANT_EXCEEDED',
  StoragePoolExhausted = 'STORAGE_POOL_EXHAUSTED',
  StoragePoolQuotaIneffective = 'STORAGE_POOL_QUOTA_INEFFECTIVE',
  StoragePoolInUse = 'STORAGE_POOL_IN_USE',
  NetworkAddressExhausted = 'NETWORK_ADDRESS_EXHAUSTED',
  IpPoolNotConfigured = 'IP_POOL_NOT_CONFIGURED',
  IpPoolInUse = 'IP_POOL_IN_USE',
  IpPoolCidrConflict = 'IP_POOL_CIDR_CONFLICT',
  FirewallRuleConflict = 'FIREWALL_RULE_CONFLICT',
  FirewallTooLarge = 'FIREWALL_TOO_LARGE',
  /** Another container script already has this name or priority. */
  ContainerScriptConflict = 'CONTAINER_SCRIPT_CONFLICT',
  /** The container script is archived and takes no more versions or runs. */
  ContainerScriptArchived = 'CONTAINER_SCRIPT_ARCHIVED',
  /** A file of the version names content that was never uploaded. */
  ContainerScriptBlobMissing = 'CONTAINER_SCRIPT_BLOB_MISSING',
  /** The upload or the version's files exceed the size limits. */
  ContainerScriptTooLarge = 'CONTAINER_SCRIPT_TOO_LARGE',
  SshProxyLineConflict = 'SSH_PROXY_LINE_CONFLICT',
  SharedBackendQuotaExceeded = 'SHARED_BACKEND_QUOTA_EXCEEDED',
  SharedBackendVolumeLimitReached = 'SHARED_BACKEND_VOLUME_LIMIT_REACHED',
  SharedBackendInUse = 'SHARED_BACKEND_IN_USE',
  SharedBackendIdentityConflict = 'SHARED_BACKEND_IDENTITY_CONFLICT',
  VolumeShrinkBelowUsage = 'VOLUME_SHRINK_BELOW_USAGE',
  VolumeShrinkRequiresDetach = 'VOLUME_SHRINK_REQUIRES_DETACH',
  VolumeShrinkUnsupported = 'VOLUME_SHRINK_UNSUPPORTED',
  VolumeUsageUnknown = 'VOLUME_USAGE_UNKNOWN',
  VolumeRequiresUnbind = 'VOLUME_REQUIRES_UNBIND',
  /** A grant still covers the volume's disk (it would only be created again): revoke it first. */
  VolumeStillGranted = 'VOLUME_STILL_GRANTED',
  VolumeDeleteBackendUnreachable = 'VOLUME_DELETE_BACKEND_UNREACHABLE',
  VolumeDetachRequiresStop = 'VOLUME_DETACH_REQUIRES_STOP',
  VolumeCrossServerDenied = 'VOLUME_CROSS_SERVER_DENIED',
  RootShrinkBelowUsage = 'ROOT_SHRINK_BELOW_USAGE',
  RootShrinkRequiresStop = 'ROOT_SHRINK_REQUIRES_STOP',
  RootQuotaPending = 'ROOT_QUOTA_PENDING',
  RootSizeBelowImageMinimum = 'ROOT_SIZE_BELOW_IMAGE_MINIMUM',
  RootUsageUnknown = 'ROOT_USAGE_UNKNOWN',
  GpuNotEnabled = 'GPU_NOT_ENABLED',
  GpuOccupied = 'GPU_OCCUPIED',
  GpuMutationRequiresStop = 'GPU_MUTATION_REQUIRES_STOP',
  GpuGrantNotApplicable = 'GPU_GRANT_NOT_APPLICABLE',
  GpuRuntimeUnavailable = 'GPU_RUNTIME_UNAVAILABLE',
  GpuInvalidPci = 'GPU_INVALID_PCI',
  GpuWildcardForbidden = 'GPU_WILDCARD_FORBIDDEN',
  GpuDuplicatePci = 'GPU_DUPLICATE_PCI',
  GpuNotGranted = 'GPU_NOT_GRANTED',
  VolumeCatalogAdoptFailed = 'VOLUME_CATALOG_ADOPT_FAILED',
  VolumePlacementFailed = 'VOLUME_PLACEMENT_FAILED',
  ImageManagesOwnNetwork = 'IMAGE_MANAGES_OWN_NETWORK',
  ImageNotAvailable = 'IMAGE_NOT_AVAILABLE',
  ImageAssignmentFingerprintMismatch = 'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH',
  ImageInUse = 'IMAGE_IN_USE',
  ServerUnreachable = 'SERVER_UNREACHABLE',
  ServerAlreadyConnected = 'SERVER_ALREADY_CONNECTED',
  TrustTokenExpired = 'TRUST_TOKEN_EXPIRED',
  InstanceBusy = 'INSTANCE_BUSY',
  PreflightCleanupFailed = 'PREFLIGHT_CLEANUP_FAILED',
  PreflightFailed = 'PREFLIGHT_FAILED',
  PermissionDenied = 'PERMISSION_DENIED',
  CurrentPasswordIncorrect = 'CURRENT_PASSWORD_INCORRECT',
  NotFound = 'NOT_FOUND',
  InvalidInput = 'INVALID_INPUT',
  InternalError = 'INTERNAL_ERROR',
}

export enum AuditAction {
  CreateContainer = 'container.create',
  StartContainer = 'container.start',
  StopContainer = 'container.stop',
  RestartContainer = 'container.restart',
  DeleteContainer = 'container.delete',
  RenameContainer = 'container.rename',
  UpdateContainerLimits = 'container.limits.update',
  ResizeContainerRoot = 'container.root_size.update',
  UpdateContainerGpu = 'container.gpu.update',
  AttachVolume = 'container.volume.attach',
  DetachVolume = 'container.volume.detach',
  CreateExecSession = 'container.exec_session.create',
  CreateServer = 'server.create',
  UpdateServer = 'server.update',
  UpdateServerGpu = 'server.gpu.update',
  DeleteServer = 'server.delete',
  IssueAgentEnrollment = 'server.agent_enrollment.issue',
  EnrollAgent = 'server.agent.enroll',
  RunServerPreflight = 'server.preflight',
  RegisterStoragePool = 'storage_pool.register',
  UpdateStoragePool = 'storage_pool.update',
  DiscoverStoragePools = 'storage_pool.discover',
  CreateIpPool = 'ip_pool.create',
  UpdateIpPool = 'ip_pool.update',
  DeleteIpPool = 'ip_pool.delete',
  CreateFirewallRule = 'firewall_rule.create',
  UpdateFirewallRule = 'firewall_rule.update',
  DeleteFirewallRule = 'firewall_rule.delete',
  CreateContainerScript = 'container_script.create',
  PublishContainerScript = 'container_script.publish',
  UpdateContainerScript = 'container_script.update',
  PauseContainerScript = 'container_script.pause',
  ResumeContainerScript = 'container_script.resume',
  ArchiveContainerScript = 'container_script.archive',
  RetryContainerScript = 'container_script.retry',
  /** The system paused a script: its canary finished or too many runs of a version failed. */
  AutoPauseContainerScript = 'container_script.auto_pause',
  CreateSharedBackend = 'shared_backend.create',
  UpdateSharedBackend = 'shared_backend.update',
  DeleteSharedBackend = 'shared_backend.delete',
  UpdateSharedBackendExecutor = 'shared_backend.executor.update',
  DiscoverSharedBackendExecutors = 'shared_backend.executor.discover',
  CreateVolume = 'volume.create',
  UpdateVolume = 'volume.update',
  DeleteVolume = 'volume.delete',
  EnsureVolume = 'volume.ensure',
  ResizeVolume = 'volume.resize',
  CreateImage = 'image.create',
  UpdateImage = 'image.update',
  DeleteImage = 'image.delete',
  DeleteImageVersion = 'image.version.delete',
  EnsureImageAssignment = 'image_assignment.ensure',
  DeleteImageAssignment = 'image_assignment.delete',
  CreateGrantBundle = 'grant_bundle.create',
  UpdateGrantBundle = 'grant_bundle.update',
  DeleteGrantBundle = 'grant_bundle.delete',
  UpsertServerGrant = 'grant.server.upsert',
  DeleteServerGrant = 'grant.server.delete',
  /** Before 000012: one data-disk quota per pool (kept for the audit history). */
  UpsertStoragePoolGrant = 'grant.storage_pool.upsert',
  DeleteStoragePoolGrant = 'grant.storage_pool.delete',
  /** Data-disk grants before 000014 (data disks are part of bundles now); kept for old audit rows. */
  CreateDataDiskGrant = 'grant.data_disk.create',
  UpdateDataDiskGrant = 'grant.data_disk.update',
  DeleteDataDiskGrant = 'grant.data_disk.delete',
  UpsertSharedBackendGrant = 'grant.shared_backend.upsert',
  DeleteSharedBackendGrant = 'grant.shared_backend.delete',
  GrantExpired = 'grant.expired',
  ExpiryStopContainers = 'grant.expiry.stop_containers',
  ExpiryDetachVolumes = 'grant.expiry.detach_volumes',
  ExpiryPurgeResources = 'grant.expiry.purge_resources',
  IncusMutate = 'incus.mutate',
  ContainerDriftCorrected = 'container.drift_corrected',
  RetryIntent = 'intent.retry',
  UpdateSystemSettings = 'system_settings.update',
  CreateUser = 'user.create',
  UpdateUser = 'user.update',
  ChangeUserRole = 'user.role_changed',
  DeleteUser = 'user.delete',
  AddUserSshPublicKey = 'user.ssh_public_key.add',
  DeleteUserSshPublicKey = 'user.ssh_public_key.delete',
  UserLogin = 'user.login',
  UserLogout = 'user.logout',
  /** A rotated-out refresh token was presented again; its session was revoked. */
  RefreshTokenReuse = 'user.refresh_token_reuse',
  CreateHttpProxyBinding = 'http_proxy.binding.create',
  UpdateHttpProxyBinding = 'http_proxy.binding.update',
  DeleteHttpProxyBinding = 'http_proxy.binding.delete',
  CreateHttpDomainPool = 'http_proxy.domain_pool.create',
  UpdateHttpDomainPool = 'http_proxy.domain_pool.update',
  DeleteHttpDomainPool = 'http_proxy.domain_pool.delete',
  DisconnectSshProxySessions = 'ssh_proxy.sessions.disconnect_all',
  RotateSshProxyHostKey = 'ssh_proxy.host_key.rotate',
  ResetSshHostAuthorities = 'ssh_proxy.host_authorities.reset',
  CreateSshProxyLine = 'ssh_proxy.line.create',
  UpdateSshProxyLine = 'ssh_proxy.line.update',
  DeleteSshProxyLine = 'ssh_proxy.line.delete',
  ReorderSshProxyLines = 'ssh_proxy.line.reorder',
}
