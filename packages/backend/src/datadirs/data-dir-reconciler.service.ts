import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDirRuntimeObservationEntity } from '../entities/data-dir-runtime-observation.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { DataDirIssueDto } from '@nyabase/common';

@Injectable()
export class DataDirReconcilerService {
  private readonly logger = new Logger(DataDirReconcilerService.name);

  constructor(
    @InjectRepository(DataDirectoryEntity)
    private dataDirRepo: Repository<DataDirectoryEntity>,
    @InjectRepository(DataDirRuntimeObservationEntity)
    private observationsRepo: Repository<DataDirRuntimeObservationEntity>,
    @InjectRepository(DataDiskEntity)
    private diskRepo: Repository<DataDiskEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private assignmentRepo: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsMountRepo: Repository<RemoteFsMountEntity>,
  ) {}

  async reconcile(serverId: string): Promise<void> {
    try {
      const expected = await this.loadExpected(serverId);
      const reported = await this.loadLatestReported(serverId);

      const reportedKeys = new Set(reported.map((d) => `${d.sourceKind}|${d.sourceId}|${d.name}`));
      const expectedKeys = new Set(expected.map((d) => `${d.sourceKind}|${d.sourceId}|${d.name}`));

      const orphans = reported.filter((d) => !expectedKeys.has(`${d.sourceKind}|${d.sourceId}|${d.name}`));
      const missing = expected.filter((d) => !reportedKeys.has(`${d.sourceKind}|${d.sourceId}|${d.name}`));

      await Promise.all([
        ...reported.map((row) => {
          const key = `${row.sourceKind}|${row.sourceId}|${row.name}`;
          return this.observationsRepo.update(row.id, {
            issueKind: expectedKeys.has(key) ? null : 'orphan',
          });
        }),
        ...missing.map(async (dir) => {
          const reportSeq = await this.nextReportSeq(serverId);
          await this.observationsRepo.save(this.observationsRepo.create({
            id: uuidv4(),
            serverId,
            dataDirId: dir.dataDirId,
            sourceKind: dir.sourceKind,
            sourceId: dir.sourceId,
            name: dir.name,
            hostPath: dir.hostPath,
            userId: dir.userId,
            reportSeq,
            present: false,
            issueKind: 'missing',
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
            missingSince: new Date(),
            stale: false,
            lastError: null,
          }));
        }),
      ]);

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
    const rows = await this.observationsRepo.find({
      order: {
        serverId: 'ASC',
        sourceKind: 'ASC',
        sourceId: 'ASC',
        name: 'ASC',
        reportSeq: 'DESC',
        lastSeenAt: 'DESC',
      },
    });
    const latest = new Map<string, DataDirRuntimeObservationEntity>();
    for (const row of rows) {
      if (row.stale) continue;
      const key = `${row.serverId}|${row.sourceKind}|${row.sourceId}|${row.name}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    return [...latest.values()]
      .filter((row) => row.issueKind === 'missing' || row.issueKind === 'orphan')
      .filter((row) => sourceKind === undefined || row.sourceKind === sourceKind)
      .filter((row) => sourceId === undefined || row.sourceId === sourceId)
      .map((row) => ({
        kind: row.issueKind as 'missing' | 'orphan',
        serverId: row.serverId,
        entry: {
          sourceKind: row.sourceKind,
          sourceId: row.sourceId,
          name: row.name,
          hostPath: row.hostPath ?? '',
          ...(row.userId ? { userId: row.userId } : {}),
        },
      }));
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

  private async loadLatestReported(serverId: string): Promise<DataDirRuntimeObservationEntity[]> {
    const rows = await this.observationsRepo.find({
      where: { serverId },
      order: {
        sourceKind: 'ASC',
        sourceId: 'ASC',
        name: 'ASC',
        reportSeq: 'DESC',
        lastSeenAt: 'DESC',
      },
    });
    const latest = new Map<string, DataDirRuntimeObservationEntity>();
    for (const row of rows) {
      if (!row.present || row.stale) continue;
      const key = `${row.sourceKind}|${row.sourceId}|${row.name}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    return [...latest.values()];
  }

  private async nextReportSeq(serverId: string): Promise<number> {
    const raw = await this.observationsRepo
      .createQueryBuilder('observation')
      .select('MAX(observation.reportSeq)', 'max')
      .where('observation.serverId = :serverId', { serverId })
      .getRawOne<{ max: number | string | null }>();
    return Number(raw?.max ?? 0) + 1;
  }
}
