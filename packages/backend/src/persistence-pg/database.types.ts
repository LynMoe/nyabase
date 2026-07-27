import type { ColumnType } from 'kysely';
import type { AuditDatabase } from '../audit/audit-database.types.js';
import type { IamAuthorizationDatabase } from '../access/iam-authorization-database.types.js';
import type { InfrastructureDatabase } from '../infrastructure/infrastructure-database.types.js';
import type { StorageDatabase } from '../storage/storage-database.types.js';
import type { ContainerControlDatabase } from '../containers/container-control-database.types.js';
import type { WorkflowDatabase } from '../agent-tasks/workflow-database.types.js';
import type { HttpProxyDatabase } from '../http-proxy/http-proxy-database.types.js';
import type { SystemSettingsDatabase } from '../system-settings/system-settings-database.types.js';

export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type GeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
export type BigIntColumn = ColumnType<string, string | number | bigint, string | number | bigint>;

/**
 * Initial database typing surface. Domain lanes add tables here as their
 * SQL-first migrations and query modules replace the legacy ORM entities.
 */
export interface SchemaMigrationTable {
  version: string;
  name: string;
  checksum: string;
  applied_at: GeneratedTimestamp;
  execution_ms: number;
}

export interface IamPolicyStateTable {
  singleton: boolean;
  policy_epoch: BigIntColumn;
  next_numeric_user_id: number;
  updated_at: GeneratedTimestamp;
}

export interface IamUserTable {
  id: string;
  numeric_id: number;
  username: string;
  password_hash: string;
  display_name: string;
  status: string;
  auth_version: number;
  authz_version: BigIntColumn;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface IamGroupTable {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  is_system: boolean;
  system_key: string | null;
  capabilities: string[];
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
  created_at: Timestamp;
}

export interface IamApiTokenTable {
  id: string;
  user_id: string;
  name: string;
  hash: string;
  last_used_at: Timestamp | null;
  created_at: Timestamp;
}

export interface IamSshPublicKeyTable {
  id: string;
  user_id: string;
  name: string;
  key_text: string;
  fingerprint: string;
  created_at: Timestamp;
}

export interface IamUserInternalSshKeyTable {
  user_id: string;
  encrypted_private_key: string;
  public_key: string;
  fingerprint: string;
  generation: number;
  rotated_at: Timestamp;
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
    WorkflowDatabase,
    HttpProxyDatabase,
    SystemSettingsDatabase {
  'system.schema_migrations': SchemaMigrationTable;
  'iam.policy_state': IamPolicyStateTable;
  'iam.users': IamUserTable;
  'iam.groups': IamGroupTable;
  'iam.group_members': IamGroupMemberTable;
  'iam.refresh_tokens': IamRefreshTokenTable;
  'iam.api_tokens': IamApiTokenTable;
  'iam.ssh_public_keys': IamSshPublicKeyTable;
  'iam.user_internal_ssh_keys': IamUserInternalSshKeyTable;
  'interaction.ssh_proxy_host_keys': InteractionSshProxyHostKeyTable;
}
