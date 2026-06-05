import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { DataDirEntry, DataDirIssueDto } from '@nyabase/common';
import { AgentGateway } from '../gateway/agent-gateway.js';

@Injectable()
export class DataDirReconcilerService {
  private readonly logger = new Logger(DataDirReconcilerService.name);

  constructor(
    @InjectRepository(DataDirectoryEntity)
    private dataDirRepo: Repository<DataDirectoryEntity>,
    @InjectRepository(DataDiskEntity)
    private diskRepo: Repository<DataDiskEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private assignmentRepo: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsMountRepo: Repository<RemoteFsMountEntity>,
    @Inject(forwardRef(() => AgentGateway))
    private agentGateway: AgentGateway,
  ) {}

  async reconcile(serverId: string): Promise<void> {
    try {
      const expected = await this.loadExpected(serverId);
      const reported = this.agentGateway.stateCache.getDataDirs(serverId);

      const reportedKeys = new Set(reported.map((d) => `${d.sourceKind}|${d.sourceId}|${d.name}`));
      const expectedKeys = new Set(expected.map((d) => `${d.sourceKind}|${d.sourceId}|${d.name}`));

      const orphans = reported.filter((d) => !expectedKeys.has(`${d.sourceKind}|${d.sourceId}|${d.name}`));
      const missing = expected.filter((d) => !reportedKeys.has(`${d.sourceKind}|${d.sourceId}|${d.name}`));
      this.agentGateway.stateCache.updateDataDirIssues(serverId, {
        orphans: orphans.map((entry) => this.issue('orphan', serverId, entry)),
        missing: missing.map((entry) => this.issue('missing', serverId, entry)),
      });

      if (orphans.length > 0 || missing.length > 0) {
        this.logger.warn(
          `server=${serverId} orphans=${orphans.length} missing=${missing.length}`,
        );
      }
    } catch (err) {
      this.logger.error(`reconcile failed for server=${serverId}: ${err}`);
    }
  }

  async getIssues(sourceKind?: string, sourceId?: string): Promise<DataDirIssueDto[]> {
    return this.agentGateway.stateCache.getDataDirIssues(sourceKind, sourceId);
  }

  private async loadExpected(serverId: string): Promise<Array<{
    dataDirId: string;
    sourceKind: 'local' | 'remote';
    sourceId: string;
    name: string;
    userId: string;
    hostPath: string;
  }>> {
    const results: Array<{
      dataDirId: string;
      sourceKind: 'local' | 'remote';
      sourceId: string;
      name: string;
      userId: string;
      hostPath: string;
    }> = [];

    // Local disks on this server
    const disks = await this.diskRepo.find({ where: { serverId } });
    if (disks.length > 0) {
      const diskIds = disks.map((d) => d.id);
      const mountPointMap = new Map(disks.map((d) => [d.id, d.mountPoint]));
      const localDirs = await this.dataDirRepo
        .createQueryBuilder('dd')
        .where('dd.sourceKind = :kind AND dd.sourceId IN (:...ids)', { kind: 'local', ids: diskIds })
        .getMany();
      for (const dir of localDirs) {
        const mountPoint = mountPointMap.get(dir.sourceId) ?? '';
        results.push({
          dataDirId: dir.id,
          sourceKind: 'local',
          sourceId: dir.sourceId,
          name: dir.name,
          userId: dir.userId,
          hostPath: `${mountPoint}/${dir.name}`,
        });
      }
    }

    // Remote FS mounts assigned to this server
    const assignments = await this.assignmentRepo.find({ where: { serverId } });
    if (assignments.length > 0) {
      const remoteIds = assignments.map((a) => a.remoteFsMountId);
      const mounts = await this.remoteFsMountRepo.find({ where: { id: In(remoteIds) } });
      const hostMountPointMap = new Map(mounts.map((m) => [m.id, m.hostMountPoint]));

      const remoteDirs = await this.dataDirRepo
        .createQueryBuilder('dd')
        .where('dd.sourceKind = :kind AND dd.sourceId IN (:...ids)', { kind: 'remote', ids: remoteIds })
        .getMany();
      for (const dir of remoteDirs) {
        const hostMountPoint = hostMountPointMap.get(dir.sourceId) ?? '';
        results.push({
          dataDirId: dir.id,
          sourceKind: 'remote',
          sourceId: dir.sourceId,
          name: dir.name,
          userId: dir.userId,
          hostPath: `${hostMountPoint}/${dir.name}`,
        });
      }
    }

    return results;
  }

  private issue(kind: 'missing' | 'orphan', serverId: string, entry: DataDirEntry & { userId?: string }): DataDirIssueDto {
    return {
      kind,
      serverId,
      entry: {
        sourceKind: entry.sourceKind,
        sourceId: entry.sourceId,
        name: entry.name,
        hostPath: entry.hostPath,
        ...(entry.userId ? { userId: entry.userId } : {}),
      },
    };
  }
}
