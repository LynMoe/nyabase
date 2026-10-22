import type { ColumnType } from 'kysely';

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

export interface SystemSettingsDatabase {
  'system.settings': SystemSettingsTable;
}
