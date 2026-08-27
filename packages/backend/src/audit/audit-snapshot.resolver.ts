import { Injectable } from '@nestjs/common';
import type { AuditResourceSnapshotDto } from '@nyabase/common';
import type { AuditExecutor } from './audit.repository.js';

export const AUDIT_SNAPSHOT_RESOLVER = Symbol('AUDIT_SNAPSHOT_RESOLVER');

export interface AuditSnapshotResolver {
  resolve(
    executor: AuditExecutor,
    rawType: string | null,
    id: string | null,
    payload?: unknown,
  ): Promise<AuditResourceSnapshotDto | null>;
}

@Injectable()
export class PgAuditSnapshotResolver implements AuditSnapshotResolver {
  async resolve(
    executor: AuditExecutor,
    rawType: string | null,
    id: string | null,
    payload?: unknown,
  ): Promise<AuditResourceSnapshotDto | null> {
    if (!id) return null;
    try {
      switch (normalizeResourceType(rawType)) {
        case 'user': return this.user(executor, id);
        case 'group': return this.group(executor, id);
        case 'server': return this.server(executor, id);
        case 'image': return this.image(executor, id);
        case 'container': return this.container(executor, id);
        case 'storage_pool': return this.storagePool(executor, id);
        case 'shared_backend': return this.sharedBackend(executor, id);
        case 'volume': return this.volume(executor, id);
        default: return fallbackSnapshot(rawType, id, payload);
      }
    } catch {
      return fallbackSnapshot(rawType, id, payload);
    }
  }

  private async user(executor: AuditExecutor, id: string) {
    const row = await executor.selectFrom('iam.users')
      .select(['username', 'display_name', 'status', 'numeric_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? snapshot(id, 'user', row.display_name || row.username, {
      username: row.username,
      displayName: row.display_name,
      status: row.status,
      numericId: row.numeric_id,
    }) : null;
  }

  private async group(executor: AuditExecutor, id: string) {
    const row = await executor.selectFrom('iam.groups')
      .select(['name', 'description', 'priority', 'is_system'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? snapshot(id, 'group', row.name, {
      description: row.description,
      priority: row.priority,
      isSystem: row.is_system,
    }) : null;
  }

  private async server(executor: AuditExecutor, id: string) {
    const row = await executor.selectFrom('infra.servers')
      .select(['name', 'slug', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? snapshot(id, 'server', row.name, { slug: row.slug, status: row.status }) : null;
  }

  private async image(executor: AuditExecutor, id: string) {
    const row = await executor.selectFrom('infra.images')
      .select(['name', 'alias', 'fingerprint', 'is_active', 'description'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? snapshot(id, 'image', row.name, {
      alias: row.alias,
      fingerprint: row.fingerprint,
      isActive: row.is_active,
      description: row.description,
    }) : null;
  }

  private async container(executor: AuditExecutor, id: string) {
    const row = await executor.selectFrom('control.containers')
      .select(['name', 'server_id', 'owner_id', 'image_id', 'created_by'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? snapshot(id, 'container', row.name, {
      serverId: row.server_id,
      ownerId: row.owner_id,
      imageId: row.image_id,
      createdBy: row.created_by,
    }) : null;
  }

  private async storagePool(executor: AuditExecutor, id: string) {
    const row = await executor.selectFrom('infra.storage_pools')
      .select(['incus_name', 'display_name', 'server_id', 'driver', 'registered'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? snapshot(id, 'storage_pool', row.display_name || row.incus_name, {
      incusName: row.incus_name,
      serverId: row.server_id,
      driver: row.driver,
      registered: row.registered,
    }) : null;
  }

  private async sharedBackend(executor: AuditExecutor, id: string) {
    const row = await executor.selectFrom('infra.shared_backends')
      .select(['name', 'identity_key', 'ceph_fsid'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? snapshot(id, 'shared_backend', row.name, {
      identityKey: row.identity_key,
      cephFsid: row.ceph_fsid,
    }) : null;
  }

  private async volume(executor: AuditExecutor, id: string) {
    const row = await executor.selectFrom('control.volumes')
      .select(['name', 'owner_id', 'server_id', 'pool_id', 'shared_backend_id', 'size_bytes'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? snapshot(id, 'volume', row.name, {
      ownerId: row.owner_id,
      serverId: row.server_id,
      poolId: row.pool_id,
      sharedBackendId: row.shared_backend_id,
      sizeBytes: Number(row.size_bytes),
    }) : null;
  }
}

function snapshot(
  id: string,
  type: string,
  name: string,
  labels: Record<string, string | number | boolean | null>,
): AuditResourceSnapshotDto {
  return { id, type, name, labels };
}

export function normalizeResourceType(type: string | null | undefined): string | null {
  if (!type) return null;
  const normalized = type.trim().toLowerCase();
  if (normalized === 'users' || normalized === 'account') return 'user';
  if (normalized === 'groups') return 'group';
  if (normalized === 'servers') return 'server';
  if (normalized === 'images') return 'image';
  if (normalized === 'containers') return 'container';
  if (normalized === 'storage-pools' || normalized === 'storagepools') return 'storage_pool';
  if (normalized === 'shared-backends' || normalized === 'sharedbackends') return 'shared_backend';
  if (normalized === 'volumes') return 'volume';
  return normalized;
}

export function fallbackSnapshot(
  type: string | null | undefined,
  id: string,
  payload?: unknown,
): AuditResourceSnapshotDto {
  return {
    id,
    type: normalizeResourceType(type) ?? type ?? null,
    name: fallbackNameFromPayload(payload),
  };
}

export function fallbackNameFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const key of ['displayName', 'name', 'username', 'label']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
