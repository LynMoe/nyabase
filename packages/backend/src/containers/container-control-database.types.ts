import type { ColumnType } from 'kysely';
import type {
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  ImageRuntimeOverrides,
} from '@nyabase/common';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type BigInt = ColumnType<string, string | number | bigint, string | number | bigint>;
type Json<T> = ColumnType<T, T | string, T | string>;

export interface ContainerControlTable {
  id: string;
  server_id: string;
  owner_id: string;
  image_id: string;
  created_by: string;
  name: string;
  revision: BigInt;
  desired_generation: number;
  image_ref: string;
  image_default_uid: number;
  image_runtime_overrides: Json<ImageRuntimeOverrides>;
  cpu_millis: number;
  mem_bytes: BigInt;
  disk_bytes: BigInt;
  gpu_mode: 'none' | 'indices' | 'all';
  gpu_indices: number[];
  mounts_json: Json<unknown[]>;
  power_intent: ContainerPowerIntent;
  lifecycle_phase: ContainerPhase;
  observed_generation: number | null;
  bound_runtime_id: string | null;
  quota_paths: string[];
  runtime_spec_hash: string | null;
  active_task_id: string | null;
  last_transition_at: Timestamp;
  failure_reason: string | null;
  failure_code: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ContainerMountTable {
  id: string;
  container_id: string;
  server_id: string;
  resource_id: string;
  source_kind: 'local' | 'remote';
  source_id: string;
  source_identity: string;
  user_id: string;
  dir_name: string;
  container_path: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ContainerGpuClaimTable {
  id: string;
  container_id: string;
  server_id: string;
  gpu_index: number;
  created_at: GeneratedTimestamp;
}

export interface ContainerNetworkClaimTable {
  id: string;
  container_id: string | null;
  owner_kind: 'container' | 'runtime_cleanup';
  owner_id: string;
  server_id: string;
  network_key: string;
  address: string;
  state: 'active' | 'releasing';
  reusable_at: Timestamp | null;
  cleanup_payload_json: Json<unknown> | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ContainerSshRouteTable {
  container_id: string;
  server_id: string;
  runtime_id: string;
  macvlan_ip: string | null;
  runtime_status: ContainerStatus;
  ssh_status: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown';
  applied_internal_key_generation: number | null;
  container_host_key_fingerprint: string | null;
  last_error: string | null;
  observed_at: Timestamp;
}

export interface ContainerControlDatabase {
  'control.containers': ContainerControlTable;
  'control.container_mounts': ContainerMountTable;
  'control.container_gpu_claims': ContainerGpuClaimTable;
  'control.container_network_claims': ContainerNetworkClaimTable;
  'control.container_ssh_routes': ContainerSshRouteTable;
}
