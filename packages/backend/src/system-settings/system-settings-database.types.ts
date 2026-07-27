import type { ColumnType } from 'kysely';

type SettingsJson = ColumnType<
  Record<string, unknown>,
  Record<string, unknown> | string,
  Record<string, unknown> | string
>;

export interface SystemSettingsTable {
  singleton: boolean;
  revision: ColumnType<string, string | number | bigint, string | number | bigint>;
  snapshot_token: string;
  values: SettingsJson;
  updated_by: string | null;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface SystemSettingsDatabase {
  'system.settings': SystemSettingsTable;
}
