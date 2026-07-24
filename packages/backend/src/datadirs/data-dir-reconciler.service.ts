import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { DataDirEntry, DataDirIssueDto, type DiskInfo } from '@nyabase/common';
import { AgentGateway } from '../gateway/agent-gateway.js';

/** A valid full report deterministically conflicts with the durable inventory model. */
export class DataDirInventoryFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataDirInventoryFaultError';
  }
}

@Injectable()
export class DataDirReconcilerService {
  constructor(
    @InjectRepository(DataDirectoryEntity)
    private dataDirRepo: Repository<DataDirectoryEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private assignmentRepo: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsMountRepo: Repository<RemoteFsMountEntity>,
    @Inject(forwardRef(() => AgentGateway))
    private agentGateway: AgentGateway,
  ) {}

  async reconcileReport(
    serverId: string,
    reported: readonly DataDirEntry[],
    disks: readonly DiskInfo[],
  ): Promise<{
    issues: { orphans: DataDirIssueDto[]; missing: DataDirIssueDto[] };
    blockingReason: string | null;
  }> {
    const expected = await this.loadExpected(serverId, disks);
    const expectedByKey = new Map(expected.map((entry) => [this.key(entry), entry]));
    if (expectedByKey.size !== expected.length) {
      throw new DataDirInventoryFaultError(
        'Durable data directory inventory contains duplicate physical identities',
      );
    }

    const observedKeys = new Set<string>();
    const orphanEntries: DataDirEntry[] = [];
    for (const entry of reported) {
      const key = this.key(entry);
      const durable = expectedByKey.get(key);
      if (!durable || durable.hostPath !== entry.hostPath) {
        orphanEntries.push(entry);
        continue;
      }
      observedKeys.add(key);
    }
    const failedEntries = expected.filter((entry) => entry.desiredState === 'failed');
    const reportedMissingEntries = expected.filter((entry) =>
      entry.reportsWhenMissing && !observedKeys.has(this.key(entry)));
    const blockingMissingEntries = reportedMissingEntries.filter((entry) =>
      entry.blocksWhenMissing);
    const missingEntries = [...reportedMissingEntries, ...failedEntries];
    const issues = {
      orphans: orphanEntries.map((entry) => this.issue('orphan', serverId, entry)),
      missing: missingEntries.map((entry) => this.issue('missing', serverId, entry)),
    };
    // A durable failed row is already unreachable from container mount
    // admission and has an ordinary delete/retry path. Keep it observable, but
    // do not quarantine the whole Agent and thereby make that repair path
    // impossible. Unknown physical entries and an active server-local promise
    // that disappeared block authoritative promotion. A shared remote entry
    // missing from one client remains visible without becoming global proof.
    const blockingCount = issues.orphans.length + blockingMissingEntries.length;
    return {
      issues,
      blockingReason: blockingCount === 0
        ? null
        : `Authoritative data directory inventory has ${issues.orphans.length} orphan and ${blockingMissingEntries.length} active-missing entries`,
    };
  }

  async getIssues(sourceKind?: string, sourceId?: string): Promise<DataDirIssueDto[]> {
    return this.agentGateway.stateCache.getDataDirIssues(sourceKind, sourceId);
  }

