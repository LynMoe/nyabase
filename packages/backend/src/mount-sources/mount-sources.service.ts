import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { AccessResolverService, MountSourceRef } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction, Capability, MountSourceDto, MountSourceGrantDto } from '@nyabase/common';
import { publicDataDiskDisplayName } from './utils.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { postCommitBestEffort } from '../common/post-commit.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { UserStatus } from '@nyabase/common';
import { exactLocalDisk } from './utils.js';
import {
  AccessRevocationGuardService,
  type ExactMountSource,
} from '../access/access-revocation-guard.service.js';

export type MountSourceGrantScope = 'user' | 'group';
export type MountSourceGrantTarget =
  | { sourceKind: 'local'; sourceId: string; serverId: string }
  | { sourceKind: 'remote'; sourceId: string };

@Injectable()
export class MountSourcesService {
  private readonly logger = new Logger(MountSourcesService.name);

  constructor(
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsMountsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private remoteFsAssignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(MountSourceGrantEntity)
    private mountSourceGrantsRepo: Repository<MountSourceGrantEntity>,
    private accessResolver: AccessResolverService,
    private auditService: AuditService,
    private agentGateway: AgentGateway,
    private dataSource: DataSource,
    private revocationGuard: AccessRevocationGuardService,
  ) {}

  /**
   * List data sources accessible to the given user on a specific server.
   * Admins see all sources on the server; regular users see only granted ones.
   */
  async listForUser(userId: string, serverId: string): Promise<MountSourceDto[]> {
    const refs = await this.accessResolver.resolveMountSources(userId, serverId);
    return this.refsToDto(serverId, refs);
  }

  /**
   * List all grants for a specific source (admin view for the grant dialog).
   */
  async listGrantsForSource(target: MountSourceGrantTarget): Promise<MountSourceGrantDto[]> {
    const grants = await this.mountSourceGrantsRepo.find({ where: this.targetWhere(target) });
    return grants.map((g) => this.grantToDto(g));
  }

  async listGrantsForScope(
    scope: MountSourceGrantScope,
    scopeId: string,
  ): Promise<MountSourceGrantDto[]> {
    const grants = await this.mountSourceGrantsRepo.find({ where: { scope, scopeId } });
    return grants.map((grant) => this.grantToDto(grant));
  }

