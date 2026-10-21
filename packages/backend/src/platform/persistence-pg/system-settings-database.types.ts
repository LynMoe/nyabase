import type { ColumnType } from 'kysely';

type SettingsTimestamp = ColumnType<Date, Date | string, Date | string>;
type SettingsGeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type SettingsBigInt = ColumnType<string, string | number | bigint, string | number | bigint>;
type SettingsJson<T> = ColumnType<T, T | string, T | string>;

export interface SystemSettingsTable {
  singleton: boolean;
  revision: SettingsBigInt;
  values: SettingsJson<Record<string, unknown>>;
  updated_by: string | null;
  updated_at: SettingsGeneratedTimestamp;
}

export interface IncusClientIdentityTable {
  singleton: boolean;
  certificate_pem: string;
  encrypted_private_key: string;
  fingerprint: string;
  not_after: SettingsTimestamp;
  created_at: SettingsGeneratedTimestamp;
}

export interface SystemSettingsDatabase {
  'system.settings': SystemSettingsTable;
  'system.incus_client_identity': IncusClientIdentityTable;
}
