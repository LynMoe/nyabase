import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AuditLogEntity } from '../entities/audit-log.entity.js';
import { AuditAction, type AuditResourceSnapshotDto } from '@nyabase/common';
import { UserEntity } from '../entities/user.entity.js';
import { GroupEntity } from '../entities/group.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

type AuditResourceSnapshot = AuditResourceSnapshotDto;

const CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH_SIZE = 1_000;
const SENSITIVE_KEY_PATTERN = /(password|passwd|token|secret|private.?key|encrypted|credential|authorization|cookie)/i;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private nextCleanupAt = 0;
  private cleanupPromise: Promise<void> | null = null;

  constructor(
    @InjectRepository(AuditLogEntity)
    private repo: Repository<AuditLogEntity>,
    private dataSource: DataSource,
    private config: NyabaseConfigService,
  ) {}

  async log(
    actorId: string | null,
    action: AuditAction,
    targetId: string | null,
    targetType: string | null,
    payload?: unknown,
  ): Promise<void> {
    const sanitizedPayload = sanitizeForAudit(payload ?? null);
    const [actorSnapshot, targetSnapshot, related] = await Promise.all([
      actorId ? this.resourceSnapshot('user', actorId, sanitizedPayload) : Promise.resolve(null),
      targetId ? this.resourceSnapshot(targetType, targetId, sanitizedPayload) : Promise.resolve(null),
      this.relatedSnapshots(targetType, targetId, sanitizedPayload),
    ]);

    await this.repo.save(
      this.repo.create({
        id: uuidv4(),
        actorId,
        actorName: actorSnapshot?.name ?? null,
        actorUsername: actorSnapshot?.labels?.username != null
          ? String(actorSnapshot.labels.username)
          : null,
        actorSnapshot,
        action,
        targetId,
        targetType,
        targetName: targetSnapshot?.name ?? fallbackNameFromPayload(sanitizedPayload),
        targetSnapshot,
        related,
        payload: sanitizedPayload,
        ts: new Date(),
      }),
    );
    await this.maybeEnforceRetention();
  }

  private async maybeEnforceRetention(): Promise<void> {
    const now = Date.now();
    if (this.cleanupPromise) return this.cleanupPromise;
    const retentionDays = this.config.get<number>('audit.retentionDays');
    const maxEntries = this.config.get<number>('audit.retentionMaxEntries');
    const enforceAge = retentionDays > 0 && now >= this.nextCleanupAt;
    const enforceCount = maxEntries > 0;
    if (!enforceAge && !enforceCount) return;
    if (enforceAge) this.nextCleanupAt = now + CLEANUP_INTERVAL_MS;

    this.cleanupPromise = this.enforceRetention({ retentionDays, maxEntries, enforceAge, enforceCount }).catch((error: unknown) => {
      this.logger.warn(`Audit retention cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.cleanupPromise = null;
    });

    await this.cleanupPromise;
  }

  private async enforceRetention({
    retentionDays,
    maxEntries,
    enforceAge,
    enforceCount,
  }: {
    retentionDays: number;
    maxEntries: number;
    enforceAge: boolean;
    enforceCount: boolean;
  }): Promise<void> {
    if (enforceAge) {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      await this.repo
        .createQueryBuilder()
        .delete()
        .where('ts < :cutoff', { cutoff })
        .execute();
    }

    if (!enforceCount) return;

    let overflow = await this.repo.count() - maxEntries;
    while (overflow > 0) {
      const batchSize = Math.min(CLEANUP_BATCH_SIZE, overflow);
      const rows = await this.repo
        .createQueryBuilder('log')
        .select('log.id', 'id')
        .orderBy('log.ts', 'ASC')
        .addOrderBy('log.id', 'ASC')
        .limit(batchSize)
        .getRawMany<{ id: string }>();

      if (rows.length === 0) return;
      await this.repo.delete(rows.map((row) => row.id));
      overflow -= rows.length;
    }
  }

  private async relatedSnapshots(
    targetType: string | null,
    targetId: string | null,
    payload: unknown,
  ): Promise<AuditResourceSnapshot[]> {
    const refs = refsFromPayload(payload);
    if (targetId && targetType) refs.unshift({ type: targetType, id: targetId });

    const snapshots: AuditResourceSnapshot[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const normalizedType = normalizeResourceType(ref.type);
      const key = `${normalizedType ?? ref.type}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const snapshot = await this.resourceSnapshot(ref.type, ref.id, payload);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  private async resourceSnapshot(
    rawType: string | null,
    id: string | null,
    payload?: unknown,
  ): Promise<AuditResourceSnapshot | null> {
    if (!id) return null;
    const type = normalizeResourceType(rawType);
    try {
      switch (type) {
        case 'user':
          return this.userSnapshot(id);
        case 'group':
          return this.groupSnapshot(id);
        case 'server':
          return this.serverSnapshot(id);
        case 'image':
          return this.imageSnapshot(id);
        case 'container':
          return this.containerSnapshot(id);
        case 'remote_fs_mount':
          return this.remoteFsMountSnapshot(id);
        case 'data_disk':
          return fallbackSnapshot('mount_source', id, payload);
        case 'datadir':
          return this.dataDirSnapshot(id);
        case 'mount_source':
          return this.mountSourceSnapshot(id, payload);
        default:
          return fallbackSnapshot(rawType, id, payload);
      }
    } catch {
      return fallbackSnapshot(rawType, id, payload);
    }
  }

  private async userSnapshot(id: string): Promise<AuditResourceSnapshot | null> {
    const user = await this.dataSource.getRepository(UserEntity).findOne({ where: { id } });
    if (!user) return null;
    return {
      id,
      type: 'user',
      name: user.displayName && user.displayName !== user.username
        ? `${user.displayName} (${user.username})`
        : user.username,
      labels: {
        username: user.username,
        displayName: user.displayName,
        status: user.status,
        numericId: user.numericId ?? null,
      },
    };
  }

  private async groupSnapshot(id: string): Promise<AuditResourceSnapshot | null> {
    const group = await this.dataSource.getRepository(GroupEntity).findOne({ where: { id } });
    if (!group) return null;
    return {
      id,
      type: 'group',
      name: group.name,
      labels: {
        description: group.description,
        priority: group.priority,
        isSystem: group.isSystem,
      },
    };
  }

  private async serverSnapshot(id: string): Promise<AuditResourceSnapshot | null> {
    const server = await this.dataSource.getRepository(ServerEntity).findOne({ where: { id } });
    if (!server) return null;
    return {
      id,
      type: 'server',
      name: server.name,
      labels: {
        slug: server.slug,
        status: server.status,
      },
    };
  }

  private async imageSnapshot(id: string): Promise<AuditResourceSnapshot | null> {
    const image = await this.dataSource.getRepository(ImageEntity).findOne({ where: { id } });
    if (!image) return null;
    return {
      id,
      type: 'image',
      name: image.name,
      labels: {
        dockerImage: image.dockerImage,
        isActive: image.isActive,
        description: image.description,
      },
    };
  }

  private async containerSnapshot(id: string): Promise<AuditResourceSnapshot | null> {
    const container = await this.dataSource.getRepository(ContainerEntity).findOne({ where: { id } });
    if (!container) return null;
    return {
      id,
      type: 'container',
      name: container.name,
      labels: {
        serverId: container.serverId,
        ownerId: container.ownerId,
        imageId: container.imageId,
        createdBy: container.createdBy,
      },
    };
  }

  private async remoteFsMountSnapshot(id: string): Promise<AuditResourceSnapshot | null> {
    const mount = await this.dataSource.getRepository(RemoteFsMountEntity).findOne({ where: { id } });
    if (!mount) return null;
    return {
      id,
      type: 'remote_fs_mount',
      name: mount.displayName?.trim() || mount.name,
      labels: {
        name: mount.name,
        displayName: mount.displayName,
        type: mount.type,
        hostMountPoint: mount.hostMountPoint,
        desiredState: mount.desiredState,
      },
    };
  }

  private async dataDirSnapshot(id: string): Promise<AuditResourceSnapshot | null> {
    const dir = await this.dataSource.getRepository(DataDirectoryEntity).findOne({ where: { id } });
    if (!dir) return null;
    return {
      id,
      type: 'datadir',
      name: dir.name,
      labels: {
        userId: dir.userId,
        sourceKind: dir.sourceKind,
        sourceId: dir.sourceId,
        serverId: dir.serverId,
        desiredState: dir.desiredState,
      },
    };
  }

  private async mountSourceSnapshot(id: string, payload: unknown): Promise<AuditResourceSnapshot | null> {
    const grant = await this.dataSource.getRepository(MountSourceGrantEntity).findOne({ where: { id } });
    if (grant) {
      const source = await this.sourceSnapshot(grant.sourceKind, grant.sourceId);
      const scope = await this.resourceSnapshot(grant.scope, grant.scopeId);
      return {
        id: grant.id,
        type: 'mount_source_grant',
        name: `${scope?.name ?? grant.scopeId} -> ${source?.name ?? grant.sourceId}`,
        labels: {
          scope: grant.scope,
          scopeId: grant.scopeId,
          sourceKind: grant.sourceKind,
          sourceId: grant.sourceId,
        },
      };
    }

    if (isRecord(payload)) {
      const sourceKind = stringValue(payload.sourceKind);
      const sourceId = stringValue(payload.sourceId) ?? id;
      const source = await this.sourceSnapshot(sourceKind, sourceId);
      if (source) return source;
    }

    return fallbackSnapshot('mount_source', id, payload);
  }

  private sourceSnapshot(sourceKind: string | null | undefined, sourceId: string): Promise<AuditResourceSnapshot | null> {
    if (sourceKind === 'local') return Promise.resolve(fallbackSnapshot('mount_source', sourceId));
    if (sourceKind === 'remote') return this.remoteFsMountSnapshot(sourceId);
    return Promise.resolve(fallbackSnapshot('mount_source', sourceId));
  }
}

function normalizeResourceType(type: string | null | undefined): string | null {
  if (!type) return null;
  const normalized = type.trim().toLowerCase();
  if (['users', 'account'].includes(normalized)) return 'user';
  if (['groups'].includes(normalized)) return 'group';
  if (['servers'].includes(normalized)) return 'server';
  if (['images'].includes(normalized)) return 'image';
  if (['containers'].includes(normalized)) return 'container';
  if (['remote_fs', 'remote_fs_mount', 'remote-fs', 'remotefsmount'].includes(normalized)) return 'remote_fs_mount';
  if (['disk', 'data_disk', 'data-disk'].includes(normalized)) return 'data_disk';
  if (['data_dir', 'data-directory', 'datadir'].includes(normalized)) return 'datadir';
  if (['mount_source', 'mount-source', 'mount_source_grant'].includes(normalized)) return 'mount_source';
  return normalized;
}

function refsFromPayload(payload: unknown): Array<{ type: string; id: string }> {
  if (!isRecord(payload)) return [];
  const refs: Array<{ type: string; id: string }> = [];
  const mappings: Array<[string, string]> = [
    ['userId', 'user'],
    ['actorId', 'user'],
    ['ownerId', 'user'],
    ['createdBy', 'user'],
    ['groupId', 'group'],
    ['serverId', 'server'],
    ['imageId', 'image'],
    ['containerId', 'container'],
    ['mountId', 'remote_fs_mount'],
    ['remoteFsMountId', 'remote_fs_mount'],
    ['diskId', 'data_disk'],
  ];

  for (const [key, type] of mappings) {
    const id = stringValue(payload[key]);
    if (id) refs.push({ type, id });
  }

  const sourceId = stringValue(payload.sourceId);
  const sourceKind = stringValue(payload.sourceKind);
  if (sourceId) {
    refs.push({
      type: sourceKind === 'local'
        ? 'data_disk'
        : sourceKind === 'remote'
          ? 'remote_fs_mount'
          : 'mount_source',
      id: sourceId,
    });
  }

  return refs;
}

function fallbackSnapshot(type: string | null | undefined, id: string, payload?: unknown): AuditResourceSnapshot {
  return {
    id,
    type: normalizeResourceType(type) ?? type ?? null,
    name: fallbackNameFromPayload(payload),
  };
}

function fallbackNameFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const key of ['displayName', 'name', 'username', 'label', 'mountPoint', 'hostMountPoint']) {
    const value = stringValue(payload[key]);
    if (value) return value;
  }
  return null;
}

function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[MaxDepth]';
  if (Array.isArray(value)) return value.map((item) => sanitizeForAudit(item, depth + 1));
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : sanitizeForAudit(child, depth + 1);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
