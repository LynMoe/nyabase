export enum UserStatus {
  Active = 'active',
  Disabled = 'disabled',
  /** Access is revoked while durable per-server quota=0 tasks converge. */
  Deleting = 'deleting',
  /** Terminal tombstone retained for durable references; it can never be reactivated. */
  Deleted = 'deleted',
}

export enum ServerStatus {
  Online = 'online',
  Offline = 'offline',
  Unknown = 'unknown',
  AgentStateUnready = 'agent_state_unready',
  /**
   * Backend rejected structurally impossible terminal evidence. The server is
   * fenced across reconnects until an administrator explicitly retries the
   * retained task after repairing/replacing the Agent binary.
   */
  AgentQuarantined = 'agent_quarantined',
}

export enum ContainerStatus {
  Creating = 'creating',
  Running = 'running',
  Exited = 'exited',
  Paused = 'paused',
  Restarting = 'restarting',
  Dead = 'dead',
  Unknown = 'unknown',
}

export enum ContainerPhase {
  Provisioning = 'provisioning',
  Active = 'active',
  Updating = 'updating',
  Deleting = 'deleting',
  Failed = 'failed',
}

export enum ContainerPowerIntent {
  Running = 'running',
  Stopped = 'stopped',
}

export enum AgentTaskStatus {
  Pending = 'pending',
  Succeeded = 'succeeded',
  Failed = 'failed',
}

/** One durable, high-level effect executed by exactly one authenticated Agent. */
export enum AgentTaskKind {
  ContainerCreate = 'container.create',
  ContainerStart = 'container.start',
  ContainerStop = 'container.stop',
  ContainerRestart = 'container.restart',
  ContainerDelete = 'container.delete',
  ContainerRuntimeAbsent = 'container.runtime.absent',
  ContainerSshEnsure = 'container.ssh.ensure',
  DataDirEnsure = 'datadir.ensure',
  DataDirAbsent = 'datadir.absent',
  RemoteFsEnsure = 'remote_fs.ensure',
  RemoteFsAbsent = 'remote_fs.absent',
  QuotaEnsure = 'quota.ensure',
  ImageEnsurePresent = 'image.ensure_present',
  ImageEnsureAbsent = 'image.ensure_absent',
}

export enum RuntimeDriftKind {
  AgentStateUnready = 'agent_state_unready',
  RuntimeMissing = 'runtime_missing',
  RuntimeUnbound = 'runtime_unbound',
  RuntimeIdMismatch = 'runtime_id_mismatch',
  DesiredMissing = 'desired_missing',
  SpecGenerationMismatch = 'spec_generation_mismatch',
  SpecGenerationStale = 'spec_generation_stale',
  PowerIntentMismatch = 'power_intent_mismatch',
  MountMismatch = 'mount_mismatch',
  SshMismatch = 'ssh_mismatch',
  QuotaMismatch = 'quota_mismatch',
  UnmanagedRuntime = 'unmanaged_runtime',
}

/** Remote filesystem type discriminator */
export enum RemoteFsType {
  Nfs = 'nfs',
  CephFs = 'cephfs',
}

/** Actionable capability bits stored in a group */
export enum Capability {
  ManageUsers = 'manage_users',
  ManageGroups = 'manage_groups',
  ManageServers = 'manage_servers',
  ManageImages = 'manage_images',
  ManageGrants = 'manage_grants',
  ManageContainersAny = 'manage_containers_any',
  ViewAudit = 'view_audit',
  ViewMetricsAll = 'view_metrics_all',
  ManageSystemSettings = 'manage_system_settings',
}

/** Systemd ActiveState of the nyabase-managed dockerd unit */
export enum DockerDaemonState {
  Active = 'active',
  Activating = 'activating',
  Inactive = 'inactive',
  Failed = 'failed',
  Unknown = 'unknown',
}

/** How GPU access is expressed in a server grant */
export enum GpuGrantMode {
  None = 'none',
  Indices = 'indices',
  All = 'all',
}

export enum AuditAction {
  CreateContainer = 'container.create',
  StartContainer = 'container.start',
  StopContainer = 'container.stop',
  RestartContainer = 'container.restart',
  DeleteContainer = 'container.delete',
  ExecContainer = 'container.exec',
  CreateServer = 'server.create',
  UpdateServer = 'server.update',
  DeleteServer = 'server.delete',
  AddDataDisk = 'server.disk.add',
  RemoveDataDisk = 'server.disk.remove',
  CreateImage = 'image.create',
  UpdateImage = 'image.update',
  DeleteImage = 'image.delete',
  CreateUser = 'user.create',
  UpdateUser = 'user.update',
  DeleteUser = 'user.delete',
  ViewUserInternalSshKey = 'user.internal_ssh_key.view',
  RotateUserInternalSshKey = 'user.internal_ssh_key.rotate',
  CreateGroup = 'group.create',
  UpdateGroup = 'group.update',
  DeleteGroup = 'group.delete',
  AddGroupMember = 'group.member.add',
  RemoveGroupMember = 'group.member.remove',
  UpsertServerGrant = 'grant.server.upsert',
  DeleteServerGrant = 'grant.server.delete',
  UpsertImageGrant = 'grant.image.upsert',
  DeleteImageGrant = 'grant.image.delete',
  CreateDataDir = 'datadir.create',
  DeleteDataDir = 'datadir.delete',
  UserLogin = 'user.login',
  UserLogout = 'user.logout',
  CreateRemoteFsMount = 'remote_fs.create',
  UpdateRemoteFsMount = 'remote_fs.update',
  DeleteRemoteFsMount = 'remote_fs.delete',
  AssignRemoteFsServer = 'remote_fs.server.assign',
  UnassignRemoteFsServer = 'remote_fs.server.unassign',
  UpsertMountSourceGrant = 'grant.mount_source.upsert',
  DeleteMountSourceGrant = 'grant.mount_source.delete',
  UpsertContainerMount = 'container.mount.upsert',
  DeleteContainerMount = 'container.mount.delete',
}
