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
type IamJson<T> = ColumnType<T, T | string, T | string>;

export interface IamServerGrantTable {
  id: string;
  user_id: string | null;
  group_id: string | null;
  server_id: string;
  cpu_millis: number | null;
  mem_bytes: IamBigInt | null;
  disk_bytes: IamBigInt | null;
  extension_grants: IamJson<Record<string, unknown>>;
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
  limit_bytes: IamBigInt;
  expires_at: IamNullableTimestamp;
  created_at: IamGeneratedTimestamp;
  updated_at: IamGeneratedTimestamp;
}

export interface AuthorizationDependencyTable {
  id: string;
  dependency_kind: 'container' | 'volume' | 'volume_attachment';
  dependency_id: string;
  user_id: string;
  server_id: string | null;
  pool_id: string | null;
  shared_backend_id: string | null;
  created_at: IamGeneratedTimestamp;
}

export interface GrantExpiryEnforcementTable {
  user_id: string;
  server_id: string;
  covering_expires_at: Date;
  grace_stopped_at: IamNullableTimestamp;
  purged_at: IamNullableTimestamp;
  claim_token: string | null;
  claimed_by: string | null;
  lease_expires_at: IamNullableTimestamp;
  updated_at: IamGeneratedTimestamp;
}

export interface IamAuthorizationDatabase {
  'iam.server_grants': IamServerGrantTable;
  'iam.storage_pool_grants': IamStoragePoolGrantTable;
  'iam.shared_backend_grants': IamSharedBackendGrantTable;
  'control.authorization_dependencies': AuthorizationDependencyTable;
  'control.grant_expiry_enforcement': GrantExpiryEnforcementTable;
}
