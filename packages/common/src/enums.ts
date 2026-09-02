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
  CertificateRotation = 'certificate_rotation',
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
  ServerConnect = 'server.connect',
  ServerPreflight = 'server.preflight',
  CertificateRotate = 'certificate.rotate',
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

export enum ResourceLifecyclePhase {
  Provisioning = 'provisioning',
  Active = 'active',
  Deleting = 'deleting',
  Failed = 'failed',
}

export enum NodeMetricsStatus {
  Unconfigured = 'unconfigured',
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
}

export enum PreflightStatus {
  NotRun = 'not_run',
  Running = 'running',
  Passed = 'passed',
  Failed = 'failed',
}

export enum CertificateState {
  Staged = 'staged',
  Active = 'active',
  Retired = 'retired',
  Failed = 'failed',
}

export enum CertificateTrustState {
  Pending = 'pending',
  Trusted = 'trusted',
  Verified = 'verified',
  Revoked = 'revoked',
  CleanupFailed = 'cleanup_failed',
}

export enum CertificateRotationStatus {
  Pending = 'pending',
  Succeeded = 'succeeded',
  Failed = 'failed',
}

export enum Capability {
  ManageUsers = 'manage_users',
  ManageGroups = 'manage_groups',
  ManageServers = 'manage_servers',
  ManageImages = 'manage_images',
  ManageStoragePools = 'manage_storage_pools',
  ManageIpPools = 'manage_ip_pools',
  ManageSharedBackends = 'manage_shared_backends',
  ManageVolumes = 'manage_volumes',
  ManageSharedVolumes = 'manage_shared_volumes',
  ManageGrants = 'manage_grants',
  ManageContainersAny = 'manage_containers_any',
  ManagePreflight = 'manage_preflight',
  ManageCertificates = 'manage_certificates',
  ViewAudit = 'view_audit',
  ViewMetricsAll = 'view_metrics_all',
  ManageSystemSettings = 'manage_system_settings',
}

export enum SystemGroupKey {
  Administrators = 'administrators',
  Operators = 'operators',
  Users = 'users',
}

