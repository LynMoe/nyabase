import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { MountSourceGrantRecord } from '../domain/domain-records.js';
import { AccessResolverService, MountSourceRef } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  Capability,
  MAX_MOUNT_SOURCE_GRANTS_PER_SCOPE,
  MountSourceDto,
  MountSourceGrantDto,
} from '@nyabase/common';
import { sql } from 'kysely';
import { publicDataDiskDisplayName } from './utils.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { UserStatus } from '@nyabase/common';
import { exactLocalDisk } from './utils.js';
import {
  AccessRevocationGuardService,
  type ExactMountSource,
} from '../access/access-revocation-guard.service.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import {
  StorageRepository,
  type StorageExecutor,
} from '../storage/storage.repository.js';

export type MountSourceGrantScope = 'user' | 'group';
export type MountSourceGrantTarget =
  | { sourceKind: 'local'; sourceId: string; serverId: string }
  | { sourceKind: 'remote'; sourceId: string };

@Injectable()
export class MountSourcesService {
  constructor(
    private readonly storage: StorageRepository,
    private readonly transactions: PgTransactionManager,
    private accessResolver: AccessResolverService,
    private auditService: AuditService,
    private agentGateway: AgentGateway,
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
    const grants = await this.storage.listMountSourceGrantsForTarget(target);
    return grants.map((g) => this.grantToDto(g));
  }

  async listGrantsForScope(
    scope: MountSourceGrantScope,
    scopeId: string,
  ): Promise<MountSourceGrantDto[]> {
    const grants = await this.storage.listMountSourceGrantsForScope(scope, scopeId);
    return grants.map((grant) => this.grantToDto(grant));
  }