  private async loadExpected(serverId: string, disks: readonly DiskInfo[]): Promise<Array<{
    resourceId: string;
    sourceKind: 'local' | 'remote';
    sourceId: string;
    name: string;
    userId: string;
    hostPath: string;
    desiredState: DataDirectoryEntity['desiredState'];
    reportsWhenMissing: boolean;
    blocksWhenMissing: boolean;
  }>> {
    const results: Array<{
      resourceId: string;
      sourceKind: 'local' | 'remote';
      sourceId: string;
      name: string;
      userId: string;
      hostPath: string;
      desiredState: DataDirectoryEntity['desiredState'];
      reportsWhenMissing: boolean;
      blocksWhenMissing: boolean;
    }> = [];

    // Local sources on this server are configured in agent.yaml and reported through state cache.
    const mountPointMap = new Map(disks.map((d) => [d.diskId, d.mountPoint]));
    const localDirs = await this.dataDirRepo.find({
      where: { sourceKind: 'local', serverId },
    });
    for (const dir of localDirs) {
        const mountPoint = mountPointMap.get(dir.sourceId);
        if (!mountPoint) {
          throw new DataDirInventoryFaultError(
            `Durable local data directory ${dir.id} references an unreported source`,
          );
        }
        results.push({
          resourceId: dir.id,
          sourceKind: 'local',
          sourceId: dir.sourceId,
          name: dir.name,
          userId: dir.userId,
          hostPath: this.physicalDataDirPath(mountPoint, dir.id),
          desiredState: dir.desiredState,
          reportsWhenMissing: dir.desiredState === 'active',
          blocksWhenMissing: dir.desiredState === 'active',
        });
    }

    // Remote FS mounts assigned to this server
    // Every durable assignment state owns the same physical identity. In
    // particular, RemoteFsEnsure may have mounted the source and produced a
    // full inventory before its database-only finalizer changes `ensuring` to
    // `active`. Excluding transition rows here would misclassify every exact
    // directory on that mount as an orphan and quarantine a healthy Agent.
    // Only an active assignment promises that active directories must exist;
    // transition/failed assignments are recognized without making a missing
    // observation blocking.
    const assignments = await this.assignmentRepo.find({ where: { serverId } });
    if (assignments.length > 0) {
      const remoteIds = assignments.map((a) => a.remoteFsMountId);
      const mounts = await this.remoteFsMountRepo.find({ where: { id: In(remoteIds) } });
      const hostMountPointMap = new Map(mounts.map((m) => [m.id, m.hostMountPoint]));
      const assignmentStateMap = new Map(
        assignments.map((assignment) => [assignment.remoteFsMountId, assignment.desiredState]),
      );

      const remoteDirs = await this.dataDirRepo
        .createQueryBuilder('dd')
        .where('dd.sourceKind = :kind AND dd.sourceId IN (:...ids)', { kind: 'remote', ids: remoteIds })
        .getMany();
      for (const dir of remoteDirs) {
        const hostMountPoint = hostMountPointMap.get(dir.sourceId);
        const assignmentState = assignmentStateMap.get(dir.sourceId);
        if (!hostMountPoint || !assignmentState) {
          throw new DataDirInventoryFaultError(
            `Durable remote data directory ${dir.id} references an incomplete assignment`,
          );
        }
        results.push({
          resourceId: dir.id,
          sourceKind: 'remote',
          sourceId: dir.sourceId,
          name: dir.name,
          userId: dir.userId,
          hostPath: this.physicalDataDirPath(hostMountPoint, dir.id),
          desiredState: dir.desiredState,
          // A remote directory is global to the shared filesystem. One
          // assigned client's absence observation cannot prove that shared
          // directory is globally absent (for example, another NFS client may
          // have created it while this client's directory cache is stale).
          // Keep the discrepancy visible, but reserve fail-closed missing
          // evidence for server-local sources.
          reportsWhenMissing: assignmentState === 'active' && dir.desiredState === 'active',
          blocksWhenMissing: false,
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
        resourceId: entry.resourceId,
        hostPath: entry.hostPath,
        ...('name' in entry && typeof entry.name === 'string' ? { name: entry.name } : {}),
        ...(entry.userId ? { userId: entry.userId } : {}),
      },
    };
  }

  private physicalDataDirPath(root: string, resourceId: string): string {
    return `${root.replace(/\/+$/, '')}/.nyabase/dirs/${resourceId}/data`;
  }

  private key(entry: Pick<DataDirEntry, 'sourceKind' | 'sourceId' | 'resourceId'>): string {
    return `${entry.sourceKind}|${entry.sourceId}|${entry.resourceId}`;
  }
}
