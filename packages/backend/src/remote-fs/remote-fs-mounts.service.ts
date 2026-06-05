import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { AuditService } from '../audit/audit.service.js';
import { AgentCommandKind, AuditAction, OperationKind, RemoteFsMountStatus, RemoteFsParams, zRemoteFsParams } from '@nyabase/common';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { AgentGateway } from '../gateway/agent-gateway.js';

/** Forbidden hostMountPoint prefixes */
const FORBIDDEN_PREFIXES = ['/', '/etc', '/var/run', '/proc', '/sys', '/dev'];

function validateHostMountPoint(p: string) {
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (p === prefix || p.startsWith(prefix + '/')) {
      throw new BadRequestException(
        `hostMountPoint must not be under system directory ${prefix}`,
      );
    }
  }
}

@Injectable()
export class RemoteFsMountsService {
  constructor(
    @InjectRepository(RemoteFsMountEntity)
    private mountsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private assignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(ContainerMountEntity)
    private containerMountsRepo: Repository<ContainerMountEntity>,
    @InjectRepository(DataDirectoryEntity)
    private dataDirectoriesRepo: Repository<DataDirectoryEntity>,
    private auditService: AuditService,
    private accessResolver: AccessResolverService,
    private operationsService: OperationsService,
    private agentGateway: AgentGateway,
  ) {}

  async list(serverId?: string): Promise<RemoteFsMountEntity[]> {
    if (serverId) {
      const assignments = await this.assignmentsRepo.find({ where: { serverId } });
      if (assignments.length === 0) return [];
      const mountIds = assignments.map((a) => a.remoteFsMountId);
      return this.mountsRepo.find({ where: { id: In(mountIds) } });
    }
    return this.mountsRepo.find();
  }

  async findById(id: string): Promise<RemoteFsMountEntity> {
    const m = await this.mountsRepo.findOne({ where: { id } });
    if (!m) throw new NotFoundException(`Remote FS mount ${id} not found`);
    return m;
  }

  async getServerIds(mountId: string): Promise<string[]> {
    const assignments = await this.assignmentsRepo.find({ where: { remoteFsMountId: mountId } });
    return assignments.map((a) => a.serverId);
  }

  async create(
    actorId: string,
    dto: {
      name: string;
      displayName?: string;
      description?: string;
      serverIds?: string[];
      type: string;
      options?: string;
      hostMountPoint?: string;
      params: RemoteFsParams;
    },
  ): Promise<RemoteFsMountEntity & { operationIds?: string[] }> {
    const id = uuidv4();
    const fsType = dto.params.type;
    const hostMountPoint = dto.hostMountPoint ?? `/mnt/remote-fs/${id}`;
    validateHostMountPoint(hostMountPoint);

    // Validate params via zod
    zRemoteFsParams.parse(dto.params);

    const mount = this.mountsRepo.create({
      id,
      name: dto.name,
      displayName: dto.displayName ?? null,
      description: dto.description ?? null,
      type: fsType,
      hostMountPoint,
      options: dto.options ?? '',
      params: dto.params,
    });
    await this.mountsRepo.save(mount);

    const operationIds: string[] = [];
    if (dto.serverIds?.length) {
      const assignments = await Promise.all(dto.serverIds.map((sid) => this.assignServer(actorId, id, sid)));
      for (const assignment of assignments) {
        if (assignment.operationId) operationIds.push(assignment.operationId);
      }
    }

    await this.auditService.log(actorId, AuditAction.CreateRemoteFsMount, id, 'remote_fs_mount', dto);
    return Object.assign(mount, { operationIds });
  }

