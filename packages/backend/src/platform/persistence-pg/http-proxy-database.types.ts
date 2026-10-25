import type { ColumnType } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type BigIntColumn = ColumnType<string, string | number | bigint, string | number | bigint>;
type GeneratedBigIntColumn = ColumnType<
  string,
  string | number | bigint | undefined,
  string | number | bigint
>;

export interface HttpDomainPoolTable {
  id: string;
  wildcard_domain: string;
  enabled: boolean;
  https_enabled: boolean;
  certificate_pem: string | null;
  encrypted_private_key_pem: string | null;
  certificate_fingerprint: string | null;
  certificate_not_after: Timestamp | null;
  revision: GeneratedBigIntColumn;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface HttpProxyBindingTable {
  id: string;
  hostname: string;
  domain_pool_id: string;
  owner_id: string;
  container_id: string;
  target_port: number;
  revision: GeneratedBigIntColumn;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface HttpHostnameReservationTable {
  hostname: string;
  owner_id: string;
  binding_id: string | null;
  state: 'active' | 'releasing';
  reusable_at: Timestamp | null;
  release_generation: BigIntColumn;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface HttpProxySnapshotStateTable {
  singleton: boolean;
  generation: BigIntColumn;
  lease_issued_at: Timestamp | null;
  lease_valid_until: Timestamp | null;
  payload_sha256: string | null;
  updated_at: GeneratedTimestamp;
}

export interface HttpProxyCounterInstanceTable {
  proxy_instance: string;
  last_seen_at: Timestamp;
  archived_at: Timestamp | null;
}

export interface HttpProxyBindingCountersTable {
  proxy_instance: string;
  binding_id: string;
  requests: GeneratedBigIntColumn;
  rx_bytes: GeneratedBigIntColumn;
  tx_bytes: GeneratedBigIntColumn;
  updated_at: GeneratedTimestamp;
}

export interface HttpProxyDatabase {
  'interaction.http_domain_pools': HttpDomainPoolTable;
  'interaction.http_proxy_bindings': HttpProxyBindingTable;
  'interaction.http_hostname_reservations': HttpHostnameReservationTable;
  'interaction.http_proxy_snapshot_state': HttpProxySnapshotStateTable;
  'interaction.http_proxy_counter_instances': HttpProxyCounterInstanceTable;
  'interaction.http_proxy_binding_counters': HttpProxyBindingCountersTable;
}
