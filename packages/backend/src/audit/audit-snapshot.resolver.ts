import { Injectable } from '@nestjs/common';
import type { AuditResourceSnapshotDto } from '@nyabase/common';
import { validate as isUuid } from 'uuid';
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

/**
 * Resolves every durable control-plane resource from the caller's PostgreSQL
 * executor. When Audit append participates in a domain transaction this keeps
 * the resource mutation and its immutable snapshot on one visibility boundary.
 */
@Injectable()
export class PgAuditSnapshotResolver implements AuditSnapshotResolver {
  async resolve(
    executor: AuditExecutor,
    rawType: string | null,
    id: string | null,
    payload?: unknown,
  ): Promise<AuditResourceSnapshotDto | null> {
    if (!id) return null;
    const type = normalizeResourceType(rawType);
    try {
      switch (type) {
        case 'user':
          return await this.userSnapshot(executor, id);
        case 'group':
          return await this.groupSnapshot(executor, id);
        case 'server':
          return await this.serverSnapshot(executor, id);
        case 'image':
          return await this.imageSnapshot(executor, id);
        case 'container':
          return await this.containerSnapshot(executor, id);
        case 'remote_fs_mount':
          return await this.remoteFsSnapshot(executor, id);
        case 'datadir':
          return await this.dataDirectorySnapshot(executor, id);
        case 'mount_source':
          return await this.mountSourceSnapshot(executor, id, payload);
        case 'data_disk':
          return fallbackSnapshot('mount_source', id, payload);
        default:
          return fallbackSnapshot(rawType, id, payload);
      }
    } catch {
      return fallbackSnapshot(rawType, id, payload);
    }
  }

  private async containerSnapshot(
    executor: AuditExecutor,
    id: string,
  ): Promise<AuditResourceSnapshotDto | null> {
    const container = await executor
      .selectFrom('control.containers')
      .select(['name', 'server_id', 'owner_id', 'image_id', 'created_by'])
      .where('id', '=', id)
      .executeTakeFirst();
    return container
      ? {
            id,
            type: 'container',
            name: container.name,
            labels: {
              serverId: container.server_id,
              ownerId: container.owner_id,
              imageId: container.image_id,
              createdBy: container.created_by,
            },
          }
      : null;
  }

