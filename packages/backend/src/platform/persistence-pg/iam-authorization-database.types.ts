import type { ColumnType } from 'kysely';

type IamBigInt = ColumnType<string, string | number | bigint, string | number | bigint>;
type IamGeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type IamNullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export interface IamServerGrantTable {
  id: string;
  user_id: string | null;
  group_id: string | null;
  server_id: string;
  cpu_cores: number | null;
  mem_bytes: IamBigInt | null;
  disk_bytes: IamBigInt | null;
  gpu_pci_addresses: ColumnType<string[], string[] | undefined, string[]>;
  expires_at: IamNullableTimestamp;
  created_at: IamGeneratedTimestamp;
  updated_at: IamGeneratedTimestamp;
}

export interface IamStoragePoolGrantTable {
  id: string;
  user_id: string | null;
  group_id: string | null;
  pool_id: string;
  expires_at: IamNullableTimestamp;
  created_at: IamGeneratedTimestamp;
  updated_at: IamGeneratedTimestamp;
}

export interface IamSharedBackendGrantTable {
  id: string;
  user_id: string | null;
  group_id: string | null;
  shared_backend_id: string;
  limit_bytes: IamBigInt | null;
  expires_at: IamNullableTimestamp;
  created_at: IamGeneratedTimestamp;
  updated_at: IamGeneratedTimestamp;
}

/** Read-only view: merged direct + group-inherited server grants (see 000001_initial.sql). */
export interface IamEffectiveServerAccessView {
  user_id: string;
  server_id: string;
  /** NULL = unlimited. */
  cpu_cores: number | null;
  mem_bytes: string | null;
  disk_bytes: string | null;
  gpu_pci_addresses: string[];
  /** NULL = never expires. */
  expires_at: Date | null;
}

export interface IamEffectivePoolAccessView {
  user_id: string;
  pool_id: string;
  expires_at: Date | null;
}

export interface IamEffectiveSharedBackendAccessView {
  user_id: string;
  shared_backend_id: string;
  /** NULL = unlimited. */
  limit_bytes: string | null;
  expires_at: Date | null;
}

export type AccessLapseResourceKind = 'server' | 'storage_pool' | 'shared_backend';

export interface AccessLapseTable {
  user_id: string;
  resource_kind: AccessLapseResourceKind;
  resource_id: string;
  lapsed_at: Date;
  stopped_at: IamNullableTimestamp;
  purged_at: IamNullableTimestamp;
}

export interface IamAuthorizationDatabase {
  'iam.server_grants': IamServerGrantTable;
  'iam.storage_pool_grants': IamStoragePoolGrantTable;
  'iam.shared_backend_grants': IamSharedBackendGrantTable;
  'iam.effective_server_access': IamEffectiveServerAccessView;
  'iam.effective_pool_access': IamEffectivePoolAccessView;
  'iam.effective_shared_backend_access': IamEffectiveSharedBackendAccessView;
  'control.access_lapses': AccessLapseTable;
}
