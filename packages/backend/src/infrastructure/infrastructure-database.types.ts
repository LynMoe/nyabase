import type { ColumnType } from 'kysely';

type InfrastructureTimestamp = ColumnType<Date, Date | string, Date | string>;
type InfrastructureGeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type InfrastructureBigInt = ColumnType<string, string | number | bigint, string | number | bigint>;
type InfrastructureNumeric = ColumnType<string, string | number, string | number>;
type InfrastructureJson<T> = ColumnType<T, T | string, T | string>;

export interface InfrastructureServerTable {
  id: string;
  name: string;
  slug: string;
  api_endpoint: string;
  server_cert_fingerprint: string | null;
  incus_version: string | null;
  api_extensions: string[];
  system_pool_id: string | null;
  storage_overcommit_ratio: InfrastructureNumeric;
  parent_interface: string | null;
  dns_servers: string[];
  gpu_runtime_available: boolean;
  status: 'online' | 'unreachable' | 'unknown';
  last_seen_at: InfrastructureTimestamp | null;
  last_error: string | null;
  revision: InfrastructureBigInt;
  node_metrics_endpoint: string | null;
  node_metrics_server_cert_fingerprint: string | null;
  node_metrics_token_ciphertext: string | null;
  node_metrics_token_fingerprint: string | null;
  node_metrics_status: 'unconfigured' | 'online' | 'unreachable' | 'unknown';
  node_metrics_last_success_at: InfrastructureTimestamp | null;
  node_metrics_outage_since: InfrastructureTimestamp | null;
  node_metrics_last_error: string | null;
  preflight_status: 'not_run' | 'running' | 'passed' | 'failed';
  preflight_checked_at: InfrastructureTimestamp | null;
  preflight_report: InfrastructureJson<Record<string, unknown>> | null;
  created_at: InfrastructureGeneratedTimestamp;
  updated_at: InfrastructureGeneratedTimestamp;
}

export interface InfrastructureIpPoolTable {
  id: string;
  name: string;
  cidr: string;
  allocation_cidr: string;
  gateway: string;
  reserved_ips: InfrastructureJson<string[]>;
  revision: InfrastructureBigInt;
  created_at: InfrastructureGeneratedTimestamp;
  updated_at: InfrastructureGeneratedTimestamp;
}

export interface InfrastructureIpPoolServerTable {
  pool_id: string;
  server_id: string;
  created_at: InfrastructureGeneratedTimestamp;
}

export interface InfrastructureStoragePoolTable {
  id: string;
  server_id: string;
  incus_name: string;
  driver: 'dir' | 'btrfs' | 'zfs' | 'lvm' | 'lvmcluster' | 'ceph' | 'cephfs';
  resize_family: 'quota_online' | 'block_backed';
  root_disk_capable: boolean;
  shareable: boolean;
  block_filesystem: string | null;
  shared_backend_id: string | null;
  total_bytes: InfrastructureBigInt | null;
  used_bytes: InfrastructureBigInt | null;
  quota_effective: boolean | null;
  display_name: string | null;
  registered: boolean;
  last_observed_at: InfrastructureTimestamp | null;
  revision: InfrastructureBigInt;
  created_at: InfrastructureGeneratedTimestamp;
  updated_at: InfrastructureGeneratedTimestamp;
}

export interface InfrastructureSharedBackendTable {
  id: string;
  name: string;
  display_name: string | null;
  identity_key: string;
  ceph_fsid: string;
  total_bytes: InfrastructureBigInt | null;
  used_bytes: InfrastructureBigInt | null;
  overcommit_ratio: InfrastructureNumeric;
  revision: InfrastructureBigInt;
  created_at: InfrastructureGeneratedTimestamp;
  updated_at: InfrastructureGeneratedTimestamp;
}

export interface InfrastructureImageTable {
  id: string;
  name: string;
  alias: string;
  fingerprint: string | null;
  description: string | null;
  login_user: string;
  min_root_size_bytes: InfrastructureBigInt | null;
  network_managed_externally: boolean;
  is_active: boolean;
  deleting: boolean;
  cleanup_generation: number;
  revision: InfrastructureBigInt;
  created_at: InfrastructureGeneratedTimestamp;
  updated_at: InfrastructureGeneratedTimestamp;
}

export interface InfrastructureImageServerAssignmentTable {
  id: string;
  image_id: string;
  server_id: string;
  generation: number;
  observed_fingerprint: string | null;
  managed_fingerprint: string | null;
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  needs_attention: boolean;
  failure_code: string | null;
  failure_reason: string | null;
  last_observed_at: InfrastructureTimestamp | null;
  created_at: InfrastructureGeneratedTimestamp;
  updated_at: InfrastructureGeneratedTimestamp;
}

export interface InfrastructureDatabase {
  'infra.servers': InfrastructureServerTable;
  'infra.ip_pools': InfrastructureIpPoolTable;
  'infra.ip_pool_servers': InfrastructureIpPoolServerTable;
  'infra.storage_pools': InfrastructureStoragePoolTable;
  'infra.shared_backends': InfrastructureSharedBackendTable;
  'infra.images': InfrastructureImageTable;
  'infra.image_server_assignments': InfrastructureImageServerAssignmentTable;
}
