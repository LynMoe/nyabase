import type { ColumnType } from 'kysely';

type StorageGeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type StorageBigInt = ColumnType<string, string | number | bigint, string | number | bigint>;

export interface VolumeTable {
  id: string;
  owner_id: string;
  pool_id: string | null;
  server_id: string | null;
  shared_backend_id: string | null;
  name: string;
  incus_name: string;
  size_bytes: StorageBigInt;
  used_bytes: StorageBigInt | null;
  generation: number;
  observed_generation: number | null;
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  needs_attention: boolean;
  failure_code: string | null;
  dir_ensured: ColumnType<boolean, boolean | undefined, boolean>;
  remove_all_committed: ColumnType<boolean, boolean | undefined, boolean>;
  remove_all_server_id: string | null;
  created_at: StorageGeneratedTimestamp;
  updated_at: StorageGeneratedTimestamp;
}

export interface VolumeAttachmentTable {
  id: string;
  container_id: string;
  volume_id: string;
  device_name: string;
  container_path: string;
  read_only: boolean;
  bind_state: ColumnType<
    'attaching' | 'attached' | 'detaching',
    'attaching' | 'attached' | 'detaching' | undefined,
    'attaching' | 'attached' | 'detaching'
  >;
  created_at: StorageGeneratedTimestamp;
  updated_at: StorageGeneratedTimestamp;
}

export interface VolumePlacementTable {
  volume_id: string;
  server_id: string;
  pool_id: string;
  catalog_state: 'ensuring' | 'present';
  observed_generation: number | null;
  created_at: StorageGeneratedTimestamp;
  updated_at: StorageGeneratedTimestamp;
}

export interface StorageDatabase {
  'control.volumes': VolumeTable;
  'control.volume_attachments': VolumeAttachmentTable;
  'control.volume_placements': VolumePlacementTable;
}
