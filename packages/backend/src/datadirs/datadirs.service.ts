import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentTaskKind,
  AuditAction,
  Capability,
  type DataDirDto,
  type UserDataDirDto,
  remoteFsSourceIdentity,
} from '@nyabase/common';
import type { Transaction } from 'kysely';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { DataDirectoryRecord } from '../domain/domain-records.js';
import { StateCache } from '../gateway/state-cache.js';
import { exactLocalDisk } from '../mount-sources/utils.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { ServersService } from '../servers/servers.service.js';
import { StorageRepository } from '../storage/storage.repository.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { assertAgentDataDirCapacity } from './data-dir-capacity.js';

@Injectable()
export class DataDirsService {
  constructor(
    private readonly storage: StorageRepository,
    private readonly transactions: PgTransactionManager,
    private readonly serversService: ServersService,
    private readonly auditService: AuditService,
    private readonly workflow: WorkflowEnqueuePort,
    private readonly resourceKeys: ResourceKeyService,
    private readonly stateCache: StateCache,
    private readonly accessResolver: AccessResolverService,
  ) {}

  private async computeHostPath(
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    resourceId: string,
  ): Promise<string> {
    if (sourceKind === 'local') {
      const disk = this.stateCache.get(serverId)?.disks
        .find((candidate) => candidate.diskId === sourceId);
      return disk ? this.physicalDataDirPath(disk.mountPoint, resourceId) : resourceId;
    }
    const remote = await this.storage.findRemoteFsMount(sourceId);
    return remote
      ? this.physicalDataDirPath(remote.hostMountPoint, resourceId)
      : resourceId;
  }

  async listDirs(userId: string, serverId: string): Promise<DataDirDto[]> {
    const server = await this.serversService.findById(serverId).catch(() => null);
    const serverName = server?.name ?? serverId;
    const disks = this.stateCache.get(serverId)?.disks ?? [];
    const diskIds = disks.map((disk) => disk.diskId);
    const mountPointByLocalId = new Map(
      disks.map((disk) => [disk.diskId, disk.mountPoint]),
    );
    const assignments = (await this.storage.listAssignmentsForServer(serverId))
      .filter((assignment) => assignment.desiredState === 'active');
    const remoteIds = assignments.map((assignment) => assignment.remoteFsMountId);
    const remoteMounts = await this.storage.listRemoteFsMountsByIds(remoteIds);
    const mountPointByRemoteId = new Map(
      remoteMounts.map((mount) => [mount.id, mount.hostMountPoint]),
    );
    const rows = await this.storage.listDataDirectoriesForUser(
      userId,
      serverId,
      diskIds,
      remoteIds,
    );
    return rows.map((row) => {
      const mountPoint = row.sourceKind === 'local'
        ? (mountPointByLocalId.get(row.sourceId) ?? '')
        : (mountPointByRemoteId.get(row.sourceId) ?? '');
      return {
        id: row.id,
        resourceId: row.id,
        userId: row.userId,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        name: row.name,
        hostPath: this.physicalDataDirPath(mountPoint, row.id),
        serverId,
        serverName,
        desiredState: row.desiredState,
        generation: row.generation,
        lastTaskId: row.lastTaskId,
      };
    });
  }

  async listUserDirs(userId: string, serverId: string): Promise<UserDataDirDto[]> {
    return (await this.listDirs(userId, serverId))
      .map(({ hostPath: _hostPath, ...row }) => row);
  }

