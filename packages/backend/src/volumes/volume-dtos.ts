import {
  StoragePoolResizeFamily,
  type SharedVolumeDto,
  type VolumeAttachmentDto,
  type VolumeAttachmentSummaryDto,
  type IntentAcceptedDto,
  type VolumeDto,
} from '@nyabase/common';
import { isoDate, lifecyclePhase, numberValue } from '../platform/domain-utils.js';
import { storagePoolCapability } from '../storage-pools/storage-pool-capability.js';

export type VolumeRow = {
  id: string;
  owner_id: string;
  pool_id: string | null;
  server_id: string | null;
  shared_backend_id: string | null;
  name: string;
  incus_name: string;
  size_bytes: string | number;
  used_bytes: string | number | null;
  revision: number;
  observed_revision: number | null;
  lifecycle_phase: string;
  needs_attention: boolean;
  failure_code: string | null;
  dir_ensured: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

export function isIntentAccepted(
  result: VolumeDto | SharedVolumeDto | IntentAcceptedDto,
): result is IntentAcceptedDto {
  return 'intentId' in result;
}

export type LocalVolumeDescriptor = { capability: VolumeDto['capability']; poolName: string };
export type SharedVolumeDescriptor = { name: string; capability: SharedVolumeDto['capability'] };

export function toSharedDto(
  row: VolumeRow,
  descriptor: { name: string; capability: SharedVolumeDto['capability'] } | undefined,
  attachments: VolumeAttachmentSummaryDto[],
): SharedVolumeDto {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sharedBackendId: row.shared_backend_id!,
    sharedBackendName: descriptor?.name ?? row.shared_backend_id ?? row.name,
    name: row.name,
    incusName: row.incus_name,
    sizeBytes: numberValue(row.size_bytes),
    usedBytes: row.used_bytes === null ? null : numberValue(row.used_bytes),
    capability: descriptor?.capability ?? storagePoolCapability(
      StoragePoolResizeFamily.QuotaOnline,
      true,
    ),
    lifecyclePhase: lifecyclePhase(row.lifecycle_phase),
    revision: row.revision,
    observedRevision: row.observed_revision,
    needsAttention: row.needs_attention,
    failureCode: row.failure_code,
    dirEnsured: row.dir_ensured,
    createdAt: isoDate(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoDate(row.updated_at) ?? new Date(0).toISOString(),
    attachments,
  };
}

export function toDto(
  row: VolumeRow,
  descriptor: { capability: VolumeDto['capability']; poolName: string } | undefined,
  attachments: VolumeAttachmentSummaryDto[],
): VolumeDto {
  return {
    id: row.id,
    ownerId: row.owner_id,
    poolId: row.pool_id!,
    poolName: descriptor?.poolName ?? row.pool_id ?? row.name,
    serverId: row.server_id!,
    name: row.name,
    incusName: row.incus_name,
    sizeBytes: numberValue(row.size_bytes),
    usedBytes: row.used_bytes === null ? null : numberValue(row.used_bytes),
    scope: { kind: 'local', serverId: row.server_id!, poolId: row.pool_id! },
    capability: descriptor?.capability ?? {
      growOnline: true,
      shrinkOnline: false,
      shrinkRequiresStop: false,
      shrinkNever: false,
      enforceUsageFloor: false,
    },
    lifecyclePhase: lifecyclePhase(row.lifecycle_phase),
    revision: row.revision,
    observedRevision: row.observed_revision,
    needsAttention: row.needs_attention,
    failureCode: row.failure_code,
    createdAt: isoDate(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoDate(row.updated_at) ?? new Date(0).toISOString(),
    attachments,
  };
}

export function toAttachmentDto(
  row: {
    id: string;
    container_id: string;
    volume_id: string;
    device_name: string;
    container_path: string;
    read_only: boolean;
    bind_state: VolumeAttachmentSummaryDto['bindState'];
    created_at: Date | string;
    updated_at: Date | string;
  },
  volumeName: string,
  extra: { kind: 'local' | 'shared'; catalogState: string | null },
): VolumeAttachmentDto {
  return {
    id: row.id,
    containerId: row.container_id,
    volumeId: row.volume_id,
    volumeName,
    deviceName: row.device_name,
    containerPath: row.container_path,
    readOnly: row.read_only,
    bindState: row.bind_state,
    kind: extra.kind,
    onlineCancelAllowed: row.bind_state === 'attaching' && extra.catalogState !== 'present',
    createdAt: isoDate(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoDate(row.updated_at) ?? new Date(0).toISOString(),
  };
}
