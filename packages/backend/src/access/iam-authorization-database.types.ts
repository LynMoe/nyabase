import type { ColumnType, Generated } from 'kysely';

type IamBigInt = ColumnType<string, string | number | bigint, string | number | bigint>;
type IamGeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;

export interface IamServerGrantTable {
  id: string;
  user_id: string | null;
  group_id: string | null;
  server_id: string;
  cpu_millis: number | null;
  mem_bytes: IamBigInt | null;
  disk_bytes: IamBigInt | null;
  gpu_mode: string | null;
  gpu_indices: number[] | null;
  created_at: IamGeneratedTimestamp;
  updated_at: IamGeneratedTimestamp;
}

export interface IamImageGrantTable {
  id: string;
  user_id: string | null;
  group_id: string | null;
  image_id: string;
  server_id: string;
  created_at: IamGeneratedTimestamp;
}

export interface IamMountSourceGrantTable {
  id: string;
  user_id: string | null;
  group_id: string | null;
  source_kind: string;
  source_id: string;
  remote_fs_mount_id: Generated<string | null>;
  server_id: string | null;
  source_identity: string | null;
  created_at: IamGeneratedTimestamp;
  updated_at: IamGeneratedTimestamp;
}

export interface AuthorizationDependencyTable {
  id: string;
  dependency_kind: string;
  dependency_id: string;
  user_id: string;
  server_id: string;
  source_kind: string | null;
  source_id: string | null;
  source_identity: string | null;
  created_at: IamGeneratedTimestamp;
}

export interface IamAuthorizationDatabase {
  'iam.server_grants': IamServerGrantTable;
  'iam.image_grants': IamImageGrantTable;
  'iam.mount_source_grants': IamMountSourceGrantTable;
  'control.authorization_dependencies': AuthorizationDependencyTable;
}