export enum FailureCode {
  RevisionConflict = 'REVISION_CONFLICT',
  StorageGrantExceeded = 'STORAGE_GRANT_EXCEEDED',
  StoragePoolExhausted = 'STORAGE_POOL_EXHAUSTED',
  StoragePoolQuotaIneffective = 'STORAGE_POOL_QUOTA_INEFFECTIVE',
  StoragePoolInUse = 'STORAGE_POOL_IN_USE',
  NetworkAddressExhausted = 'NETWORK_ADDRESS_EXHAUSTED',
  IpPoolNotConfigured = 'IP_POOL_NOT_CONFIGURED',
  IpPoolInUse = 'IP_POOL_IN_USE',
  IpPoolCidrConflict = 'IP_POOL_CIDR_CONFLICT',
  SharedBackendQuotaExceeded = 'SHARED_BACKEND_QUOTA_EXCEEDED',
  SharedBackendInUse = 'SHARED_BACKEND_IN_USE',
  SharedBackendIdentityConflict = 'SHARED_BACKEND_IDENTITY_CONFLICT',
  VolumeShrinkBelowUsage = 'VOLUME_SHRINK_BELOW_USAGE',
  VolumeShrinkRequiresDetach = 'VOLUME_SHRINK_REQUIRES_DETACH',
  VolumeShrinkUnsupported = 'VOLUME_SHRINK_UNSUPPORTED',
  VolumeRequiresUnbind = 'VOLUME_REQUIRES_UNBIND',
  VolumeDeleteBackendUnreachable = 'VOLUME_DELETE_BACKEND_UNREACHABLE',
  VolumeDetachRequiresStop = 'VOLUME_DETACH_REQUIRES_STOP',
  VolumeCrossServerDenied = 'VOLUME_CROSS_SERVER_DENIED',
  RootShrinkBelowUsage = 'ROOT_SHRINK_BELOW_USAGE',
  RootShrinkRequiresStop = 'ROOT_SHRINK_REQUIRES_STOP',
  RootQuotaPending = 'ROOT_QUOTA_PENDING',
  RootSizeBelowImageMinimum = 'ROOT_SIZE_BELOW_IMAGE_MINIMUM',
  ExtensionUnknown = 'EXTENSION_UNKNOWN',
  ExtensionNotEnabled = 'EXTENSION_NOT_ENABLED',
  ExtensionOccupied = 'EXTENSION_OCCUPIED',
  ExtensionDeviceClaimed = 'EXTENSION_DEVICE_CLAIMED',
  ExtensionMutationRequiresStop = 'EXTENSION_MUTATION_REQUIRES_STOP',
  ExtensionGrantNotApplicable = 'EXTENSION_GRANT_NOT_APPLICABLE',
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
  GrantRevocationBlocked = 'GRANT_REVOCATION_BLOCKED',
  PermissionDenied = 'PERMISSION_DENIED',
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
  UpdateContainerLimits = 'container.limits.update',
  ResizeContainerRoot = 'container.root_size.update',
  UpdateContainerExtension = 'container.extension.update',
  AttachVolume = 'container.volume.attach',
  DetachVolume = 'container.volume.detach',
  CreateExecSession = 'container.exec_session.create',
  CreateServer = 'server.create',
  UpdateServer = 'server.update',
  UpdateServerExtension = 'server.extension.update',
  DeleteServer = 'server.delete',
  ConnectServer = 'server.connect',
  RunServerPreflight = 'server.preflight',
  RegisterStoragePool = 'storage_pool.register',
  CreateIpPool = 'ip_pool.create',
  UpdateIpPool = 'ip_pool.update',
  DeleteIpPool = 'ip_pool.delete',
  CreateSharedBackend = 'shared_backend.create',
  UpdateSharedBackend = 'shared_backend.update',
  DeleteSharedBackend = 'shared_backend.delete',
  CreateVolume = 'volume.create',
  UpdateVolume = 'volume.update',
  DeleteVolume = 'volume.delete',
  EnsureVolume = 'volume.ensure',
  ResizeVolume = 'volume.resize',
  CreateImage = 'image.create',
  UpdateImage = 'image.update',
  DeleteImage = 'image.delete',
  EnsureImageAssignment = 'image_assignment.ensure',
  DeleteImageAssignment = 'image_assignment.delete',
  UpsertServerGrant = 'grant.server.upsert',
  DeleteServerGrant = 'grant.server.delete',
  UpsertStoragePoolGrant = 'grant.storage_pool.upsert',
  DeleteStoragePoolGrant = 'grant.storage_pool.delete',
  UpsertSharedBackendGrant = 'grant.shared_backend.upsert',
  DeleteSharedBackendGrant = 'grant.shared_backend.delete',
  GrantExpired = 'grant.expired',
  ExpiryStopContainers = 'grant.expiry.stop_containers',
  ExpiryPurgeResources = 'grant.expiry.purge_resources',
  RotateIncusClientCertificate = 'certificate.rotate',
  IncusMutate = 'incus.mutate',
  UpdateSystemSettings = 'system_settings.update',
  CreateUser = 'user.create',
  UpdateUser = 'user.update',
  DeleteUser = 'user.delete',
  AddUserSshPublicKey = 'user.ssh_public_key.add',
  DeleteUserSshPublicKey = 'user.ssh_public_key.delete',
  CreateGroup = 'group.create',
  UpdateGroup = 'group.update',
  DeleteGroup = 'group.delete',
  AddGroupMember = 'group.member.add',
  RemoveGroupMember = 'group.member.remove',
  UserLogin = 'user.login',
  UserLogout = 'user.logout',
  CreateApiToken = 'user.api_token.create',
  DeleteApiToken = 'user.api_token.delete',
  CreateHttpProxyBinding = 'http_proxy.binding.create',
  UpdateHttpProxyBinding = 'http_proxy.binding.update',
  DeleteHttpProxyBinding = 'http_proxy.binding.delete',
  CreateHttpDomainPool = 'http_proxy.domain_pool.create',
  UpdateHttpDomainPool = 'http_proxy.domain_pool.update',
  DeleteHttpDomainPool = 'http_proxy.domain_pool.delete',
  DisconnectSshProxySessions = 'ssh_proxy.sessions.disconnect_all',
  RotateSshProxyHostKey = 'ssh_proxy.host_key.rotate',
}
