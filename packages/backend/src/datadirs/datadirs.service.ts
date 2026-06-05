import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { ContainerRuntimeObservationEntity } from '../entities/container-runtime-observation.entity.js';
import { RuntimeContainerEntity } from '../entities/runtime-container.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ServersService } from '../servers/servers.service.js';
import { UsersService } from '../users/users.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { AgentCommandKind, AuditAction, ContainerStatus, DataDirDto, OperationKind } from '@nyabase/common';

function collectDbErrorChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let current = error;

  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') break;
    const currentRecord = current as Record<string, unknown>;
    chain.push(currentRecord);
    current = currentRecord.driverError;
  }

  return chain;
}

function dbErrorValue(error: Record<string, unknown>, key: string): string | undefined {
  const value = error[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function isDuplicateConstraintError(error: unknown): boolean {
  const chain = collectDbErrorChain(error);
  const values = chain.flatMap((candidate) => [
    dbErrorValue(candidate, 'code'),
    dbErrorValue(candidate, 'errno'),
    dbErrorValue(candidate, 'number'),
    dbErrorValue(candidate, 'sqlState'),
  ]);
  const text = chain
    .flatMap((candidate) => [
      dbErrorValue(candidate, 'message'),
      dbErrorValue(candidate, 'sqlMessage'),
      dbErrorValue(candidate, 'detail'),
      dbErrorValue(candidate, 'constraint'),
      dbErrorValue(candidate, 'table'),
    ])
    .filter((value): value is string => value != null)
    .join(' ')
    .toLowerCase();

  return values.some((value) => {
    if (!value) return false;
    const normalized = value.toUpperCase();
    if (
      normalized === '23505' ||
      normalized === 'ER_DUP_ENTRY' ||
      normalized === 'SQLITE_CONSTRAINT_UNIQUE' ||
      normalized === '1062' ||
      normalized === '2067' ||
      normalized === '2601' ||
      normalized === '2627' ||
      normalized === 'ORA-00001'
    ) {
      return true;
    }

    return (
      (normalized === 'SQLITE_CONSTRAINT' || normalized === '23000') &&
      /\b(unique|duplicate)\b/.test(text)
    );
  });
}

@Injectable()
export class DataDirsService {
  constructor(
    @InjectRepository(DataDirectoryEntity)
    private dataDirRepo: Repository<DataDirectoryEntity>,
    @InjectRepository(DataDiskEntity)
    private dataDisksRepo: Repository<DataDiskEntity>,
    @InjectRepository(ContainerMountEntity)
    private containerMountsRepo: Repository<ContainerMountEntity>,
    @InjectRepository(ContainerRuntimeObservationEntity)
    private observationsRepo: Repository<ContainerRuntimeObservationEntity>,
    @InjectRepository(RuntimeContainerEntity)
    private runtimeContainersRepo: Repository<RuntimeContainerEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsMountsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private remoteFsAssignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    private serversService: ServersService,
    private usersService: UsersService,
    private auditService: AuditService,
    private operationsService: OperationsService,
  ) {}

  /** Compute the host path for a directory (single-layer layout: {mountPoint}/{name}) */
  private async computeHostPath(sourceKind: 'local' | 'remote', sourceId: string, name: string): Promise<string> {
    if (sourceKind === 'local') {
      const disk = await this.dataDisksRepo.findOne({ where: { id: sourceId } });
      return disk ? `${disk.mountPoint}/${name}` : name;
    }
    const rfs = await this.remoteFsMountsRepo.findOne({ where: { id: sourceId } });
    return rfs ? `${rfs.hostMountPoint}/${name}` : name;
  }

  async listDirs(userId: string, serverId: string): Promise<DataDirDto[]> {
    const server = await this.serversService.findById(serverId).catch(() => null);
    const serverName = server?.name ?? serverId;

    // Fetch local dirs for this server's disks
    const disks = await this.dataDisksRepo.find({ where: { serverId } });
    const diskIds = disks.map((d) => d.id);
    const mountPointMap = new Map(disks.map((d) => [d.id, d.mountPoint]));

    // Fetch remote dirs for mounts assigned to this server
    const assignments = await this.remoteFsAssignmentsRepo.find({ where: { serverId } });
    const remoteIds = assignments.map((a) => a.remoteFsMountId);
    const remoteMountPointMap = new Map<string, string>();
    if (remoteIds.length > 0) {
      const mounts = await this.remoteFsMountsRepo.find({ where: { id: In(remoteIds) } });
      for (const m of mounts) remoteMountPointMap.set(m.id, m.hostMountPoint);
    }

    const allSourceIds = [...diskIds, ...remoteIds];
    if (allSourceIds.length === 0) return [];

    const rows = await this.dataDirRepo
      .createQueryBuilder('dd')
      .where('dd.userId = :userId AND dd.sourceId IN (:...ids)', { userId, ids: allSourceIds })
      .getMany();

    return rows.map((row) => {
      const mountPoint = row.sourceKind === 'local'
        ? (mountPointMap.get(row.sourceId) ?? '')
        : (remoteMountPointMap.get(row.sourceId) ?? '');
      return {
        id: row.id,
        userId: row.userId,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        name: row.name,
        hostPath: `${mountPoint}/${row.name}`,
        serverId,
        serverName,
      };
    });
  }

  async createDir(
    actorId: string,
    userId: string,
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    name: string,
    uid: number,
  ) {
    // Validate source exists on this server
    if (sourceKind === 'local') {
      const disk = await this.dataDisksRepo.findOne({ where: { id: sourceId, serverId } });
      if (!disk) throw new NotFoundException(`Disk ${sourceId} not found on server ${serverId}`);
    } else {
      const assignment = await this.remoteFsAssignmentsRepo.findOne({ where: { remoteFsMountId: sourceId, serverId } });
      if (!assignment) throw new NotFoundException(`Remote FS mount ${sourceId} not found on server ${serverId}`);
    }

    // INSERT into DB first (unique constraint guards against name conflicts)
    const entity = this.dataDirRepo.create({
      id: uuidv4(),
      userId,
      sourceKind,
      sourceId,
      name,
      serverId: sourceKind === 'local' ? serverId : null,
      uid,
    });

    try {
      await this.dataDirRepo.save(entity);
    } catch (err: unknown) {
      if (isDuplicateConstraintError(err)) {
        throw new ConflictException(`Directory "${name}" already exists on this source`);
      }
      throw err;
    }

    const numericMap = await this.usersService.getNumericIdsByUserIds([userId]);
    const numericUserId = numericMap.get(userId);
    if (numericUserId == null) throw new Error(`numericId not found for user ${userId}`);

    const createDataDirPayload = { diskId: sourceId, name, uid, numericUserId };
    const dispatched = await this.operationsService.dispatchAgentCommand({
      operationKind: OperationKind.DataDirCreate,
      commandKind: AgentCommandKind.DataDirApply,
      serverId,
      resourceType: 'datadir',
      resourceId: entity.id,
      requestedBy: actorId,
      payload: createDataDirPayload,
      request: {
        userId,
        sourceKind,
        sourceId,
        name,
        uid,
      },
    });

    await this.auditService.log(actorId, AuditAction.CreateDataDir, `${serverId}/${sourceId}/${name}`, 'datadir', {
      userId, sourceKind, sourceId, name, operationId: dispatched.operationId,
    });

    const hostPath = await this.computeHostPath(sourceKind, sourceId, name);
    return { id: entity.id, serverId, sourceKind, sourceId, name, hostPath, operationId: dispatched.operationId };
  }

  async deleteDir(
    actorId: string,
    userId: string,
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    name: string,
  ) {
    const row = await this.dataDirRepo.findOne({ where: { sourceKind, sourceId, name, userId } });
    if (!row) throw new NotFoundException(`Data directory "${name}" not found`);

    await this.assertNotMountedByRunningContainer(serverId, sourceKind, sourceId, userId, name);

    const deleteDataDirPayload = { diskId: sourceId, name };

    const dispatched = await this.operationsService.dispatchAgentCommand({
      operationKind: OperationKind.DataDirDelete,
      commandKind: AgentCommandKind.DataDirDelete,
      serverId,
      resourceType: 'datadir',
      resourceId: row.id,
      requestedBy: actorId,
      payload: deleteDataDirPayload,
      request: { userId, sourceKind, sourceId, name },
      beforePersist: async (manager, context) => {
        await manager.update(DataDirectoryEntity, row.id, {
          desiredState: 'removing',
          generation: (row.generation ?? 0) + 1,
          lastOperationId: context.operationId,
        });
      },
    });

    await this.auditService.log(actorId, AuditAction.DeleteDataDir, `${serverId}/${sourceId}/${name}`, 'datadir', {
      userId, sourceKind, sourceId, name, operationId: dispatched.operationId,
    });
    return {
      ok: true,
      operationId: dispatched.operationId,
      status: dispatched.status,
    };
  }

  private async assertNotMountedByRunningContainer(
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    userId: string,
    dirName: string,
  ): Promise<void> {
    const mounts = await this.containerMountsRepo.find({
      where: { serverId, sourceKind, sourceId, userId, dirName },
    });
    if (mounts.length === 0) return;

    const liveRuntime = await this.runtimeContainersRepo.findOne({
      where: mounts.map((mount) => ({
        serverId: mount.serverId,
        containerId: mount.containerId,
        status: ContainerStatus.Running,
        stale: false,
      })),
      order: { lastSeenAt: 'DESC' },
    });
    if (liveRuntime) {
      throw new ConflictException(`Data directory "${dirName}" is mounted by a running container`);
    }

    const latest = await Promise.all(
      mounts
        .map((mount) => this.observationsRepo.findOne({
          where: { serverId: mount.serverId, containerId: mount.containerId },
          order: { reportSeq: 'DESC', lastSeenAt: 'DESC' },
        })),
    );
    const inUse = latest.some((observation) =>
      observation && !observation.stale && observation.status === ContainerStatus.Running,
    );

    if (inUse) {
      throw new ConflictException(`Data directory "${dirName}" is mounted by a running container`);
    }
  }

}
