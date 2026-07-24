import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Like, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import {
  AgentTaskKind,
  normalizeDockerImageRef,
  type UserAgentTaskDto,
  type AgentTaskRefResponse,
  type ImageDto,
  type AdminImageDto,
  MAX_PLATFORM_IMAGES,
  Capability,
} from '@nyabase/common';
import type { ImageRuntimeOverrides } from '@nyabase/common';
import { SshProxyGateway } from '../ssh/ssh-proxy-gateway.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { postCommitBestEffort } from '../common/post-commit.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '@nyabase/common';

const DEFAULT_RUNTIME_OVERRIDES: ImageRuntimeOverrides = {
  uid: 0,
  entrypoint: null,
  cmd: null,
  init: false,
};

function normalizeRuntimeOverrides(
  overrides: unknown,
): ImageRuntimeOverrides {
  const record = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
    ? overrides as Record<string, unknown>
    : {};
  const args = (value: unknown): string[] | null => Array.isArray(value)
    && value.length <= 256
    && value.every((item) => typeof item === 'string' && item.length >= 1 && item.length <= 4096)
    ? value
    : null;
  return {
    uid: Number.isInteger(record.uid) && (record.uid as number) >= 0
      && (record.uid as number) <= 0xffff_fffe
      ? record.uid as number
      : DEFAULT_RUNTIME_OVERRIDES.uid,
    entrypoint: args(record.entrypoint),
    cmd: args(record.cmd),
    init: typeof record.init === 'boolean' ? record.init : DEFAULT_RUNTIME_OVERRIDES.init,
  };
}

function advanceImageRevision(image: ImageEntity): void {
  if (!Number.isSafeInteger(image.revision) || image.revision < 1
    || image.revision === Number.MAX_SAFE_INTEGER) {
    throw new ConflictException({
      code: 'IMAGE_REVISION_EXHAUSTED',
      message: 'Image revision cannot be advanced safely',
    });
  }
  image.revision += 1;
}

export interface ImageServerStatus {
  serverId: string;
  serverName: string;
  hostname: string;
  online: boolean;
  present: boolean;
  task: UserAgentTaskDto | null;
}

export interface ImagePullTaskRef extends AgentTaskRefResponse {
  serverId: string;
}