  async update(
    actorId: string,
    id: string,
    dto: {
      name?: string;
      displayName?: string;
      description?: string;
      options?: string;
      hostMountPoint?: string;
      params?: RemoteFsParams;
    },
  ): Promise<RemoteFsMountEntity & { operationIds?: string[] }> {
    const mount = await this.findById(id);

    const isCriticalChange =
      dto.options !== undefined ||
      dto.hostMountPoint !== undefined ||
      dto.params !== undefined;

    if (isCriticalChange) {
      const inUse = await this.containerMountsRepo.findOne({
        where: { sourceKind: 'remote', sourceId: id },
      });
      if (inUse) {
        throw new ConflictException(
          'This remote FS mount is in use by container mounts; remove those mounts before changing critical parameters',
        );
      }
    }

    if (dto.name !== undefined) mount.name = dto.name;
    if (dto.displayName !== undefined) mount.displayName = dto.displayName || null;
    if (dto.description !== undefined) mount.description = dto.description;
    if (dto.options !== undefined) mount.options = dto.options;
    if (dto.hostMountPoint !== undefined) {
      validateHostMountPoint(dto.hostMountPoint);
      mount.hostMountPoint = dto.hostMountPoint;
    }
    if (dto.params !== undefined) {
      if (dto.params.type !== mount.type) {
        throw new BadRequestException('Cannot change the type of an existing remote FS mount');
      }
      zRemoteFsParams.parse(dto.params);
      mount.params = dto.params;
    }
    await this.mountsRepo.save(mount);

    const operationIds: string[] = [];
    if (isCriticalChange) {
      const serverIds = await this.getServerIds(id);
      const dispatched = await Promise.all(serverIds.map((sid) => this.dispatchMount(mount, sid, actorId).catch(() => null)));
      operationIds.push(...dispatched
        .filter((result): result is { operationId: string } => result !== null)
        .map((result) => result.operationId));
    }

    await this.auditService.log(actorId, AuditAction.UpdateRemoteFsMount, id, 'remote_fs_mount', dto);
    return Object.assign(mount, { operationIds });
  }

  async remove(actorId: string, id: string): Promise<{ ok: true; operationIds: string[] }> {
    await this.findById(id);

    const inUse = await this.containerMountsRepo.findOne({
      where: { sourceKind: 'remote', sourceId: id },
    });
    if (inUse) {
      throw new ConflictException('This remote FS mount is in use by container mounts; remove those mounts first');
    }

    const dataDirInUse = await this.dataDirectoriesRepo.findOne({
      where: { sourceKind: 'remote', sourceId: id },
    });
    if (dataDirInUse) {
      throw new ConflictException('This remote FS mount still has data directories; delete those data directories first');
    }

    const serverIds = await this.getServerIds(id);
    const dispatched = await Promise.all(serverIds.map((serverId) =>
      this.dispatchMountRemove(id, serverId, actorId, 'mount').catch(() => null),
    ));
    const operationIds = dispatched
      .filter((result): result is { operationId: string } => result !== null)
      .map((result) => result.operationId);

    await this.auditService.log(actorId, AuditAction.DeleteRemoteFsMount, id, 'remote_fs_mount');
    return { ok: true, operationIds };
  }

  async remount(actorId: string, id: string): Promise<{ ok: true; operationIds: string[] }> {
    const mount = await this.findById(id);
    const serverIds = await this.getServerIds(id);
    const dispatched = await Promise.all(
      serverIds.map((sid) => this.dispatchMount(mount, sid, actorId).catch(() => null)),
    );
    const operationIds = dispatched
      .filter((result): result is { operationId: string } => result !== null)
      .map((result) => result.operationId);
    await this.auditService.log(actorId, AuditAction.RemountRemoteFsMount, id, 'remote_fs_mount');
    return { ok: true, operationIds };
  }

  // ---------------------------------------------------------------------------
  // Server assignments
  // ---------------------------------------------------------------------------

  async listServerAssignments(mountId: string): Promise<RemoteFsServerAssignmentEntity[]> {
    await this.findById(mountId);
    return this.assignmentsRepo.find({ where: { remoteFsMountId: mountId } });
  }

  async assignServer(
    actorId: string,
    mountId: string,
    serverId: string,
  ): Promise<RemoteFsServerAssignmentEntity & { operationId?: string }> {
    const mount = await this.findById(mountId);

    let assignment = await this.assignmentsRepo.findOne({ where: { remoteFsMountId: mountId, serverId } });
    if (!assignment) {
      assignment = this.assignmentsRepo.create({ id: uuidv4(), remoteFsMountId: mountId, serverId });
      await this.assignmentsRepo.save(assignment);
      await this.auditService.log(actorId, AuditAction.AssignRemoteFsServer, mountId, 'remote_fs_mount', { serverId });
      // Invalidate so that the new server appears in users' resolveMountSources cache.
      this.accessResolver.invalidateAll();
    }

    const dispatched = await this.dispatchMount(mount, serverId, actorId).catch(() => null);
    return Object.assign(assignment, {
      operationId: dispatched?.operationId,
    });
  }