  private async remoteFsSnapshot(
    executor: AuditExecutor,
    id: string,
  ): Promise<AuditResourceSnapshotDto | null> {
    const mount = await executor
      .selectFrom('infra.remote_fs_mounts')
      .select([
        'name',
        'display_name',
        'type',
        'host_mount_point',
        'desired_state',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    return mount
      ? {
            id,
            type: 'remote_fs_mount',
            name: mount.display_name?.trim() || mount.name,
            labels: {
              name: mount.name,
              displayName: mount.display_name,
              type: mount.type,
              hostMountPoint: mount.host_mount_point,
              desiredState: mount.desired_state,
            },
          }
      : null;
  }

  private async dataDirectorySnapshot(
    executor: AuditExecutor,
    id: string,
  ): Promise<AuditResourceSnapshotDto | null> {
    const directory = await executor
      .selectFrom('control.data_directories')
      .select([
        'name',
        'user_id',
        'source_kind',
        'source_id',
        'server_id',
        'desired_state',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    return directory
      ? {
            id,
            type: 'datadir',
            name: directory.name,
            labels: {
              userId: directory.user_id,
              sourceKind: directory.source_kind,
              sourceId: directory.source_id,
              serverId: directory.server_id,
              desiredState: directory.desired_state,
            },
          }
      : null;
  }

  private async userSnapshot(
    executor: AuditExecutor,
    id: string,
  ): Promise<AuditResourceSnapshotDto | null> {
    const user = await executor
      .selectFrom('iam.users')
      .select(['username', 'display_name', 'status', 'numeric_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!user) return null;
    return {
      id,
      type: 'user',
      name: user.display_name && user.display_name !== user.username
        ? `${user.display_name} (${user.username})`
        : user.username,
      labels: {
        username: user.username,
        displayName: user.display_name,
        status: user.status,
        numericId: user.numeric_id,
      },
    };
  }

  private async serverSnapshot(
    executor: AuditExecutor,
    id: string,
  ): Promise<AuditResourceSnapshotDto | null> {
    const server = await executor
      .selectFrom('infra.servers')
      .select(['name', 'slug', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    return server ? {
      id,
      type: 'server',
      name: server.name,
      labels: { slug: server.slug, status: server.status },
    } : null;
  }

  private async imageSnapshot(
    executor: AuditExecutor,
    id: string,
  ): Promise<AuditResourceSnapshotDto | null> {
    const image = await executor
      .selectFrom('infra.images')
      .select(['name', 'docker_image', 'is_active', 'description'])
      .where('id', '=', id)
      .executeTakeFirst();
    return image ? {
      id,
      type: 'image',
      name: image.name,
      labels: {
        dockerImage: image.docker_image,
        isActive: image.is_active,
        description: image.description,
      },
    } : null;
  }

  private async groupSnapshot(
    executor: AuditExecutor,
    id: string,
  ): Promise<AuditResourceSnapshotDto | null> {
    const group = await executor
      .selectFrom('iam.groups')
      .select(['name', 'description', 'priority', 'is_system'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!group) return null;
    return {
      id,
      type: 'group',
      name: group.name,
      labels: {
        description: group.description,
        priority: group.priority,
        isSystem: group.is_system,
      },
    };
  }

  private async mountSourceSnapshot(
    executor: AuditExecutor,
    id: string,
    payload: unknown,
  ): Promise<AuditResourceSnapshotDto | null> {
    // Mount-source audit targets are intentionally polymorphic: grant upserts
    // use the UUID grant id, while deletes use the source's natural id. Avoid
    // comparing a non-UUID disk id with PostgreSQL's UUID grant primary key;
    // catching that database error would still leave the caller transaction
    // aborted.
    const grant = isUuid(id)
      ? await executor
          .selectFrom('iam.mount_source_grants')
          .select(['id', 'user_id', 'group_id', 'source_kind', 'source_id'])
          .where('id', '=', id)
          .executeTakeFirst()
      : undefined;
    if (grant) {
      const scope = grant.user_id
        ? { type: 'user', id: grant.user_id }
        : { type: 'group', id: grant.group_id! };
      const source = await this.sourceSnapshot(
        executor,
        grant.source_kind,
        grant.source_id,
      );
      const scopeSnapshot = await this.resolve(executor, scope.type, scope.id);
      return {
        id: grant.id,
        type: 'mount_source_grant',
        name: `${scopeSnapshot?.name ?? scope.id} -> ${source?.name ?? grant.source_id}`,
        labels: {
          scope: scope.type,
          scopeId: scope.id,
          sourceKind: grant.source_kind,
          sourceId: grant.source_id,
        },
      };
    }

    if (isRecord(payload)) {
      const sourceKind = stringValue(payload.sourceKind);
      const sourceId = stringValue(payload.sourceId) ?? id;
      const source = await this.sourceSnapshot(executor, sourceKind, sourceId);
      if (source) return source;
    }
    return fallbackSnapshot('mount_source', id, payload);
  }

  private sourceSnapshot(
    executor: AuditExecutor,
    sourceKind: string | null,
    sourceId: string,
  ): Promise<AuditResourceSnapshotDto | null> {
    if (sourceKind === 'remote') {
      return this.resolve(executor, 'remote_fs_mount', sourceId);
    }
    return Promise.resolve(fallbackSnapshot('mount_source', sourceId));
  }

}

export function normalizeResourceType(
  type: string | null | undefined,
): string | null {
  if (!type) return null;
  const normalized = type.trim().toLowerCase();
  if (['users', 'account'].includes(normalized)) return 'user';
  if (normalized === 'groups') return 'group';
  if (normalized === 'servers') return 'server';
  if (normalized === 'images') return 'image';
  if (normalized === 'containers') return 'container';
  if (
    ['remote_fs', 'remote_fs_mount', 'remote-fs', 'remotefsmount']
      .includes(normalized)
  ) return 'remote_fs_mount';
  if (['disk', 'data_disk', 'data-disk'].includes(normalized)) return 'data_disk';
  if (['data_dir', 'data-directory', 'datadir'].includes(normalized)) return 'datadir';
  if (
    ['mount_source', 'mount-source', 'mount_source_grant'].includes(normalized)
  ) return 'mount_source';
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
  for (
    const key of [
      'displayName',
      'name',
      'username',
      'label',
      'mountPoint',
      'hostMountPoint',
    ]
  ) {
    const value = stringValue(payload[key]);
    if (value) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
