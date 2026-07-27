import type { ColumnType } from 'kysely';

type InfraTimestamp = ColumnType<Date, Date | string, Date | string>;
type InfraGeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type InfraBigInt = ColumnType<string, string | number | bigint, string | number | bigint>;
type InfraJson = ColumnType<unknown, string | unknown, string | unknown>;

export interface InfrastructureServerTable {
  id: string;
  name: string;
  slug: string;
  agent_token_hash: string;
  host_fingerprint: string | null;
  agent_config_fingerprint: string | null;
  status: string;
  quarantine_code: string | null;
  quarantine_message: string | null;
  last_seen_at: InfraTimestamp | null;
  macvlan_cidr: string | null;
  macvlan_gateway: string | null;
  macvlan_reserved_ips: InfraJson;
  revision: InfraBigInt;
  created_at: InfraGeneratedTimestamp;
  updated_at: InfraGeneratedTimestamp;
}

export interface InfrastructureImageTable {
  id: string;
  name: string;
  docker_image: string;
  runtime_overrides: InfraJson;
  description: string | null;
  is_active: boolean;
  disable_ssh: boolean;
  deleting: boolean;
  cleanup_generation: number;
  revision: InfraBigInt;
  created_at: InfraGeneratedTimestamp;
  updated_at: InfraGeneratedTimestamp;
}

export interface InfrastructureDatabase {
  'infra.servers': InfrastructureServerTable;
  'infra.images': InfrastructureImageTable;
}