  async createDir(
    actorId: string,
    userId: string,
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    name: string,
    uid: number,
    authorizationKind: 'owner' | 'admin' = 'owner',
  ) {
    const dataDirId = uuidv4();
    const applied = await this.transactions.run(async (transaction) => {
      if (authorizationKind === 'admin') {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageContainersAny],
        );
      }
      const sourceIdentity = await this.resolveReadySource(
        transaction,
        serverId,
        sourceKind,
        sourceId,
      );
      const user = await transaction.selectFrom('iam.users')
        .select(['id', 'numeric_id'])
        .where('id', '=', userId)
        .executeTakeFirst();
      if (!user) throw new NotFoundException(`User ${userId} not found`);
      const quota = await this.storage.findQuotaDesired(serverId, userId, transaction);
      if (
        !quota
        || !quota.lastTaskId
        || quota.numericUserId !== user.numeric_id
      ) {
        throw new ConflictException(
          'User quota has no durable desired state on this server',
        );
      }
      if (await this.storage.findDataDirectoryByPhysicalName({
        sourceKind,
        sourceId,
        serverId,
        name,
      }, transaction)) {
        throw new ConflictException(`Directory "${name}" already exists on this source`);
      }
      if (!await this.accessResolver.hasMountSourceAccessInTransaction(
        transaction,
        userId,
        serverId,
        { kind: sourceKind, id: sourceId },
        sourceKind === 'local' ? sourceIdentity : undefined,
      )) {
        throw new ConflictException(
          'Mount source authorization changed while preparing the data directory',
        );
      }

      const affectedServers = sourceKind === 'local'
        ? [serverId]
        : [...new Set([
            serverId,
            ...(await this.storage.listAssignmentsForMount(sourceId, transaction))
              .map((assignment) => assignment.serverId),
          ])].sort();
      for (const affectedServerId of affectedServers) {
        await assertAgentDataDirCapacity(
          this.storage,
          transaction,
          affectedServerId,
          {
            includeRemoteMountId: sourceKind === 'remote' ? sourceId : undefined,
            additionalRows: 1,
          },
        );
      }

      const payload = {
        resourceId: dataDirId,
        generation: 1,
        diskId: sourceId,
        sourceIdentity,
        quotaRequired: sourceKind === 'local',
        uid,
        numericUserId: user.numeric_id,
        quotaGeneration: quota.generation,
        diskBytes: quota.limitBytes,
      };
      const task = await this.workflow.enqueueInTransaction(transaction, {
        kind: AgentTaskKind.DataDirEnsure,
        serverId,
        resourceType: 'datadir',
        resourceId: dataDirId,
        requestedBy: actorId,
        payload,
        resourceKeys: [
          this.resourceKeys.dataDir({ serverId, sourceKind, sourceId, name }),
          this.resourceKeys.mountSource({ serverId, sourceKind, sourceId }),
          this.resourceKeys.quota(serverId, userId),
        ],
        request: {
          id: dataDirId,
          userId,
          serverId,
          sourceKind,
          sourceId,
          sourceIdentity,
          name,
          uid,
        },
        beforeCommit: async (taskTransaction, context) => {
          const freshQuota = await this.storage.findQuotaDesired(
            serverId,
            userId,
            taskTransaction,
          );
          if (
            !freshQuota
            || !freshQuota.lastTaskId
            || freshQuota.generation !== quota.generation
            || freshQuota.numericUserId !== user.numeric_id
            || freshQuota.limitBytes !== quota.limitBytes
          ) {
            throw new ConflictException(
              'User quota changed while preparing the data directory; retry',
            );
          }
          await this.storage.insertDataDirectory({
            id: dataDirId,
            userId,
            sourceKind,
            sourceId,
            name,
            sourceIdentity,
            serverId: sourceKind === 'local' ? serverId : null,
            uid,
            desiredState: 'creating',
            generation: 1,
            lastTaskId: context.taskId,
          }, serverId, taskTransaction);
        },
      });
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.CreateDataDir,
        dataDirId,
        'datadir',
        {
          userId,
          serverId,
          sourceKind,
          sourceId,
          path: `${serverId}/${sourceId}/${name}`,
          taskId: task.taskId,
        },
      );
      return { sourceIdentity, task };
    });
    return {
      id: dataDirId,
      resourceId: dataDirId,
      serverId,
      sourceKind,
      sourceId,
      name,
      hostPath: await this.computeHostPath(serverId, sourceKind, sourceId, dataDirId),
      taskId: applied.task.taskId,
    };
  }

  async deleteDir(
    actorId: string,
    userId: string,
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    name: string,
    authorizationKind: 'owner' | 'admin' = 'owner',
  ) {
    const applied = await this.transactions.run(async (transaction) => {
      if (authorizationKind === 'admin') {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageContainersAny],
        );
      }
      const row = await this.storage.findDataDirectoryByPhysicalName({
        userId,
        sourceKind,
        sourceId,
        serverId,
        name,
      }, transaction);
      if (!row) throw new NotFoundException(`Data directory "${name}" not found`);
      if (row.desiredState !== 'active' && row.desiredState !== 'failed') {
        throw new ConflictException('Data directory changed while preparing deletion; retry');
      }
      await this.assertNotReferencedByContainer(
        transaction,
        serverId,
        sourceKind,
        sourceId,
        userId,
        name,
      );
      await this.assertDeletionSourceReady(transaction, serverId, row);
      if (authorizationKind === 'owner' && !await this.accessResolver
        .hasMountSourceAccessInTransaction(
          transaction,
          userId,
          serverId,
          { kind: sourceKind, id: sourceId },
          sourceKind === 'local' ? row.sourceIdentity : undefined,
        )) {
        throw new ConflictException(
          'Mount source authorization changed while preparing data directory deletion',
        );
      }
      const user = await transaction.selectFrom('iam.users')
        .select(['id', 'numeric_id'])
        .where('id', '=', userId)
        .executeTakeFirst();
      if (!user) throw new NotFoundException(`User ${userId} not found`);
      const nextGeneration = row.generation + 1;
      const task = await this.workflow.enqueueInTransaction(transaction, {
        kind: AgentTaskKind.DataDirAbsent,
        serverId,
        resourceType: 'datadir',
        resourceId: row.id,
        requestedBy: actorId,
        payload: {
          resourceId: row.id,
          generation: nextGeneration,
          diskId: sourceId,
          sourceIdentity: row.sourceIdentity,
          numericUserId: user.numeric_id,
        },
        resourceKeys: [
          this.resourceKeys.dataDir({ serverId, sourceKind, sourceId, name }),
          this.resourceKeys.mountSource({ serverId, sourceKind, sourceId }),
          this.resourceKeys.quota(serverId, userId),
        ],
        request: {
          userId,
          sourceKind,
          sourceId,
          sourceIdentity: row.sourceIdentity,
          name,
        },
        beforeCommit: async (taskTransaction, context) => {
          const transitioned = await this.storage.transitionDataDirectory(
            row.id,
            row.generation,
            ['active', 'failed'],
            {
              desiredState: 'removing',
              generation: nextGeneration,
              lastTaskId: context.taskId,
            },
            taskTransaction,
          );
          if (!transitioned) {
            throw new ConflictException(
              'Data directory changed while preparing deletion; retry',
            );
          }
        },
      });
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.DeleteDataDir,
        row.id,
        'datadir',
        {
          userId,
          serverId,
          sourceKind,
          sourceId,
          name,
          path: `${serverId}/${sourceId}/${name}`,
          taskId: task.taskId,
        },
      );
      return { row, task };
    });
    return {
      ok: true,
      taskId: applied.task.taskId,
      status: applied.task.status,
    };
  }

  private async resolveReadySource(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
  ): Promise<string> {
    if (sourceKind === 'local') {
      const snapshot = this.stateCache.get(serverId);
      const disk = snapshot && snapshot.helloAt !== null
        ? exactLocalDisk(snapshot.disks, sourceId)
        : null;
      if (!disk) {
        throw new NotFoundException(`Disk ${sourceId} not found on server ${serverId}`);
      }
      return disk.sourceIdentity;
    }
    const [assignment, mount] = await Promise.all([
      this.storage.findAssignment(sourceId, serverId, transaction),
      this.storage.findActiveRemoteFsMount(sourceId, transaction),
    ]);
    if (!assignment || assignment.desiredState !== 'active') {
      throw new ConflictException(
        `Remote FS mount ${sourceId} is not ready on server ${serverId}`,
      );
    }
    if (!mount) throw new NotFoundException(`Remote FS mount ${sourceId} is not active`);
    return remoteFsSourceIdentity(mount.params);
  }

  private async assertNotReferencedByContainer(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    userId: string,
    dirName: string,
  ): Promise<void> {
    if (await this.storage.hasContainerMountReference({
      serverId,
      sourceKind,
      sourceId,
      userId,
      dirName,
    }, transaction)) {
      throw new ConflictException(
        `Data directory "${dirName}" is referenced by a container`,
      );
    }
  }

  private async assertDeletionSourceReady(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    row: DataDirectoryRecord,
  ): Promise<void> {
    if (row.sourceKind === 'local') {
      const snapshot = this.stateCache.get(serverId);
      const disk = snapshot && snapshot.helloAt !== null
        ? exactLocalDisk(snapshot.disks, row.sourceId)
        : null;
      if (!disk || disk.sourceIdentity !== row.sourceIdentity) {
        throw new ConflictException({
          code: 'DATA_DIRECTORY_SOURCE_NOT_READY',
          message: 'The exact local data source is no longer ready on this server',
        });
      }
      return;
    }
    const [assignment, mount] = await Promise.all([
      this.storage.findAssignment(row.sourceId, serverId, transaction),
      this.storage.findActiveRemoteFsMount(row.sourceId, transaction),
    ]);
    if (
      !assignment
      || assignment.desiredState !== 'active'
      || !mount
      || remoteFsSourceIdentity(mount.params) !== row.sourceIdentity
    ) {
      throw new ConflictException({
        code: 'DATA_DIRECTORY_SOURCE_NOT_READY',
        message: 'The exact remote data source is no longer assigned to this server',
      });
    }
  }

  private physicalDataDirPath(root: string, resourceId: string): string {
    return `${root.replace(/\/+$/, '')}/.nyabase/dirs/${resourceId}/data`;
  }
}
