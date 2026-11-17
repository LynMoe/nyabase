import type { ColumnType } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Defaulted<T> = ColumnType<T, T | undefined, T>;

export interface ContainerScriptBlobTable {
  id: string;
  sha256: string;
  content: Buffer;
  size_bytes: number;
  created_by: string | null;
  created_at: GeneratedTimestamp;
}

export interface ContainerScriptTable {
  id: string;
  name: string;
  description: Defaulted<string>;
  priority: number;
  every_boot: boolean;
  status: Defaulted<'active' | 'paused' | 'archived'>;
  pause_reason: 'manual' | 'canary' | 'failures' | null;
  current_version: number;
  revision: Defaulted<number>;
  canary_cleared: Defaulted<boolean>;
  failures_since: GeneratedTimestamp;
  created_by: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ContainerScriptVersionTable {
  id: string;
  script_id: string;
  version: number;
  script: string;
  scope_all: boolean;
  scope_server_ids: Defaulted<string[]>;
  scope_image_ids: Defaulted<string[]>;
  scope_owner_ids: Defaulted<string[]>;
  scope_container_ids: Defaulted<string[]>;
  scope_exclude_container_ids: Defaulted<string[]>;
  on_new_containers: boolean;
  apply_now: boolean;
  stopped_policy: 'wait' | 'skip';
  timeout_seconds: number;
  max_attempts: number;
  max_parallel: number | null;
  max_parallel_per_server: number | null;
  canary_count: number | null;
  pause_after_failures: number | null;
  note: Defaulted<string>;
  published_by: string | null;
  published_at: GeneratedTimestamp;
}

export interface ContainerScriptFileTable {
  version_id: string;
  position: number;
  name: string;
  blob_id: string;
  destination_path: string | null;
  destination_mode: number | null;
  destination_owner: 'root' | 'login_user' | null;
}

export interface ContainerBootObservationTable {
  container_id: string;
  server_id: string;
  instance_status: string;
  boot_id: string | null;
  observed_at: Timestamp;
}

export type ContainerScriptTriggerColumn = 'now' | 'new_container' | 'boot' | 'retry';
export type ContainerScriptRunStatusColumn = 'running' | 'succeeded' | 'failed' | 'timed_out' | 'interrupted';
export type ContainerScriptTargetStateColumn = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'exempt';

export interface ContainerScriptRunTable {
  id: string;
  script_id: string;
  version_id: string;
  version: number;
  container_id: string;
  server_id: string;
  trigger: ContainerScriptTriggerColumn;
  attempt: number;
  boot_id: string | null;
  status: ContainerScriptRunStatusColumn;
  exit_code: number | null;
  output: Defaulted<string>;
  error: string | null;
  deadline_at: Timestamp;
  started_at: GeneratedTimestamp;
  finished_at: Timestamp | null;
}

export interface ContainerScriptTargetTable {
  script_id: string;
  container_id: string;
  state: ContainerScriptTargetStateColumn;
  target_version: number | null;
  succeeded_version: number | null;
  boot_id: string | null;
  boot_after: Timestamp | null;
  trigger: ContainerScriptTriggerColumn | null;
  rerun: Defaulted<boolean>;
  attempts: Defaulted<number>;
  next_attempt_at: Timestamp | null;
  last_run_id: string | null;
  updated_at: GeneratedTimestamp;
}

export interface ContainerScriptsDatabase {
  'control.container_script_blobs': ContainerScriptBlobTable;
  'control.container_scripts': ContainerScriptTable;
  'control.container_script_versions': ContainerScriptVersionTable;
  'control.container_script_files': ContainerScriptFileTable;
  'control.container_boot_observations': ContainerBootObservationTable;
  'control.container_script_runs': ContainerScriptRunTable;
  'control.container_script_targets': ContainerScriptTargetTable;
}
