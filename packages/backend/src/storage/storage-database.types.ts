import type { ColumnType } from 'kysely';

type StorageTimestamp = ColumnType<Date, Date | string, Date | string>;
type StorageGeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type StorageBigInt = ColumnType<string, string | number | bigint, string | number | bigint>;

export interface VolumeTable {
  id: string;
  owner_id: string;
  pool_id: string;
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
  detach_drained_at: StorageTimestamp | null;
  created_at: StorageGeneratedTimestamp;
  updated_at: StorageGeneratedTimestamp;
}

export interface VolumeDetachDrainTable {
  volume_id: string;
  drained_at: StorageTimestamp;
  created_at: StorageGeneratedTimestamp;
}

export interface VolumePlacementTable {
  volume_id: string;
  server_id: string;
  pool_id: string;
  desired_present: boolean;
  observed_present: boolean;
  observed_generation: number | null;
  unused_confirmed_at: StorageTimestamp | null;
  created_at: StorageGeneratedTimestamp;
  updated_at: StorageGeneratedTimestamp;
}

export interface StorageDatabase {
  'control.volumes': VolumeTable;
  'control.volume_attachments': VolumeAttachmentTable;
  'control.volume_detach_drains': VolumeDetachDrainTable;
  'control.volume_placements': VolumePlacementTable;
}
