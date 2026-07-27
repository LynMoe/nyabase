import type { ColumnType, Generated } from 'kysely';
import type { RemoteFsParams } from '@nyabase/common';

type StorageGeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type StorageBigInt = ColumnType<string, string | number | bigint, string | number | bigint>;
type StorageJson<T> = ColumnType<T, T | string, T | string>;

export interface RemoteFsMountTable {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  type: string;
  host_mount_point: string;
  options: string;
  params: StorageJson<RemoteFsParams>;
  desired_state: 'active' | 'removing';
  generation: number;
  last_task_id: string | null;
  created_at: StorageGeneratedTimestamp;
  updated_at: StorageGeneratedTimestamp;
}

export interface RemoteFsServerAssignmentTable {
  id: string;
  remote_fs_mount_id: string;
  server_id: string;
  desired_state: 'ensuring' | 'active' | 'removing' | 'failed';
  generation: number;
  last_task_id: string | null;
  created_at: StorageGeneratedTimestamp;
  updated_at: StorageGeneratedTimestamp;
}

export interface DataDirectoryTable {
  id: string;
  user_id: string;
  source_kind: 'local' | 'remote';
  source_id: string;
  remote_fs_mount_id: Generated<string | null>;
  name: string;
  source_identity: string;
  server_id: string | null;
  uid: number;
  desired_state: 'creating' | 'active' | 'removing' | 'failed';
  generation: number;
  last_task_id: string | null;
  created_at: StorageGeneratedTimestamp;
  updated_at: StorageGeneratedTimestamp;
}

export interface QuotaDesiredTable {
  id: string;
  server_id: string;
  user_id: string;
  numeric_user_id: number;
  limit_bytes: StorageBigInt;
  source: 'grant';
  generation: number;
  last_task_id: string | null;
  created_at: StorageGeneratedTimestamp;
  updated_at: StorageGeneratedTimestamp;
}

export interface StorageDatabase {
  'infra.remote_fs_mounts': RemoteFsMountTable;
  'infra.remote_fs_server_assignments': RemoteFsServerAssignmentTable;
  'control.data_directories': DataDirectoryTable;
  'control.quota_desired': QuotaDesiredTable;
}