  async unassignServer(actorId: string, mountId: string, serverId: string): Promise<{ ok: true; operationIds: string[] }> {
    const assignment = await this.assignmentsRepo.findOne({ where: { remoteFsMountId: mountId, serverId } });
    if (!assignment) return { ok: true, operationIds: [] };

    const inUse = await this.containerMountsRepo.findOne({
      where: { sourceKind: 'remote', sourceId: mountId, serverId },
    });
    if (inUse) {
      throw new ConflictException(
        `Cannot unassign: container "${inUse.containerName}" on this server still references this mount`,
      );
    }

    const dataDirInUse = await this.dataDirectoriesRepo.findOne({
      where: { sourceKind: 'remote', sourceId: mountId },
    });
    if (dataDirInUse) {
      throw new ConflictException(
        'Cannot unassign: this remote FS mount still has data directories; delete those data directories first',
      );
    }

    const dispatched = await this.dispatchMountRemove(mountId, serverId, actorId, 'assignment').catch(() => null);
    await this.auditService.log(actorId, AuditAction.UnassignRemoteFsServer, mountId, 'remote_fs_mount', { serverId });
    return {
      ok: true,
      operationIds: dispatched ? [dispatched.operationId] : [],
    };
  }

  // ---------------------------------------------------------------------------
  // Gateway hooks
  // ---------------------------------------------------------------------------

  async dispatchAll(serverId: string): Promise<void> {
    const mounts = await this.list(serverId);
    await Promise.all(
      mounts.map((mount) => this.dispatchMount(mount, serverId, null).catch(() => {})),
    );
  }

  async getMountStatuses(mountId: string, serverIds: string[]): Promise<Record<string, RemoteFsMountStatus>> {
    const result: Record<string, RemoteFsMountStatus> = {};
    for (const serverId of serverIds) {
      const status = this.agentGateway.stateCache.getRemoteFsMountStatus(serverId, mountId);
      if (!status) continue;
      result[serverId] = status;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async dispatchMount(
    mount: RemoteFsMountEntity,
    serverId: string,
    requestedBy: string | null,
  ): Promise<{ operationId: string }> {
    const payload = {
      id: mount.id,
      hostMountPoint: mount.hostMountPoint,
      options: mount.options,
      params: mount.params,
    };

    const dispatched = await this.operationsService.dispatchAgentCommand(
      {
        operationKind: OperationKind.RemoteFsApply,
        commandKind: AgentCommandKind.RemoteFsApply,
        serverId,
        resourceType: 'remote_fs_mount',
        resourceId: mount.id,
        requestedBy,
        payload,
      },
    );
    return { operationId: dispatched.operationId };
  }

  private async dispatchMountRemove(
    mountId: string,
    serverId: string,
    requestedBy: string | null,
    scope: 'mount' | 'assignment' = 'mount',
  ): Promise<{ operationId: string }> {
    const mount = await this.findById(mountId);
    const dispatched = await this.operationsService.dispatchAgentCommand({
      operationKind: OperationKind.RemoteFsApply,
      commandKind: AgentCommandKind.RemoteFsRemove,
      serverId,
      resourceType: 'remote_fs_mount',
      resourceId: mountId,
      requestedBy,
      payload: { id: mountId, force: true },
      request: { scope, mountId, serverId },
      beforePersist: async (manager, context) => {
        if (scope === 'assignment') {
          const assignment = await manager.findOne(RemoteFsServerAssignmentEntity, {
            where: { remoteFsMountId: mountId, serverId },
          });
          if (assignment) {
            assignment.desiredState = 'removing';
            assignment.generation = (assignment.generation ?? 0) + 1;
            assignment.lastOperationId = context.operationId;
            await manager.save(RemoteFsServerAssignmentEntity, assignment);
          }
          return;
        }
        await manager.update(RemoteFsMountEntity, mount.id, {
          desiredState: 'removing',
          generation: (mount.generation ?? 0) + 1,
          lastOperationId: context.operationId,
        });
        const assignments = await manager.find(RemoteFsServerAssignmentEntity, {
          where: { remoteFsMountId: mountId },
        });
        if (assignments.length > 0) {
          await manager.save(RemoteFsServerAssignmentEntity, assignments.map((assignment) => {
            assignment.desiredState = 'removing';
            assignment.generation = (assignment.generation ?? 0) + 1;
            assignment.lastOperationId = context.operationId;
            return assignment;
          }));
        }
      },
    });
    return { operationId: dispatched.operationId };
  }
}
