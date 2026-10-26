import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type BigIntColumn = ColumnType<string, string | number | bigint, string | number | bigint>;
type DefaultBigIntColumn = ColumnType<
  string,
  string | number | bigint | undefined,
  string | number | bigint
>;
type JsonColumn<T> = ColumnType<T, string, string>;

export interface SshProxyConnectionTable {
  id: Generated<string>;
  proxy_instance: string;
  connection_seq: BigIntColumn;
  proxy_id: string;
  peer: string;
  peer_ip: string;
  client_version: string | null;
  login: string;
  user_id: string;
  username: string;
  key_fingerprint: string;
  key_algorithm: string;
  pinned_server_id: string | null;
  pinned_server_slug: string | null;
  pinned_container_id: string | null;
  pinned_container_name: string | null;
  connected_at: Timestamp;
  authenticated_at: Timestamp;
  closed_at: Timestamp | null;
  close_reason: string | null;
  last_seen_at: Timestamp;
  bytes_from_client: DefaultBigIntColumn;
  bytes_to_client: DefaultBigIntColumn;
  channels_opened: DefaultBigIntColumn;
  channels_rejected: DefaultBigIntColumn;
  rejected_requests: JsonColumn<Record<string, number>>;
}

export interface SshProxyChannelTable {
  proxy_instance: string;
  connection_seq: BigIntColumn;
  channel_seq: BigIntColumn;
  target_host: string;
  target_port: BigIntColumn;
  originator: string;
  server_id: string | null;
  server_slug: string | null;
  container_id: string | null;
  container_name: string | null;
  instance_name: string | null;
  routed_ip: string | null;
  result: string;
  opened_at: Timestamp;
  closed_at: Timestamp | null;
  close_reason: string | null;
  bytes_from_client: DefaultBigIntColumn;
  bytes_to_client: DefaultBigIntColumn;
}

export interface SshProxyRefusalTable {
  proxy_instance: string;
  window_start: Timestamp;
  peer_ip: string;
  reason: string;
  window_end: Timestamp;
  count: BigIntColumn;
}

export interface SshProxyDailyUsageTable {
  day: ColumnType<string, string, string>;
  user_id: string;
  username: string;
  container_id: string | null;
  container_name: string | null;
  server_id: string | null;
  server_slug: string | null;
  connections: DefaultBigIntColumn;
  channels: DefaultBigIntColumn;
  bytes_from_client: DefaultBigIntColumn;
  bytes_to_client: DefaultBigIntColumn;
}

export interface SshProxyHistoryDatabase {
  'interaction.ssh_proxy_connections': SshProxyConnectionTable;
  'interaction.ssh_proxy_channels': SshProxyChannelTable;
  'interaction.ssh_proxy_refusals': SshProxyRefusalTable;
  'interaction.ssh_proxy_daily_usage': SshProxyDailyUsageTable;
}
