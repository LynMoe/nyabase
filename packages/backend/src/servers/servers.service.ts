import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes, createHash } from 'crypto';
import { ServerEntity } from '../entities/server.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import {
  AgentCommandKind,
  ServerStatus,
  GpuGrantMode,
  CheckDiskResult,
  DataDiskDto,
  SelfCheckResult,
  OperationKind,
  OperationStatus,
  type DockerDaemonStatus,
  type DiskInfo,
  type ServerDto,
} from '@nyabase/common';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { rpcWithErrorMapping } from '../gateway/agent-errors.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { UsersService } from '../users/users.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { QuotaDispatchService } from '../quota/quota-dispatch.service.js';

@Injectable()
export class ServersService {
  constructor(
    @InjectRepository(ServerEntity)
    private serversRepo: Repository<ServerEntity>,
    @InjectRepository(DataDiskEntity)
    private dataDisksRepo: Repository<DataDiskEntity>,
    @InjectRepository(DataDirectoryEntity)
    private dataDirectoriesRepo: Repository<DataDirectoryEntity>,
    @InjectRepository(ContainerMountEntity)
    private containerMountsRepo: Repository<ContainerMountEntity>,
    private agentGateway: AgentGateway,
    private accessResolver: AccessResolverService,
    private usersService: UsersService,
    private operationsService: OperationsService,
    private quotaDispatchService: QuotaDispatchService,
  ) {}

  async create(dto: {
    name: string;
    parentIface: string;
    ipCidr: string;
    gateway: string;
    reservedIps?: string[];
    isGpuServer?: boolean;
    defaultCpuMillis?: number;
    defaultMemBytes?: number;
    defaultDiskBytes?: number;
    defaultGpuMode?: GpuGrantMode;
    defaultGpuIndices?: number[];
  }) {
    const existing = await this.serversRepo.findOne({ where: { name: dto.name } });
    if (existing) throw new ConflictException('Server name already exists');

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const server = this.serversRepo.create({
      id: uuidv4(),
      name: dto.name,
      parentIface: dto.parentIface,
      ipCidr: dto.ipCidr,
      gateway: dto.gateway,
      agentTokenHash: tokenHash,
      reservedIps: dto.reservedIps ?? [],
      isGpuServer: dto.isGpuServer ?? true,
      status: ServerStatus.Unknown,
      lastSeenAt: null,
      defaultCpuMillis: dto.defaultCpuMillis ?? 0,
      defaultMemBytes: dto.defaultMemBytes ?? 0,
      defaultDiskBytes: dto.defaultDiskBytes ?? 0,
      defaultGpuMode: dto.defaultGpuMode ?? GpuGrantMode.None,
      defaultGpuIndices: dto.defaultGpuIndices ?? [],
    });
    await this.serversRepo.save(server);
    return { server, agentToken: rawToken };
  }

  async findAll(): Promise<ServerEntity[]> {
    return this.serversRepo.find();
  }

  async findAllDtos(): Promise<ServerDto[]> {
    const servers = await this.serversRepo.find();
    return Promise.all(servers.map((server) => this.toDto(server)));
  }

  async findByIds(ids: string[]): Promise<ServerEntity[]> {
    if (ids.length === 0) return [];
    return this.serversRepo.findBy(ids.map((id) => ({ id })));
  }

  async findDtosByIds(ids: string[]): Promise<ServerDto[]> {
    const servers = await this.findByIds(ids);
    return Promise.all(servers.map((server) => this.toDto(server)));
  }