  async upsertGrant(
    actorId: string,
    scope: MountSourceGrantScope,
    scopeId: string,
    target: MountSourceGrantTarget,
  ): Promise<MountSourceGrantDto> {
    const { grant } = await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageGrants],
      );
      await this.assertScopeExists(transaction, scope, scopeId);
      await sql`SELECT pg_advisory_xact_lock(
        hashtextextended(${'mount-source-grant:' + scope + ':' + scopeId}, 0)
      )`.execute(transaction);
      const sourceIdentity = await this.resolveSourceIdentity(transaction, target);
      const exact = target.sourceKind === 'local'
        ? { ...target, sourceIdentity: sourceIdentity! }
        : target;
      const existing = await this.storage.findExactMountSourceGrant(
        scope,
        scopeId,
        exact,
        transaction,
      );
      if (existing) return { grant: existing, created: false };
      const scopeGrants = await this.storage.listMountSourceGrantsForScope(
        scope,
        scopeId,
        transaction,
      );
      const replacesLocalCoordinate = target.sourceKind === 'local'
        && scopeGrants.some((grant) =>
          grant.sourceKind === 'local'
          && grant.sourceId === target.sourceId
          && grant.serverId === target.serverId);
      if (
        scopeGrants.length >= MAX_MOUNT_SOURCE_GRANTS_PER_SCOPE
        && !replacesLocalCoordinate
      ) {
        throw new ConflictException({
          code: 'MOUNT_SOURCE_GRANT_CAPACITY_REACHED',
          message:
            `At most ${MAX_MOUNT_SOURCE_GRANTS_PER_SCOPE} mount-source grants `
            + 'are supported per scope',
          scope,
          scopeId,
          maxGrants: MAX_MOUNT_SOURCE_GRANTS_PER_SCOPE,
        });
      }
      if (target.sourceKind === 'local') {
        const replaced = scopeGrants.filter((grant) =>
          grant.sourceKind === 'local'
          && grant.sourceId === target.sourceId
          && grant.serverId === target.serverId);
        const userIds = scope === 'user'
          ? [scopeId]
          : (await transaction.selectFrom('iam.group_members')
              .select('user_id')
              .where('group_id', '=', scopeId)
              .execute()).map((member) => member.user_id);
        await this.storage.deleteExactMountSourceGrants(
          scope,
          scopeId,
          target,
          transaction,
        );
        await this.revocationGuard.assertMountSourcesRevocationSafe(
          transaction,
          userIds,
          replaced.map((grant) => this.exactSource(grant)),
        );
      }
      const saved = await this.storage.insertMountSourceGrant(
        uuidv4(),
        scope,
        scopeId,
        exact,
        transaction,
      ) ?? await this.storage.findExactMountSourceGrant(
        scope,
        scopeId,
        exact,
        transaction,
      );
      if (!saved) throw new ConflictException('Mount source grant changed concurrently; retry');
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.UpsertMountSourceGrant,
        saved.id,
        'mount_source',
        { scope, scopeId, ...target, sourceIdentity: saved.sourceIdentity },
      );
      return { grant: saved, created: true };
    });
    await this.accessResolver.authorizationCommitted();
    return this.grantToDto(grant);
  }

  async deleteGrant(
    actorId: string,
    scope: MountSourceGrantScope,
    scopeId: string,
    target: MountSourceGrantTarget,
  ): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageGrants],
      );
      await this.assertScopeExists(transaction, scope, scopeId);
      const removed = await this.storage.deleteExactMountSourceGrants(
        scope,
        scopeId,
        target,
        transaction,
      );
      const userIds = scope === 'user'
        ? [scopeId]
        : (await transaction.selectFrom('iam.group_members')
            .select('user_id')
            .where('group_id', '=', scopeId)
            .execute()).map((member) => member.user_id);
      await this.revocationGuard.assertMountSourcesRevocationSafe(
        transaction,
        userIds,
        removed.map((grant) => this.exactSource(grant)),
      );
      if (removed.length > 0) {
        await this.auditService.append(
          transaction,
          actorId,
          AuditAction.DeleteMountSourceGrant,
          target.sourceId,
          'mount_source',
          { scope, scopeId, ...target },
        );
      }
      return removed.length;
    });
    await this.accessResolver.authorizationCommitted();
  }

  async deleteScopeInTransaction(
    executor: unknown,
    scope: MountSourceGrantScope,
    scopeId: string,
    options: { bypassResourceGuard?: boolean } = {},
  ): Promise<void> {
    const transaction = requireStorageExecutor(executor);
    const removed = options.bypassResourceGuard
      ? []
      : await this.storage.listMountSourceGrantsForScope(scope, scopeId, transaction);
    const userIds = options.bypassResourceGuard
      ? []
      : scope === 'user'
        ? [scopeId]
        : (await transaction.selectFrom('iam.group_members')
            .select('user_id')
            .where('group_id', '=', scopeId)
            .execute()).map((member) => member.user_id);
    await this.storage.deleteMountSourceGrantsForScope(scope, scopeId, transaction);
    await this.revocationGuard.assertMountSourcesRevocationSafe(
      transaction,
      userIds,
      removed.map((grant) => this.exactSource(grant)),
    );
  }

  async deleteSourceInTransaction(
    executor: unknown,
    target: MountSourceGrantTarget,
  ): Promise<void> {
    const transaction = requireStorageExecutor(executor);
    await this.storage.deleteMountSourceGrantsForTarget(target, transaction);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async refsToDto(serverId: string, refs: Set<MountSourceRef>): Promise<MountSourceDto[]> {
    const localIds = Array.from(refs).filter((r) => r.kind === 'local').map((r) => r.id);
    const remoteIds = Array.from(refs).filter((r) => r.kind === 'remote').map((r) => r.id);

    const remoteMounts = remoteIds.length > 0
      ? await this.storage.listRemoteFsMountsByIds(remoteIds)
      : [];

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

  private grantToDto(g: MountSourceGrantRecord): MountSourceGrantDto {
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

  private exactSource(grant: MountSourceGrantRecord): ExactMountSource {
    return {
      sourceKind: grant.sourceKind,
      sourceId: grant.sourceId,
      serverId: grant.serverId,
      sourceIdentity: grant.sourceIdentity,
    };
  }

  private async assertScopeExists(
    transaction: StorageExecutor,
    scope: MountSourceGrantScope,
    scopeId: string,
  ): Promise<void> {
    if (scope === 'group') {
      if (!await transaction.selectFrom('iam.groups')
        .select('id')
        .where('id', '=', scopeId)
        .executeTakeFirst()) {
        throw new NotFoundException('Group not found');
      }
      return;
    }
    const user = await transaction.selectFrom('iam.users')
      .select(['id', 'status'])
      .where('id', '=', scopeId)
      .executeTakeFirst();
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
    transaction: StorageExecutor,
    target: MountSourceGrantTarget,
  ): Promise<string | null> {
    if (target.sourceKind === 'remote') {
      const mount = await this.storage.lockActiveRemoteFsMount(target.sourceId, transaction);
      if (!mount) {
        throw new NotFoundException(`Remote FS mount ${target.sourceId} not found`);
      }
      return null;
    }

    if (!await transaction.selectFrom('infra.servers')
      .select('id')
      .where('id', '=', target.serverId)
      .executeTakeFirst()) {
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

function requireStorageExecutor(value: unknown): StorageExecutor {
  if (
    !value
    || typeof value !== 'object'
    || typeof (value as { selectFrom?: unknown }).selectFrom !== 'function'
    || typeof (value as { deleteFrom?: unknown }).deleteFrom !== 'function'
  ) {
    throw new Error(
      'Mount source mutations require the caller PostgreSQL/Kysely transaction',
    );
  }
  return value as StorageExecutor;
}
