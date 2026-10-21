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
  snapshot_token: string;
  values: SettingsJson<Record<string, unknown>>;
  updated_by: string | null;
  updated_at: SettingsGeneratedTimestamp;
}

export interface IncusClientCertificateTable {
  id: string;
  generation: SettingsBigInt;
  certificate_pem: string;
  encrypted_private_key: string;
  fingerprint: string;
  not_before: SettingsTimestamp;
  not_after: SettingsTimestamp;
  state: 'staged' | 'active' | 'retired' | 'failed';
  created_by: string | null;
  created_at: SettingsGeneratedTimestamp;
  activated_at: SettingsTimestamp | null;
  retired_at: SettingsTimestamp | null;
}

export interface IncusClientCertificateTrustTable {
  certificate_id: string;
  server_id: string;
  state: 'pending' | 'trusted' | 'verified' | 'revoked' | 'cleanup_failed';
  last_error: string | null;
  observed_at: SettingsTimestamp | null;
}

export interface SystemSettingsDatabase {
  'system.settings': SystemSettingsTable;
  'system.incus_client_certificates': IncusClientCertificateTable;
  'system.incus_client_certificate_trusts': IncusClientCertificateTrustTable;
}
