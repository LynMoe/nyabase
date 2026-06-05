export enum UserStatus {
  Active = 'active',
  Disabled = 'disabled',
}

export enum ServerStatus {
  Online = 'online',
  Offline = 'offline',
  Unknown = 'unknown',
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
  Deleted = 'deleted',
  Failed = 'failed',
  Orphaned = 'orphaned',
}

export enum ContainerPowerIntent {
  Running = 'running',
  Stopped = 'stopped',
}

export enum OperationStatus {
  Queued = 'queued',
  Running = 'running',
  WaitingAgent = 'waiting_agent',
  WaitingObserved = 'waiting_observed',
  Blocked = 'blocked',
  Retrying = 'retrying',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Compensating = 'compensating',
  Cancelled = 'cancelled',
}

export enum OperationKind {
  ContainerCreate = 'container.create',
  ContainerStart = 'container.start',
  ContainerStop = 'container.stop',
  ContainerRestart = 'container.restart',
  ContainerDelete = 'container.delete',
  ContainerUpdateMounts = 'container.update_mounts',
  ContainerEnableSsh = 'container.enable_ssh',
  ContainerReconcileSsh = 'container.reconcile_ssh',
  DataDirCreate = 'datadir.create',
  DataDirDelete = 'datadir.delete',
  DiskApply = 'disk.apply',
  RemoteFsApply = 'remote_fs.apply',
  QuotaApply = 'quota.apply',
  ImagePull = 'image.pull',
}

export enum AgentCommandKind {
  RuntimeContainerCreate = 'runtime.container.create',
  RuntimeContainerPower = 'runtime.container.power',
  RuntimeContainerDelete = 'runtime.container.delete',
  RuntimeContainerMountsApply = 'runtime.container.mounts.apply',
  RuntimeContainerSshApply = 'runtime.container.ssh.apply',
  DataDirApply = 'datadir.apply',
  DataDirDelete = 'datadir.delete',
  DiskApply = 'disk.apply',
  DiskRemove = 'disk.remove',
  RemoteFsApply = 'remote_fs.apply',
  RemoteFsRemove = 'remote_fs.remove',
  QuotaApply = 'quota.apply',
  ImagePull = 'image.pull',
}

export enum AgentCommandStatus {
  Pending = 'pending',
  WaitingAgent = 'waiting_agent',
  Sent = 'sent',
  Running = 'running',
  Retrying = 'retrying',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export enum HookStatus {
  Pending = 'pending',
  Running = 'running',
  WaitingAgent = 'waiting_agent',
  WaitingObserved = 'waiting_observed',
  NotApplicable = 'not_applicable',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Retrying = 'retrying',
}

export enum HookKind {
  Mounts = 'mounts',
  Ssh = 'ssh',
  DataDirs = 'data_dirs',
  RemoteFs = 'remote_fs',
  DataDisks = 'data_disks',
  Quota = 'quota',
  Audit = 'audit',
  Grants = 'grants',
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
  UpdateServerDefaults = 'server.defaults.update',
  DeleteServer = 'server.delete',
  AddDataDisk = 'server.disk.add',
  RemoveDataDisk = 'server.disk.remove',
  CreateImage = 'image.create',
  UpdateImage = 'image.update',
  DeleteImage = 'image.delete',
  CreateUser = 'user.create',
  UpdateUser = 'user.update',
  DeleteUser = 'user.delete',
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
  RemountRemoteFsMount = 'remote_fs.remount',
  AssignRemoteFsServer = 'remote_fs.server.assign',
  UnassignRemoteFsServer = 'remote_fs.server.unassign',
  UpsertMountSourceGrant = 'grant.mount_source.upsert',
  DeleteMountSourceGrant = 'grant.mount_source.delete',
  UpsertContainerMount = 'container.mount.upsert',
  DeleteContainerMount = 'container.mount.delete',
}