  async upsertGrant(
    actorId: string,
    scope: MountSourceGrantScope,
    scopeId: string,
    target: MountSourceGrantTarget,
  ): Promise<MountSourceGrantDto> {
    const { grant, created } = await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager,
        actorId,
        [Capability.ManageGrants],
      );
      await this.assertScopeExists(manager, scope, scopeId);
      const sourceIdentity = await this.resolveSourceIdentity(manager, target);
      const exact = target.sourceKind === 'local'
        ? {
            scope,
            scopeId,
            sourceKind: 'local' as const,
            sourceId: target.sourceId,
            serverId: target.serverId,
            sourceIdentity: sourceIdentity!,
          }
        : {
            scope,
            scopeId,
            sourceKind: 'remote' as const,
            sourceId: target.sourceId,
            serverId: IsNull(),
            sourceIdentity: IsNull(),
          };
      const existing = await manager.findOne(MountSourceGrantEntity, { where: exact });
      if (existing) return { grant: existing, created: false };
      if (target.sourceKind === 'local') {
        const replaced = await manager.find(MountSourceGrantEntity, {
          where: {
            scope,
            scopeId,
            sourceKind: 'local',
            sourceId: target.sourceId,
            serverId: target.serverId,
          },
        });
        const userIds = scope === 'user'
          ? [scopeId]
          : (await manager.find(GroupMemberEntity, { where: { groupId: scopeId } }))
              .map((member) => member.userId);
        await manager.delete(MountSourceGrantEntity, {
          scope,
          scopeId,
          sourceKind: 'local',
          sourceId: target.sourceId,
          serverId: target.serverId,
        });
        for (const grant of replaced) {
          await this.revocationGuard.assertMountSourceRevocationSafe(
            manager,
            userIds,
            this.exactSource(grant),
          );
        }
      }
      const saved = await manager.save(MountSourceGrantEntity, manager.create(MountSourceGrantEntity, {
        id: uuidv4(),
        scope,
        scopeId,
        sourceKind: target.sourceKind,
        sourceId: target.sourceId,
        serverId: target.sourceKind === 'local' ? target.serverId : null,
        sourceIdentity,
      }));
      return { grant: saved, created: true };
    });
    this.accessResolver.invalidateAll();
    if (created) {
      await postCommitBestEffort(
        'Mount source grant upsert audit',
        () => this.auditService.log(
          actorId,
          AuditAction.UpsertMountSourceGrant,
          grant.id,
          'mount_source',
          { scope, scopeId, ...target, sourceIdentity: grant.sourceIdentity },
        ),
        this.logger,
      );
    }
    return this.grantToDto(grant);
  }

  async deleteGrant(
    actorId: string,
    scope: MountSourceGrantScope,
    scopeId: string,
    target: MountSourceGrantTarget,
  ): Promise<void> {
    const affected = await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager,
        actorId,
        [Capability.ManageGrants],
      );
      await this.assertScopeExists(manager, scope, scopeId);
      const removed = await manager.find(MountSourceGrantEntity, {
        where: { scope, scopeId, ...this.targetWhere(target) },
      });
      const result = await manager.delete(MountSourceGrantEntity, {
        scope,
        scopeId,
        ...this.targetWhere(target),
      });
      const userIds = scope === 'user'
        ? [scopeId]
        : (await manager.find(GroupMemberEntity, { where: { groupId: scopeId } }))
            .map((member) => member.userId);
      for (const grant of removed) {
        await this.revocationGuard.assertMountSourceRevocationSafe(
          manager,
          userIds,
          this.exactSource(grant),
        );
      }
      return result.affected ?? 0;
    });
    this.accessResolver.invalidateAll();
    if (affected > 0) await postCommitBestEffort(
      'Mount source grant delete audit',
      () => this.auditService.log(
        actorId,
        AuditAction.DeleteMountSourceGrant,
        target.sourceId,
        'mount_source',
        { scope, scopeId, ...target },
      ),
      this.logger,
    );
  }

  async deleteScopeInTransaction(
    manager: EntityManager,
    scope: MountSourceGrantScope,
    scopeId: string,
    options: { bypassResourceGuard?: boolean } = {},
  ): Promise<void> {
    const removed = options.bypassResourceGuard
      ? []
      : await manager.find(MountSourceGrantEntity, { where: { scope, scopeId } });
    const userIds = options.bypassResourceGuard
      ? []
      : scope === 'user'
        ? [scopeId]
        : (await manager.find(GroupMemberEntity, { where: { groupId: scopeId } }))
            .map((member) => member.userId);
    await manager.delete(MountSourceGrantEntity, { scope, scopeId });
    for (const grant of removed) {
      await this.revocationGuard.assertMountSourceRevocationSafe(
        manager,
        userIds,
        this.exactSource(grant),
      );
    }
  }

  async deleteSourceInTransaction(
    manager: EntityManager,
    target: MountSourceGrantTarget,
  ): Promise<void> {
    await manager.delete(MountSourceGrantEntity, this.targetWhere(target));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async refsToDto(serverId: string, refs: Set<MountSourceRef>): Promise<MountSourceDto[]> {
    const localIds = Array.from(refs).filter((r) => r.kind === 'local').map((r) => r.id);
    const remoteIds = Array.from(refs).filter((r) => r.kind === 'remote').map((r) => r.id);

    const [remoteMounts] = await Promise.all([
      remoteIds.length > 0 ? this.remoteFsMountsRepo.find({ where: { id: In(remoteIds) } }) : Promise.resolve([]),
    ]);

    const wantedLocalIds = new Set(localIds);
    const diskMap = new Map(
      (this.agentGateway.stateCache.get(serverId)?.disks ?? [])
        .filter((d) => wantedLocalIds.has(d.diskId))
        .map((d) => [d.diskId, d]),
    );
    const mountMap = new Map(remoteMounts.map((m) => [m.id, m]));

    const result: MountSourceDto[] = [];
    for (const ref of refs) {
      if (ref.kind === 'local') {
        const disk = diskMap.get(ref.id);
        if (!disk) continue;
        result.push({
          kind: 'local',
          id: ref.id,
          serverId,
          label: `本地 · ${publicDataDiskDisplayName(disk.diskId, disk.label)}`,
        });
      } else {
        const m = mountMap.get(ref.id);
        if (!m) continue;
        result.push({
          kind: 'remote',
          id: ref.id,
          serverId,
          label: m.displayName?.trim() || m.name,
          description: m.description ?? undefined,
        });
      }
    }
    return result;
  }

  private grantToDto(g: MountSourceGrantEntity): MountSourceGrantDto {
    return {
      id: g.id,
      scope: g.scope,
      scopeId: g.scopeId,
      sourceKind: g.sourceKind,
      sourceId: g.sourceId,
      serverId: g.serverId,
      sourceIdentity: g.sourceIdentity,
      createdAt: g.createdAt.toISOString(),
    };
  }

  private targetWhere(target: MountSourceGrantTarget) {
    return target.sourceKind === 'local'
      ? {
          sourceKind: 'local' as const,
          sourceId: target.sourceId,
          serverId: target.serverId,
        }
      : {
          sourceKind: 'remote' as const,
          sourceId: target.sourceId,
          serverId: IsNull(),
          sourceIdentity: IsNull(),
        };
  }

  private exactSource(grant: MountSourceGrantEntity): ExactMountSource {
    return {
      sourceKind: grant.sourceKind,
      sourceId: grant.sourceId,
      serverId: grant.serverId,
      sourceIdentity: grant.sourceIdentity,
    };
  }

  private async assertScopeExists(
    manager: EntityManager,
    scope: MountSourceGrantScope,
    scopeId: string,
  ): Promise<void> {
    if (scope === 'group') {
      if (!await manager.findOneBy(GroupEntity, { id: scopeId })) {
        throw new NotFoundException('Group not found');
      }
      return;
    }
    const user = await manager.findOneBy(UserEntity, { id: scopeId });
    if (!user) throw new NotFoundException('User not found');
    if (user.status === UserStatus.Deleted) {
      throw new ConflictException({
        code: 'USER_DELETED',
        message: 'A deleted user cannot receive mount source grants',
        userId: scopeId,
      });
    }
    if (user.status !== UserStatus.Active) {
      throw new ConflictException('Mount source grants require an active user');
    }
  }

  private async resolveSourceIdentity(
    manager: EntityManager,
    target: MountSourceGrantTarget,
  ): Promise<string | null> {
    if (target.sourceKind === 'remote') {
      const mount = await manager.findOneBy(RemoteFsMountEntity, { id: target.sourceId });
      if (!mount || mount.desiredState !== 'active') {
        throw new NotFoundException(`Remote FS mount ${target.sourceId} not found`);
      }
      return null;
    }

    if (!await manager.findOneBy(ServerEntity, { id: target.serverId })) {
      throw new NotFoundException(`Server ${target.serverId} not found`);
    }
    const snapshot = this.agentGateway.stateCache.get(target.serverId);
    if (!snapshot || snapshot.serverId !== target.serverId || snapshot.helloAt === null) {
      throw new ConflictException(`Server ${target.serverId} has no authoritative Agent report`);
    }
    const disk = exactLocalDisk(snapshot.disks, target.sourceId);
    if (!disk) {
      throw new ConflictException(
        `Local disk ${target.sourceId} must have exactly one non-empty physical identity on server ${target.serverId}`,
      );
    }
    return disk.sourceIdentity;
  }
}