export interface ImagePullResponse {
  tasks: ImagePullTaskRef[];
  rejected: Array<{ serverId: string; message: string }>;
}

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    @InjectRepository(ImageEntity)
    private repo: Repository<ImageEntity>,
    @InjectRepository(ServerEntity)
    private serversRepo: Repository<ServerEntity>,
    private agentGateway: AgentGateway,
    private tasks: AgentTasksService,
    private resourceKeys: ResourceKeyService,
    private sshProxyGateway: SshProxyGateway,
    private dataSource: DataSource,
    private auditService: AuditService,
    private accessResolver: AccessResolverService,
  ) {}

  async create(actorId: string, dto: {
    name: string;
    dockerImage: string;
    runtimeOverrides?: ImageRuntimeOverrides;
    description?: string | null;
    disableSsh?: boolean;
  }) {
    const runtimeOverrides = normalizeRuntimeOverrides(dto.runtimeOverrides);
    const dockerImage = normalizeDockerImageRef(dto.dockerImage);
    const saved = await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager, actorId, [Capability.ManageImages],
      );
      if (await manager.count(ImageEntity) >= MAX_PLATFORM_IMAGES) {
        throw new ConflictException({
          code: 'IMAGE_CAPACITY_REACHED',
          message: `At most ${MAX_PLATFORM_IMAGES} images are supported`,
        });
      }
      if (await manager.existsBy(ImageEntity, { dockerImage })) {
        throw new ConflictException('Docker image reference already has a logical owner');
      }
      if (await manager.existsBy(ImageEntity, { name: dto.name })) {
        throw new ConflictException('Image name already has a logical owner');
      }
      return manager.save(ImageEntity, manager.create(ImageEntity, {
        id: uuidv4(),
        ...dto,
        dockerImage,
        runtimeOverrides,
        description: dto.description ?? null,
        disableSsh: dto.disableSsh ?? false,
        revision: 1,
      }));
    });
    await postCommitBestEffort(
      'Image create SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    await postCommitBestEffort(
      'Image create audit',
      () => this.auditService.log(actorId, AuditAction.CreateImage, saved.id, 'image', {
        name: saved.name,
        dockerImage: saved.dockerImage,
        disableSsh: saved.disableSsh,
      }),
      this.logger,
    );
    return this.toAdminDto(saved);
  }

  async findAllAdmin(activeOnly = false): Promise<AdminImageDto[]> {
    const rows = await this.repo.find({
      ...(activeOnly ? { where: { isActive: true, deleting: false } } : {}),
      order: { name: 'ASC', id: 'ASC' },
    });
    return rows.map((image) => this.toAdminDto(image));
  }

  /** Returns images accessible to the user (in at least one accessible server's grants) */
  async findAccessibleForUser(
    userId: string,
    activeOnly: boolean,
    accessResolver: AccessResolverService,
  ): Promise<ImageDto[]> {
    const servers = await accessResolver.getEffectiveAccess(userId);
    const imageIdSet = new Set<string>();
    for (const s of servers) {
      for (const id of s.allowedImageIds) imageIdSet.add(id);
    }
    if (imageIdSet.size === 0) return [];
    const ids = Array.from(imageIdSet);
    if (activeOnly) {
      const rows = await this.repo.find({
        where: ids.map((id) => ({ id, isActive: true, deleting: false })),
      });
      return rows.map((image) => this.toDto(image));
    }
    const rows = await this.repo.find({
      where: ids.map((id) => ({ id, deleting: false })),
    });
    return rows.map((image) => this.toDto(image));
  }

  async findById(id: string) {
    const img = await this.repo.findOne({ where: { id } });
    if (!img) throw new NotFoundException('Image not found');
    return img;
  }

  async findAdminDtoById(id: string): Promise<AdminImageDto> {
    return this.toAdminDto(await this.findById(id));
  }

  toDto(image: ImageEntity): ImageDto {
    return {
      id: image.id,
      name: image.name,
      dockerImage: image.dockerImage,
      runtimeOverrides: normalizeRuntimeOverrides(image.runtimeOverrides),
      description: image.description,
      isActive: image.isActive,
      disableSsh: image.disableSsh,
    };
  }

  async update(actorId: string, id: string, dto: {
    name?: string;
    dockerImage?: string;
    runtimeOverrides?: ImageRuntimeOverrides;
    description?: string | null;
    isActive?: boolean;
    disableSsh?: boolean;
  }, expectedRevision: number) {
    const saved = await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager, actorId, [Capability.ManageImages],
      );
      const img = await manager.findOneBy(ImageEntity, { id });
      if (!img) throw new NotFoundException('Image not found');
      if (img.revision !== expectedRevision) {
        throw new ConflictException({
          code: 'IMAGE_REVISION_CONFLICT',
          message: 'Image changed; reload and resolve the conflicting fields',
          current: this.toAdminDto(img),
        });
      }
      if (img.deleting) {
        throw new ConflictException('Image cleanup is in progress; retry deletion after its tasks finish');
      }
      if (
        dto.dockerImage !== undefined
        && normalizeDockerImageRef(dto.dockerImage) !== img.dockerImage
      ) {
        throw new ConflictException(
          'Docker image reference is immutable; create a new image and delete the old image after use',
        );
      }
      if (dto.name !== undefined && dto.name !== img.name) {
        if (await manager.existsBy(ImageEntity, { name: dto.name })) {
          throw new ConflictException('Image name already has a logical owner');
        }
        img.name = dto.name;
      }
      if (dto.runtimeOverrides !== undefined) {
        img.runtimeOverrides = normalizeRuntimeOverrides(dto.runtimeOverrides);
      }
      if (dto.description !== undefined) img.description = dto.description ?? null;
      if (dto.isActive !== undefined) img.isActive = dto.isActive;
      if (dto.disableSsh !== undefined) img.disableSsh = dto.disableSsh;
      advanceImageRevision(img);
      return manager.save(ImageEntity, img);
    });
    await postCommitBestEffort(
      'Image update SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    await postCommitBestEffort(
      'Image update audit',
      () => this.auditService.log(actorId, AuditAction.UpdateImage, id, 'image', dto),
      this.logger,
    );
    return this.toAdminDto(saved);
  }

  async delete(actorId: string, id: string) {
    const result = await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager, actorId, [Capability.ManageImages],
      );
      const img = await manager.findOneBy(ImageEntity, { id });
      if (!img) throw new NotFoundException('Image not found');
      const [containerCount, grantCount, retainedLockCount, servers] = await Promise.all([
        manager.countBy(ContainerEntity, { imageId: id }),
        manager.count(ImageGrantEntity, { where: { imageId: id } }),
        manager.count(ResourceLockEntity, {
          where: { resourceKey: Like(`image:%:${id}`) },
        }),
        manager.find(ServerEntity, { order: { id: 'ASC' } }),
      ]);
      if (containerCount > 0 || grantCount > 0 || retainedLockCount > 0) {
        throw new ConflictException('Image is still referenced by a container, grant, or retained task lock');
      }

      const cleanupGeneration = img.cleanupGeneration + 1;
      img.deleting = true;
      img.isActive = false;
      img.cleanupGeneration = cleanupGeneration;
      advanceImageRevision(img);
      await manager.save(ImageEntity, img);

      const cleanupTasks: ImagePullTaskRef[] = [];
      for (const server of servers) {
        const task = await this.tasks.enqueueInTransaction(manager, {
          kind: AgentTaskKind.ImageEnsureAbsent,
          serverId: server.id,
          resourceType: 'image',
          resourceId: img.id,
          requestedBy: actorId,
          request: { action: 'delete_image', dockerRef: img.dockerImage, cleanupGeneration },
          payload: { dockerRef: img.dockerImage, imageId: img.id },
          resourceKeys: [this.resourceKeys.image(server.id, img.id)],
        });
        cleanupTasks.push({ ...task, serverId: server.id });
      }
      if (servers.length === 0) await manager.remove(ImageEntity, img);
      return {
        tasks: cleanupTasks,
        name: img.name,
        dockerImage: img.dockerImage,
        cleanupGeneration,
      };
    });
    await postCommitBestEffort(
      'Image delete SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    await postCommitBestEffort(
      'Image delete audit',
      () => this.auditService.log(actorId, AuditAction.DeleteImage, id, 'image', {
        name: result.name,
        dockerImage: result.dockerImage,
        cleanupGeneration: result.cleanupGeneration,
        taskIds: result.tasks.map((task) => task.taskId),
      }),
      this.logger,
    );
    return { tasks: result.tasks };
  }

  /** Get per-server status for an image (present / pulling / absent) */
  async getServerStatuses(image: ImageEntity): Promise<ImageServerStatus[]> {
    const servers = await this.serversRepo.find({ order: { name: 'ASC' } });
    const recentTasks = await this.tasks.listPurposeSafe({
      resourceType: 'image',
      resourceId: image.id,
      limit: 100,
    });
    const latestTaskByServer = new Map<string, UserAgentTaskDto>();
    for (const task of recentTasks) {
      if (!latestTaskByServer.has(task.serverId)) latestTaskByServer.set(task.serverId, task);
    }
    const results: ImageServerStatus[] = [];

    for (const server of servers) {
      const online = this.agentGateway.isOnline(server.id);

      const present = this.agentGateway.stateCache.hasImage(server.id, image.dockerImage);

      const status: ImageServerStatus = {
        serverId: server.id,
        serverName: server.name,
        hostname: server.name,
        online,
        present,
        task: latestTaskByServer.get(server.id) ?? null,
      };

      results.push(status);
    }

    return results;
  }

  /** Trigger pull on one or all servers */
  async pullOnServers(
    actorId: string,
    image: ImageEntity,
    serverIds?: string[],
  ): Promise<ImagePullResponse> {
    const targetIds = serverIds
      ? [...new Set(serverIds)]
      : (await this.serversRepo.find({ order: { name: 'ASC' } })).map((server) => server.id);

    const tasks: ImagePullTaskRef[] = [];
    const rejected: ImagePullResponse['rejected'] = [];

    for (const serverId of targetIds) {
      try {
        const task = await this.tasks.enqueue({
          kind: AgentTaskKind.ImageEnsurePresent,
          serverId,
          resourceType: 'image',
          resourceId: image.id,
          requestedBy: actorId,
          payload: { dockerRef: image.dockerImage, imageId: image.id },
          resourceKeys: [this.resourceKeys.image(serverId, image.id)],
          beforeCommit: async (manager) => {
            await this.accessResolver.assertActorCapabilitiesInTransaction(
              manager, actorId, [Capability.ManageImages],
            );
            const current = await manager.findOneBy(ImageEntity, { id: image.id });
            if (!current) throw new NotFoundException('Image not found');
            if (current.deleting) {
              throw new ConflictException('Image cleanup is in progress');
            }
            if (current.dockerImage !== image.dockerImage) {
              throw new ConflictException('Image reference changed while preparing pull; retry');
            }
          },
        });
        tasks.push({ ...task, serverId });
      } catch (err) {
        if (err instanceof ForbiddenException && tasks.length === 0) throw err;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Pull enqueue failed on ${serverId}: ${message}`);
        rejected.push({ serverId, message });
      }
    }

    await postCommitBestEffort(
      'Image pull audit',
      () => this.auditService.log(actorId, AuditAction.PullImage, image.id, 'image', {
        dockerImage: image.dockerImage,
        requestedServerIds: targetIds,
        taskIds: tasks.map((task) => task.taskId),
        rejected,
      }),
      this.logger,
    );
    return { tasks, rejected };
  }

  private toAdminDto(image: ImageEntity): AdminImageDto {
    return {
      ...this.toDto(image),
      revision: image.revision,
      deleting: image.deleting,
      cleanupGeneration: image.cleanupGeneration,
      createdAt: image.createdAt.toISOString(),
      updatedAt: image.updatedAt.toISOString(),
    };
  }
}
