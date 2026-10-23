import type { ColumnType, Generated } from 'kysely';
import type { AuditDatabase } from './audit-database.types.js';
import type { IamAuthorizationDatabase } from './iam-authorization-database.types.js';
import type { InfrastructureDatabase } from './infrastructure-database.types.js';
import type { StorageDatabase } from './storage-database.types.js';
import type { ContainerControlDatabase } from './container-control-database.types.js';
import type { HttpProxyDatabase } from './http-proxy-database.types.js';
import type { SystemSettingsDatabase } from './system-settings-database.types.js';

export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type GeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
export type BigIntColumn = ColumnType<string, string | number | bigint, string | number | bigint>;

export interface SchemaMigrationTable {
  version: string;
  name: string;
  checksum: string;
  applied_at: GeneratedTimestamp;
  execution_ms: number;
}

export interface IamUserTable {
  id: string;
  numeric_id: number;
  username: string;
  password_hash: string;
  display_name: string;
  status: string;
  auth_version: number;
  role: Generated<string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface IamGroupTable {
  id: string;
  name: string;
  description: string | null;
  revision: BigIntColumn;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface IamGroupMemberTable {
  id: string;
  group_id: string;
  user_id: string;
  created_at: GeneratedTimestamp;
}

export interface IamRefreshTokenTable {
  id: string;
  user_id: string;
  hash: string;
  previous_hash: string | null;
  previous_request_id_hash: string | null;
  expires_at: Timestamp;
  revoked: boolean;
  created_at: GeneratedTimestamp;
}

export interface IamApiTokenTable {
  id: string;
  user_id: string;
  name: string;
  hash: string;
  last_used_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

export interface IamSshPublicKeyTable {
  id: string;
  user_id: string;
  name: string;
  key_text: string;
  fingerprint: string;
  created_at: GeneratedTimestamp;
}

export interface InteractionSshHostAuthorityTable {
  user_id: string;
  encrypted_private_key: string;
  public_key: string;
  created_at: GeneratedTimestamp;
}

export interface InteractionSshProxyHostKeyTable {
  id: 'singleton';
  encrypted_private_key: string;
  public_key: string;
  fingerprint: string;
  generation: number;
  rotated_at: Timestamp;
}

export interface NyabaseDatabase
  extends AuditDatabase,
    IamAuthorizationDatabase,
    InfrastructureDatabase,
    StorageDatabase,
    ContainerControlDatabase,
    HttpProxyDatabase,
    SystemSettingsDatabase {
  'system.schema_migrations': SchemaMigrationTable;
  'iam.users': IamUserTable;
  'iam.groups': IamGroupTable;
  'iam.group_members': IamGroupMemberTable;
  'iam.refresh_tokens': IamRefreshTokenTable;
  'iam.api_tokens': IamApiTokenTable;
  'iam.ssh_public_keys': IamSshPublicKeyTable;
  'interaction.ssh_proxy_host_keys': InteractionSshProxyHostKeyTable;
  'interaction.ssh_host_authorities': InteractionSshHostAuthorityTable;
}
