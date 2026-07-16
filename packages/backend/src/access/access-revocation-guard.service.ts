import { ConflictException, Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';

export interface UserServerAccess {
  userId: string;
  serverId: string;
}

export interface ExactMountSource {
  sourceKind: 'local' | 'remote';
  sourceId: string;
  serverId: string | null;
  sourceIdentity: string | null;
}

@Injectable()
export class AccessRevocationGuardService {
  async assertServerAccessRevocationSafe(
    manager: EntityManager,
    affected: readonly UserServerAccess[],
  ): Promise<void> {
    const unique = new Map(affected.map((entry) => [`${entry.userId}\0${entry.serverId}`, entry]));
    for (const { userId, serverId } of unique.values()) {
      if (await this.hasEffectiveServerGrant(manager, userId, serverId)) continue;
      const [container, localDataDir, remoteDataDirs, mount] = await Promise.all([
        manager.findOneBy(ContainerEntity, { ownerId: userId, serverId }),
        manager.findOneBy(DataDirectoryEntity, {
          userId,
          serverId,
          sourceKind: 'local',
        }),
        manager.find(DataDirectoryEntity, {
          where: { userId, sourceKind: 'remote' },
          select: { sourceId: true },
        }),
        manager.findOneBy(ContainerMountEntity, { userId, serverId }),
      ]);
      const activeRemoteDataDir = remoteDataDirs.length > 0
        ? await manager.findOneBy(RemoteFsServerAssignmentEntity, {
            serverId,
            remoteFsMountId: In(remoteDataDirs.map((row) => row.sourceId)),
            desiredState: 'active',
          })
        : null;
      if (!container && !localDataDir && !activeRemoteDataDir && !mount) continue;
      throw new ConflictException({
        code: 'ACCESS_REVOKE_HAS_RESOURCES',
        message: `User ${userId} still owns resources on server ${serverId}`,
        userId,
        serverId,
      });
    }
  }

  async assertMountSourceRevocationSafe(
    manager: EntityManager,
    userIds: readonly string[],
    source: ExactMountSource,
  ): Promise<void> {
    for (const userId of new Set(userIds)) {
      if (await this.hasExactMountGrant(manager, userId, source)) continue;
      const dataDirWhere = source.sourceKind === 'local'
        ? {
            userId,
            sourceKind: 'local' as const,
            sourceId: source.sourceId,
            serverId: source.serverId!,
            sourceIdentity: source.sourceIdentity!,
          }
        : {
            userId,
            sourceKind: 'remote' as const,
            sourceId: source.sourceId,
          };
      const [dataDirs, mount] = await Promise.all([
        manager.find(DataDirectoryEntity, { where: dataDirWhere }),
        manager.findOneBy(ContainerMountEntity, source.sourceKind === 'local'
          ? {
              userId,
              sourceKind: 'local',
              sourceId: source.sourceId,
              serverId: source.serverId!,
              sourceIdentity: source.sourceIdentity!,
            }
          : {
              userId,
              sourceKind: 'remote',
              sourceId: source.sourceId,
            }),
      ]);
      const dataDir = dataDirs[0] ?? null;
      if (!dataDir && !mount) continue;
      throw new ConflictException({
        code: 'ACCESS_REVOKE_HAS_RESOURCES',
        message: `User ${userId} still owns resources on mount source ${source.sourceId}`,
        userId,
        ...source,
      });
    }
  }

  private async hasEffectiveServerGrant(
    manager: EntityManager,
    userId: string,
    serverId: string,
  ): Promise<boolean> {
    if (await manager.findOneBy(ServerGrantEntity, {
      scope: 'user',
      scopeId: userId,
      serverId,
    })) return true;
    const memberships = await manager.find(GroupMemberEntity, { where: { userId } });
    if (memberships.length === 0) return false;
    return await manager.count(ServerGrantEntity, {
      where: {
        scope: 'group',
        scopeId: In(memberships.map((membership) => membership.groupId)),
        serverId,
      },
    }) > 0;
  }

  private async hasExactMountGrant(
    manager: EntityManager,
    userId: string,
    source: ExactMountSource,
  ): Promise<boolean> {
    const memberships = await manager.find(GroupMemberEntity, { where: { userId } });
    const scopes = [
      { scope: 'user' as const, scopeId: userId },
      ...memberships.map((membership) => ({
        scope: 'group' as const,
        scopeId: membership.groupId,
      })),
    ];
    for (const scope of scopes) {
      const where = source.sourceKind === 'local'
        ? {
            ...scope,
            sourceKind: 'local' as const,
            sourceId: source.sourceId,
            serverId: source.serverId!,
            sourceIdentity: source.sourceIdentity!,
          }
        : {
            ...scope,
            sourceKind: 'remote' as const,
            sourceId: source.sourceId,
          };
      if (await manager.findOneBy(MountSourceGrantEntity, where)) return true;
    }
    return false;
  }
}
