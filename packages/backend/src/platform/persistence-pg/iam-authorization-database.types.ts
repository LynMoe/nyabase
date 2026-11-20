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

type IamQuotaColumns = {
  /** NULL = unlimited. */
  cpu_cores: number | null;
  mem_bytes: IamBigInt | null;
  /** The system disks' own ceiling; NULL = only the disk total. */
  root_disk_bytes: IamBigInt | null;
  gpu_count: number | null;
};

export interface IamGrantBundleTable extends IamQuotaColumns {
  id: string;
  server_id: string;
  name: string;
  /** System disks and data disks together (000014); never unlimited. */
  disk_bytes: IamBigInt;
  revision: IamBigInt;
  created_at: IamGeneratedTimestamp;
  updated_at: IamGeneratedTimestamp;
}

/** One bundle per (user, server); a quota column is set only for a field named in `overridden`. */
export interface IamServerGrantTable extends IamQuotaColumns {
  id: string;
  user_id: string;
  server_id: string;
  bundle_id: string;
  overridden: ColumnType<string[], string[] | undefined, string[]>;
  /** Set exactly when `disk` is overridden. */
  disk_bytes: IamBigInt | null;
  expires_at: IamNullableTimestamp;
  created_at: IamGeneratedTimestamp;
  updated_at: IamGeneratedTimestamp;
}

/** A data disk of a bundle (000014): a local pool of its server, with an optional ceiling. */
export interface IamGrantBundleDiskTable {
  bundle_id: string;
  server_id: string;
  pool_id: string;
  /** NULL = only the bundle's total. */
  cap_bytes: IamBigInt | null;
}

/** A data disk of a server grant that overrides `data_disks` (its bundle's list otherwise). */
export interface IamStoragePoolGrantTable {
  id: string;
  server_grant_id: string;
  user_id: string;
  server_id: string;
  pool_id: string;
  /** NULL = only the grant's total. */
  cap_bytes: IamBigInt | null;
  created_at: IamGeneratedTimestamp;
  updated_at: IamGeneratedTimestamp;
}

export interface IamSharedBackendGrantTable {
  id: string;
  user_id: string;
  shared_backend_id: string;
  limit_bytes: IamBigInt;
  expires_at: IamNullableTimestamp;
  created_at: IamGeneratedTimestamp;
  updated_at: IamGeneratedTimestamp;
}

/** Read-only view: current grants of active users with overrides applied (see 000003 and 000014). */
export interface IamEffectiveServerAccessView {
  user_id: string;
  server_id: string;
  /** NULL = unlimited. */
  cpu_cores: number | null;
  mem_bytes: string | null;
  root_disk_bytes: string | null;
  /** NULL = every observed card. */
  gpu_count: number | null;
  /** The cards picked for the user from the server's observed GPUs. */
  gpu_pci_addresses: string[];
  /** NULL = never expires. */
  expires_at: Date | null;
  /** System disks and data disks together. */
  disk_bytes: string;
}

/** The data disks of current server grants: the bundle's list, or the grant's own. */
export interface IamEffectivePoolAccessView {
  user_id: string;
  pool_id: string;
  /** The disk's ceiling; NULL = only the grant's total. */
  cap_bytes: string | null;
  /** The server grant's expiry. */
  expires_at: Date | null;
  server_id: string;
  server_grant_id: string;
}

export interface IamEffectiveSharedBackendAccessView {
  user_id: string;
  shared_backend_id: string;
  limit_bytes: string;
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
  'iam.grant_bundles': IamGrantBundleTable;
  'iam.server_grants': IamServerGrantTable;
  'iam.grant_bundle_disks': IamGrantBundleDiskTable;
  'iam.storage_pool_grants': IamStoragePoolGrantTable;
  'iam.shared_backend_grants': IamSharedBackendGrantTable;
  'iam.effective_server_access': IamEffectiveServerAccessView;
  'iam.effective_pool_access': IamEffectivePoolAccessView;
  'iam.effective_shared_backend_access': IamEffectiveSharedBackendAccessView;
  'control.access_lapses': AccessLapseTable;
}
