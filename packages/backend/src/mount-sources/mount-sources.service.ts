import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { AccessResolverService, MountSourceRef } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction, MountSourceDto, MountSourceGrantDto, MountSourceKind } from '@nyabase/common';
import { dataDiskDisplayName } from './utils.js';

@Injectable()
export class MountSourcesService {
  constructor(
    @InjectRepository(DataDiskEntity)
    private dataDisksRepo: Repository<DataDiskEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsMountsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private remoteFsAssignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(MountSourceGrantEntity)
    private mountSourceGrantsRepo: Repository<MountSourceGrantEntity>,
    private accessResolver: AccessResolverService,
    private auditService: AuditService,
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
  async listGrantsForSource(sourceKind: MountSourceKind, sourceId: string): Promise<MountSourceGrantDto[]> {
    const grants = await this.mountSourceGrantsRepo.find({ where: { sourceKind, sourceId } });
    return grants.map((g) => this.grantToDto(g));
  }

  async upsertGrant(
    actorId: string,
    sourceKind: MountSourceKind,
    sourceId: string,
    scope: 'user' | 'group',
    scopeId: string,
  ): Promise<MountSourceGrantDto> {
    await this.assertSourceExists(sourceKind, sourceId);

    let grant = await this.mountSourceGrantsRepo.findOne({
      where: { scope, scopeId, sourceKind, sourceId },
    });
    if (!grant) {
      grant = this.mountSourceGrantsRepo.create({
        id: uuidv4(),
        scope,
        scopeId,
        sourceKind,
        sourceId,
      });
      await this.mountSourceGrantsRepo.save(grant);
      await this.auditService.log(actorId, AuditAction.UpsertMountSourceGrant, grant.id, 'mount_source', {
        scope, scopeId, sourceKind, sourceId,
      });
    }
    this.accessResolver.invalidateAll();
    return this.grantToDto(grant);
  }

  async deleteGrant(
    actorId: string,
    sourceKind: MountSourceKind,
    sourceId: string,
    scope: 'user' | 'group',
    scopeId: string,
  ): Promise<void> {
    await this.mountSourceGrantsRepo.delete({ scope, scopeId, sourceKind, sourceId });
    this.accessResolver.invalidateAll();
    await this.auditService.log(actorId, AuditAction.DeleteMountSourceGrant, sourceId, 'mount_source', {
      scope, scopeId, sourceKind,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async refsToDto(serverId: string, refs: Set<MountSourceRef>): Promise<MountSourceDto[]> {
    const localIds = Array.from(refs).filter((r) => r.kind === 'local').map((r) => r.id);
    const remoteIds = Array.from(refs).filter((r) => r.kind === 'remote').map((r) => r.id);

    const [disks, remoteMounts] = await Promise.all([
      localIds.length > 0 ? this.dataDisksRepo.find({ where: { id: In(localIds) } }) : Promise.resolve([]),
      remoteIds.length > 0 ? this.remoteFsMountsRepo.find({ where: { id: In(remoteIds) } }) : Promise.resolve([]),
    ]);

    const diskMap = new Map(disks.map((d) => [d.id, d]));
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
          label: `本地 · ${dataDiskDisplayName(disk.mountPoint, disk.label)}`,
          hostRoot: disk.mountPoint,
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
          hostRoot: m.hostMountPoint,
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
      createdAt: g.createdAt.toISOString(),
    };
  }

  private async assertSourceExists(sourceKind: MountSourceKind, sourceId: string): Promise<void> {
    if (sourceKind === 'local') {
      const disk = await this.dataDisksRepo.findOne({ where: { id: sourceId } });
      if (!disk) throw new NotFoundException(`Data disk ${sourceId} not found`);
    } else {
      const mount = await this.remoteFsMountsRepo.findOne({ where: { id: sourceId } });
      if (!mount) throw new NotFoundException(`Remote FS mount ${sourceId} not found`);
    }
  }
}
