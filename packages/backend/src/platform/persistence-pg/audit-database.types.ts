import type { ColumnType } from 'kysely';

type AuditTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type AuditJson = ColumnType<unknown, string | null, string | null>;

export interface AuditEventTable {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_username: string | null;
  actor_snapshot: AuditJson | null;
  action: string;
  target_id: string | null;
  target_type: string | null;
  target_name: string | null;
  target_snapshot: AuditJson | null;
  related: AuditJson;
  detail: AuditJson | null;
  occurred_at: AuditTimestamp;
}

export interface AuditDatabase {
  'audit.events': AuditEventTable;
}
