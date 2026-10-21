import {
  StoragePoolResizeFamily,
  type SharedVolumeDto,
  type VolumeAttachmentDto,
  type VolumeAttachmentSummaryDto,
  type VolumeDto,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { poolLabel } from '../platform/domain-utils.js';
import type { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { storagePoolCapability } from '../storage-pools/storage-pool-capability.js';
import type { VolumesRepository } from './volumes.repository.js';
import {
  toAttachmentDto,
  toDto,
  toSharedDto,
  type LocalVolumeDescriptor,
  type SharedVolumeDescriptor,
  type VolumeRow,
} from './volume-dtos.js';
import type { VolumeKind } from './volume-access.js';

/** What the read model needs to turn volume rows into DTOs. */
export interface VolumeDeps {
  readonly database: Kysely<NyabaseDatabase>;
  readonly repository: VolumesRepository;
  readonly pools: StoragePoolsRepository;
}

async function poolDescriptors(
  deps: VolumeDeps,
  poolIds: readonly string[],
): Promise<Map<string, LocalVolumeDescriptor>> {
  const result = new Map<string, LocalVolumeDescriptor>();
  const pools = await deps.pools.listByIds([...new Set(poolIds)]);
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

async function attachmentSummariesByVolumeIds(
  deps: VolumeDeps,
  volumeIds: readonly string[],
): Promise<Map<string, VolumeAttachmentSummaryDto[]>> {
  const ids = [...new Set(volumeIds)];
  const result = new Map<string, VolumeAttachmentSummaryDto[]>();
  if (ids.length === 0) return result;
  const rows = await deps.repository.listAttachmentSummaryRows(ids);
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

export async function toVolumeDtos(
  deps: VolumeDeps,
  rows: readonly VolumeRow[],
): Promise<VolumeDto[]> {
  if (rows.length === 0) return [];
  const descriptors = await poolDescriptors(
    deps,
    rows.flatMap((row) => row.pool_id ? [row.pool_id] : []),
  );
  const attachments = await attachmentSummariesByVolumeIds(deps, rows.map((row) => row.id));
  return rows.map((row) => toDto(
    row,
    row.pool_id ? descriptors.get(row.pool_id) : undefined,
    attachments.get(row.id) ?? [],
  ));
}

async function sharedBackendDescriptors(
  deps: VolumeDeps,
  backendIds: readonly string[],
): Promise<Map<string, SharedVolumeDescriptor>> {
  const ids = [...new Set(backendIds)];
  const result = new Map<string, SharedVolumeDescriptor>();
  if (ids.length === 0) return result;
  const backends = await deps.database
    .selectFrom('infra.shared_backends')
    .select(['id', 'name', 'display_name'])
    .where('id', 'in', ids)
    .execute();
  const pools = await deps.pools.listRegisteredSharedPools({ backendIds: ids });
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

export async function toSharedVolumeDtos(
  deps: VolumeDeps,
  rows: readonly VolumeRow[],
): Promise<SharedVolumeDto[]> {
  if (rows.length === 0) return [];
  const backends = await sharedBackendDescriptors(
    deps,
    rows.flatMap((row) => row.shared_backend_id ? [row.shared_backend_id] : []),
  );
  const attachments = await attachmentSummariesByVolumeIds(deps, rows.map((row) => row.id));
  return rows.map((row) => toSharedDto(
    row,
    row.shared_backend_id ? backends.get(row.shared_backend_id) : undefined,
    attachments.get(row.id) ?? [],
  ));
}

export async function listAttachmentDtos(
  deps: Pick<VolumeDeps, 'repository'>,
  containerId: string,
  serverId: string,
  kind: VolumeKind,
): Promise<VolumeAttachmentDto[]> {
  const rows = await deps.repository.listContainerAttachmentRows(containerId, serverId);
  const filtered = rows.filter((row) => (
    kind === 'shared' ? row.shared_backend_id !== null : row.shared_backend_id === null
  ));
  return filtered.map((row) => toAttachmentDto(row, row.volume_name, {
    kind,
    catalogState: row.catalog_state,
  }));
}
