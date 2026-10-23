import { Inject, Injectable } from '@nestjs/common';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import {
  StoragePoolResizeFamily,
  type SharedVolumeDto,
  type VolumeAttachmentDto,
  type VolumeAttachmentSummaryDto,
  type IntentAcceptedDto,
  type VolumeDto,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import { isoDate, lifecyclePhase, numberValue, poolLabel } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { storagePoolCapability } from '../storage-pools/storage-pool-capability.js';
import type { VolumeKind } from './volume-rules.js';
import { VolumesRepository } from './volumes.repository.js';

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
  /** See `shrinkReservation`. */
  shrink_reserved_bytes: string | number | null;
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

/** Turns volume rows into DTOs, loading the pools, backends and attachments they reference. */
@Injectable()
export class VolumeDtoAssembler {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly repository: VolumesRepository,
    private readonly pools: StoragePoolsRepository,
  ) {}

  private async poolDescriptors(
    poolIds: readonly string[],
  ): Promise<Map<string, LocalVolumeDescriptor>> {
    const result = new Map<string, LocalVolumeDescriptor>();
    const pools = await this.pools.listByIds([...new Set(poolIds)]);
    for (const pool of pools) {
      result.set(pool.id, {
        capability: storagePoolCapability(
          pool.resize_family as StoragePoolResizeFamily,
          pool.quota_effective,
          pool.block_filesystem,
        ),
        poolName: poolLabel(pool.display_name, pool.incus_name),
      });
    }
    return result;
  }

  private async attachmentSummariesByVolumeIds(
    volumeIds: readonly string[],
  ): Promise<Map<string, VolumeAttachmentSummaryDto[]>> {
    const ids = [...new Set(volumeIds)];
    const result = new Map<string, VolumeAttachmentSummaryDto[]>();
    if (ids.length === 0) return result;
    const rows = await this.repository.listAttachmentSummaryRows(ids);
    for (const row of rows) {
      const list = result.get(row.volume_id) ?? [];
      list.push({
        attachmentId: row.id,
        containerId: row.container_id,
        containerName: row.name,
        containerPath: row.container_path,
        bindState: row.bind_state as VolumeAttachmentSummaryDto['bindState'],
      });
      result.set(row.volume_id, list);
    }
    return result;
  }

  async toVolumeDtos(
    rows: readonly VolumeRow[],
  ): Promise<VolumeDto[]> {
    if (rows.length === 0) return [];
    const descriptors = await this.poolDescriptors(
      rows.flatMap((row) => row.pool_id ? [row.pool_id] : []),
    );
    const attachments = await this.attachmentSummariesByVolumeIds(rows.map((row) => row.id));
    return rows.map((row) => toDto(
      row,
      row.pool_id ? descriptors.get(row.pool_id) : undefined,
      attachments.get(row.id) ?? [],
    ));
  }

  private async sharedBackendDescriptors(
    backendIds: readonly string[],
  ): Promise<Map<string, SharedVolumeDescriptor>> {
    const ids = [...new Set(backendIds)];
    const result = new Map<string, SharedVolumeDescriptor>();
    if (ids.length === 0) return result;
    const backends = await this.database
      .selectFrom('infra.shared_backends')
      .select(['id', 'name', 'display_name'])
      .where('id', 'in', ids)
      .execute();
    const pools = await this.pools.listRegisteredSharedPools({ backendIds: ids });
    const quotaByBackend = new Map<string, boolean>();
    for (const pool of pools) {
      if (!pool.shared_backend_id) continue;
      if (pool.quota_effective === true) quotaByBackend.set(pool.shared_backend_id, true);
      else if (!quotaByBackend.has(pool.shared_backend_id)) {
        quotaByBackend.set(pool.shared_backend_id, false);
      }
    }
    for (const backend of backends) {
      const hasPool = quotaByBackend.has(backend.id);
      const quotaEffective = hasPool ? quotaByBackend.get(backend.id) === true : true;
      result.set(backend.id, {
        name: poolLabel(backend.display_name, backend.name),
        capability: storagePoolCapability(StoragePoolResizeFamily.QuotaOnline, quotaEffective),
      });
    }
    return result;
  }

  async toSharedVolumeDtos(
    rows: readonly VolumeRow[],
  ): Promise<SharedVolumeDto[]> {
    if (rows.length === 0) return [];
    const backends = await this.sharedBackendDescriptors(
      rows.flatMap((row) => row.shared_backend_id ? [row.shared_backend_id] : []),
    );
    const attachments = await this.attachmentSummariesByVolumeIds(rows.map((row) => row.id));
    return rows.map((row) => toSharedDto(
      row,
      row.shared_backend_id ? backends.get(row.shared_backend_id) : undefined,
      attachments.get(row.id) ?? [],
    ));
  }

  async listAttachmentDtos(
    containerId: string,
    serverId: string,
    kind: VolumeKind,
  ): Promise<VolumeAttachmentDto[]> {
    const rows = await this.repository.listContainerAttachmentRows(containerId, serverId);
    const filtered = rows.filter((row) => (
      kind === 'shared' ? row.shared_backend_id !== null : row.shared_backend_id === null
    ));
    return filtered.map((row) => toAttachmentDto(row, row.volume_name, {
      kind,
      catalogState: row.catalog_state,
    }));
  }
}