  async findById(id: string): Promise<ServerEntity> {
    const server = await this.serversRepo.findOne({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }

  async findDtoById(id: string): Promise<ServerDto> {
    return this.toDto(await this.findById(id));
  }

  async findByTokenHash(hash: string): Promise<ServerEntity | null> {
    return this.serversRepo.findOne({ where: { agentTokenHash: hash } });
  }

  async update(
    id: string,
    dto: {
      name?: string;
      parentIface?: string;
      ipCidr?: string;
      gateway?: string;
      reservedIps?: string[];
      isGpuServer?: boolean;
    },
  ) {
    const server = await this.findById(id);
    if (dto.name !== undefined) server.name = dto.name;
    if (dto.parentIface !== undefined) server.parentIface = dto.parentIface;
    if (dto.ipCidr !== undefined) server.ipCidr = dto.ipCidr;
    if (dto.gateway !== undefined) server.gateway = dto.gateway;
    if (dto.reservedIps !== undefined) server.reservedIps = dto.reservedIps;
    if (dto.isGpuServer !== undefined) server.isGpuServer = dto.isGpuServer;
    return this.serversRepo.save(server);
  }

  async updateDefaults(
    id: string,
    dto: {
      defaultCpuMillis?: number;
      defaultMemBytes?: number;
      defaultDiskBytes?: number;
      defaultGpuMode?: GpuGrantMode;
      defaultGpuIndices?: number[];
    },
  ) {
    const server = await this.findById(id);
    const diskBytesChanged = dto.defaultDiskBytes !== undefined;
    if (dto.defaultCpuMillis !== undefined) server.defaultCpuMillis = dto.defaultCpuMillis;
    if (dto.defaultMemBytes !== undefined) server.defaultMemBytes = dto.defaultMemBytes;
    if (dto.defaultDiskBytes !== undefined) server.defaultDiskBytes = dto.defaultDiskBytes;
    if (dto.defaultGpuMode !== undefined) server.defaultGpuMode = dto.defaultGpuMode;
    if (dto.defaultGpuIndices !== undefined) server.defaultGpuIndices = dto.defaultGpuIndices;
    const saved = await this.serversRepo.save(server);

    if (diskBytesChanged) {
      const userIds = await this.accessResolver.getUsersWithServerAccess(id);
      for (const userId of userIds) this.accessResolver.invalidateUser(userId);
      const numericMap = await this.usersService.getNumericIdsByUserIds(userIds);
      await Promise.all(
        userIds.map(async (userId) => {
          const grant = await this.accessResolver.resolveServer(userId, id);
          const numericUserId = numericMap.get(userId);
          if (grant && numericUserId != null) {
            try {
              await this.quotaDispatchService.apply({
                serverId: id,
                userId,
                numericUserId,
                diskBytes: grant.diskBytes,
                requestedBy: null,
              });
            } catch {
              // Quota reconciliation is durable; failures are visible on task/operation state.
            }
          }
        }),
      );
    }

    return saved;
  }

  async delete(id: string) {
    const server = await this.findById(id);
    await this.serversRepo.remove(server);
  }

  async regenerateToken(id: string) {
    const server = await this.findById(id);
    const rawToken = randomBytes(32).toString('hex');
    server.agentTokenHash = createHash('sha256').update(rawToken).digest('hex');
    await this.serversRepo.save(server);
    return rawToken;
  }

  // ---------------------------------------------------------------------------
  // Data Disk management (DB is SoT; host changes go through durable operations)
  // ---------------------------------------------------------------------------

  async listDisks(serverId: string): Promise<DataDiskEntity[]> {
    return this.dataDisksRepo.find({ where: { serverId } });
  }

  async listDiskDtos(serverId: string): Promise<DataDiskDto[]> {
    const disks = await this.listDisks(serverId);
    const latest = new Map((this.agentGateway.stateCache.get(serverId)?.disks ?? []).map((disk) => [disk.diskId, disk]));
    return disks.map((disk) => this.toDiskDto(disk, latest.get(disk.id)));
  }

  async listAllDisks(): Promise<Array<{ diskId: string; serverId: string; mountPoint: string; label: string | null }>> {
    const disks = await this.dataDisksRepo.find({ order: { serverId: 'ASC', mountPoint: 'ASC' } });
    return disks.map((d) => ({ diskId: d.id, serverId: d.serverId, mountPoint: d.mountPoint, label: d.label }));
  }

  async findDisk(serverId: string, diskId: string): Promise<DataDiskEntity> {
    const disk = await this.dataDisksRepo.findOne({ where: { id: diskId, serverId } });
    if (!disk) throw new NotFoundException(`Disk ${diskId} not found`);
    return disk;
  }

  async addDisk(
    serverId: string,
    mountPoint: string,
    label?: string,
  ): Promise<DataDiskEntity & { operationId?: string; operationStatus?: OperationStatus }> {
    await this.findById(serverId);

    // Validate via agent
    if (!this.agentGateway.isOnline(serverId)) {
      throw new BadRequestException('Agent is offline, cannot validate disk');
    }
    this.assertRuntimeReady(serverId);
    const check = await rpcWithErrorMapping(() =>
      this.agentGateway.rpc<CheckDiskResult>(serverId, 'checkDisk', { mountPoint }),
    );
    if (!check.exists) throw new BadRequestException(`Path does not exist: ${mountPoint}`);
    if (!check.isXfs) throw new BadRequestException(`Path ${mountPoint} uses filesystem ${check.fsType}, must be XFS`);

    // Idempotent: if same mountPoint already registered for this server return it
    const existing = await this.dataDisksRepo.findOne({ where: { serverId, mountPoint } });
    if (existing) {
      const dispatched = await this.dispatchDataDiskApply(serverId, existing);
      return Object.assign(existing, {
        operationId: dispatched.operationId,
        operationStatus: dispatched.status,
      });
    }

    const disk = this.dataDisksRepo.create({
      id: uuidv4(),
      serverId,
      mountPoint,
      label: label ?? null,
    });
    await this.dataDisksRepo.save(disk);

    const dispatched = await this.dispatchDataDiskApply(serverId, disk);
    return Object.assign(disk, {
      operationId: dispatched.operationId,
      operationStatus: dispatched.status,
    });
  }

  async removeDisk(serverId: string, diskId: string): Promise<{ ok: true; operationId: string; status: OperationStatus }> {
    const disk = await this.findDisk(serverId, diskId);

    // Check no ContainerMounts reference this disk
    const inUse = await this.containerMountsRepo.findOne({
      where: { serverId, sourceKind: 'local', sourceId: diskId },
    });
    if (inUse) {
      throw new BadRequestException('This disk is still used by container mounts; remove those mounts first');
    }

    const dataDirInUse = await this.dataDirectoriesRepo.findOne({
      where: { sourceKind: 'local', sourceId: diskId },
    });
    if (dataDirInUse) {
      throw new BadRequestException('This disk still has data directories; delete those data directories first');
    }

    const dispatched = await this.dispatchDataDiskRemove(serverId, disk);
    return {
      ok: true,
      operationId: dispatched.operationId,
      status: dispatched.status,
    };
  }

  async updateDisk(
    serverId: string,
    diskId: string,
    label: string | null,
  ): Promise<DataDiskEntity & { operationId?: string; operationStatus?: OperationStatus }> {
    const disk = await this.findDisk(serverId, diskId);
    const normalized = label === '' ? null : label;
    disk.label = normalized;
    await this.dataDisksRepo.save(disk);

    const dispatched = await this.dispatchDataDiskApply(serverId, disk);
    return Object.assign(disk, {
      operationId: dispatched.operationId,
      operationStatus: dispatched.status,
    });
  }

  async selfCheck(serverId: string): Promise<SelfCheckResult> {
    await this.findById(serverId);
    if (!this.agentGateway.isOnline(serverId)) {
      throw new BadRequestException('Agent is offline, cannot run self-check');
    }
    this.assertRuntimeReady(serverId);
    return rpcWithErrorMapping(() =>
      this.agentGateway.rpc<SelfCheckResult>(serverId, 'selfCheck', {}),
    );
  }

  async persistDockerDaemonStatus(serverId: string, status: DockerDaemonStatus): Promise<DockerDaemonStatus> {
    if (status.serverId !== serverId) {
      throw new BadRequestException('Docker daemon status serverId mismatch');
    }
    this.agentGateway.stateCache.updateDockerDaemonStatus(serverId, status);
    return status;
  }

  /** Push all known disks to agent on reconnect. */
  async dispatchDisks(serverId: string): Promise<void> {
    const disks = await this.listDisks(serverId);
    for (const disk of disks) {
      try {
        await this.dispatchDataDiskApply(serverId, disk);
      } catch { /* best-effort per disk */ }
    }
  }

  private async dispatchDataDiskApply(
    serverId: string,
    disk: Pick<DataDiskEntity, 'id' | 'mountPoint' | 'label'>,
  ): Promise<{ operationId: string; status: OperationStatus }> {
    const payload = {
      diskId: disk.id,
      mountPoint: disk.mountPoint,
      ...(disk.label != null && { label: disk.label }),
    };

    return this.operationsService.dispatchAgentCommand(
      {
        operationKind: OperationKind.DiskApply,
        commandKind: AgentCommandKind.DiskApply,
        resourceType: 'data_disk',
        resourceId: disk.id,
        serverId,
        requestedBy: null,
        payload,
      },
    );
  }

  private async dispatchDataDiskRemove(
    serverId: string,
    disk: Pick<DataDiskEntity, 'id' | 'generation'>,
  ): Promise<{ operationId: string; status: OperationStatus }> {
    return this.operationsService.dispatchAgentCommand({
      operationKind: OperationKind.DiskApply,
      commandKind: AgentCommandKind.DiskRemove,
      resourceType: 'data_disk',
      resourceId: disk.id,
      serverId,
      requestedBy: null,
      payload: { diskId: disk.id },
      beforePersist: async (manager, context) => {
        await manager.update(DataDiskEntity, disk.id, {
          desiredState: 'removing',
          generation: (disk.generation ?? 0) + 1,
          lastOperationId: context.operationId,
        });
      },
    });
  }

  async getDiskDto(serverId: string, diskId: string): Promise<DataDiskDto> {
    const disk = await this.findDisk(serverId, diskId);
    const observation = this.agentGateway.stateCache.get(serverId)?.disks.find((row) => row.diskId === disk.id) ?? null;
    return this.toDiskDto(disk, observation);
  }

  async getUserQuota(serverId: string, userId: string): Promise<{ usedBytes: number; limitBytes: number }> {
    await this.findById(serverId);
    const grant = await this.accessResolver.resolveServer(userId, serverId);
    const latest = this.agentGateway.stateCache.get(serverId)?.xfsProjects.find((row) => row.userId === userId) ?? null;
    return {
      usedBytes: latest?.usedBytes ?? 0,
      limitBytes: grant?.diskBytes ?? 0,
    };
  }

  private toDiskDto(
    disk: DataDiskEntity,
    observation: DiskInfo | null | undefined,
  ): DataDiskDto {
    return {
      diskId: disk.id,
      mountPoint: disk.mountPoint,
      label: disk.label ?? undefined,
      totalBytes: observation?.totalBytes ?? 0,
      usedBytes: observation?.usedBytes ?? 0,
      pquotaEnabled: observation?.pquotaEnabled ?? false,
    };
  }

  private async toDto(server: ServerEntity): Promise<ServerDto> {
    const snap = this.agentGateway.stateCache.get(server.id);
    const disks = await this.listDiskDtos(server.id);
    return {
      id: server.id,
      name: server.name,
      parentIface: server.parentIface,
      ipCidr: server.ipCidr,
      gateway: server.gateway,
      isGpuServer: server.isGpuServer,
      status: server.status,
      lastSeenAt: server.lastSeenAt?.toISOString() ?? null,
      runtimeReady: snap?.runtimeReady === true,
      runtimeObservedAt: snap?.lastUpdated ? new Date(snap.lastUpdated).toISOString() : null,
      defaultCpuMillis: server.defaultCpuMillis,
      defaultMemBytes: server.defaultMemBytes,
      defaultDiskBytes: server.defaultDiskBytes,
      defaultGpuMode: server.defaultGpuMode,
      defaultGpuIndices: server.defaultGpuIndices,
      disks,
      gpus: snap?.gpus ?? [],
      agentVersion: snap?.agentVersion,
      dockerRoot: server.dockerRoot,
      dockerSocket: server.dockerSocket,
      dockerDaemon: snap?.dockerDaemon ?? null,
    };
  }

  private assertRuntimeReady(serverId: string): void {
    const availability = this.agentGateway.stateCache.getRuntimeBlockReason(serverId);
    if (!availability.enabled) {
      throw new ConflictException({
        statusCode: 409,
        code: 'agent_state_unready',
        reason: 'agent_state_unready',
        message: availability.message,
      });
    }
  }
}
