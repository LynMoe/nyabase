import type { ColumnType } from 'kysely';

type ContainerTimestamp = ColumnType<Date, Date | string, Date | string>;
type ContainerGeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type ContainerBigInt = ColumnType<string, string | number | bigint, string | number | bigint>;
type ContainerJson<T> = ColumnType<T, T | string, T | string>;

export interface ContainerControlTable {
  id: string;
  server_id: string;
  owner_id: string;
  image_id: string;
  created_by: string;
  name: string;
  revision: ContainerBigInt;
  generation: number;
  observed_generation: number | null;
  image_alias: string;
  image_fingerprint: string;
  root_pool_id: string;
  root_size_bytes: ContainerBigInt;
  root_size_pending_bytes: ContainerBigInt | null;
  root_used_bytes: ColumnType<string | null, string | number | bigint | null | undefined, string | number | bigint | null>;
  cpu_millis: number;
  mem_bytes: ContainerBigInt;
  nvidia_runtime: boolean;
  gpu_pci_addresses: string[];
  nesting: boolean;
  syscall_intercept: boolean;
  power_intent: 'running' | 'stopped';
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  instance_name: string | null;
  needs_attention: boolean;
  failure_code: string | null;
  failure_reason: string | null;
  last_transition_at: ContainerTimestamp;
  created_at: ContainerGeneratedTimestamp;
  updated_at: ContainerGeneratedTimestamp;
}

export interface ContainerGpuClaimTable {
  id: string;
  container_id: string;
  server_id: string;
  gpu_pci_address: string;
  created_at: ContainerGeneratedTimestamp;
}

export interface ContainerNetworkClaimTable {
  id: string;
  container_id: string | null;
  server_id: string;
  network_key: string;
  address: string;
  state: 'active' | 'releasing';
  reusable_at: ContainerTimestamp | null;
  created_at: ContainerGeneratedTimestamp;
  updated_at: ContainerGeneratedTimestamp;
  owner_kind: 'container' | 'runtime_cleanup';
  owner_id: string;
  cleanup_payload_json: ContainerJson<Record<string, unknown>> | null;
}

export interface ContainerSshRouteTable {
  container_id: string;
  server_id: string;
  instance_name: string;
  routed_ip: string;
  instance_status: string;
  instance_started_at: ContainerTimestamp | null;
  ssh_status: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown';
  container_host_key_fingerprint: string | null;
  last_error: string | null;
  observed_at: ContainerTimestamp;
}

export interface IntentTable {
  id: string;
  kind: string;
  resource_type: 'container' | 'volume' | 'image_assignment' | 'server' | 'certificate_rotation';
  resource_id: string;
  server_id: string | null;
  requested_by: string | null;
  request_json: ContainerJson<Record<string, unknown>> | null;
  target_generation: number;
  baseline_json: ContainerJson<Record<string, unknown>> | null;
  status: 'pending' | 'succeeded' | 'failed';
  failure_code: string | null;
  failure_json: ContainerJson<Record<string, unknown>> | null;
  attempt_count: number;
  next_attempt_at: ContainerTimestamp | null;
  blocked_by_intent_id: string | null;
  created_at: ContainerGeneratedTimestamp;
  settled_at: ContainerTimestamp | null;
}

export interface ReconcileClaimTable {
  resource_type: 'container' | 'volume' | 'image_assignment' | 'server' | 'certificate_rotation';
  resource_id: string;
  placement_server_id: string;
  server_id: string | null;
  worker_id: string;
  lease_expires_at: ContainerTimestamp;
  claimed_at: ContainerGeneratedTimestamp;
}

export interface ContainerControlDatabase {
  'control.containers': ContainerControlTable;
  'control.container_gpu_claims': ContainerGpuClaimTable;
  'control.container_network_claims': ContainerNetworkClaimTable;
  'control.container_ssh_routes': ContainerSshRouteTable;
  'control.intents': IntentTable;
  'control.reconcile_claims': ReconcileClaimTable;
}
