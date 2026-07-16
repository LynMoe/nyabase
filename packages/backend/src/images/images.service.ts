import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Like, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import type { AccessResolverService } from '../access/access-resolver.service.js';
import {
  AgentTaskKind,
  normalizeDockerImageRef,
  type AgentTaskDto,
  type AgentTaskRefResponse,
  MAX_PLATFORM_IMAGES,
} from '@nyabase/common';
import type { ImageRuntimeOverrides } from '@nyabase/common';
import { SshProxyGateway } from '../ssh/ssh-proxy-gateway.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { postCommitBestEffort } from '../common/post-commit.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';

const DEFAULT_RUNTIME_OVERRIDES: ImageRuntimeOverrides = {
  uid: 0,
  entrypoint: null,
  cmd: null,
  init: false,
};

function normalizeRuntimeOverrides(
  overrides: ImageRuntimeOverrides | undefined,
): ImageRuntimeOverrides {
  return {
    ...DEFAULT_RUNTIME_OVERRIDES,
    ...(overrides ?? {}),
  };
}

export interface ImageServerStatus {
  serverId: string;
  serverName: string;
  hostname: string;
  online: boolean;
  present: boolean;
  task: AgentTaskDto | null;
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
  ) {}

  async create(dto: {
    name: string;
    dockerImage: string;
    runtimeOverrides?: ImageRuntimeOverrides;
    description?: string;
    disableSsh?: boolean;
  }) {
    const runtimeOverrides = normalizeRuntimeOverrides(dto.runtimeOverrides);
    const dockerImage = normalizeDockerImageRef(dto.dockerImage);
    const saved = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (await manager.count(ImageEntity) >= MAX_PLATFORM_IMAGES) {
        throw new ConflictException({
          code: 'IMAGE_CAPACITY_REACHED',
          message: `At most ${MAX_PLATFORM_IMAGES} images are supported`,
        });
      }
      if (await manager.existsBy(ImageEntity, { dockerImage })) {
        throw new ConflictException('Docker image reference already has a logical owner');
      }
      return manager.save(ImageEntity, manager.create(ImageEntity, {
        id: uuidv4(),
        ...dto,
        dockerImage,
        runtimeOverrides,
        description: dto.description ?? null,
        disableSsh: dto.disableSsh ?? false,
      }));
    });
    await postCommitBestEffort(
      'Image create SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    return saved;
  }

  async findAll(activeOnly = false) {
    if (activeOnly) return this.repo.find({ where: { isActive: true } });
    return this.repo.find();
  }

  /** Returns images accessible to the user (in at least one accessible server's grants) */
  async findAccessibleForUser(
    userId: string,
    activeOnly: boolean,
    accessResolver: AccessResolverService,
  ): Promise<ImageEntity[]> {
    const servers = await accessResolver.getEffectiveAccess(userId);
    const imageIdSet = new Set<string>();
    for (const s of servers) {
      for (const id of s.allowedImageIds) imageIdSet.add(id);
    }
    if (imageIdSet.size === 0) return [];
    const ids = Array.from(imageIdSet);
    if (activeOnly) {
      return this.repo.find({ where: ids.map((id) => ({ id, isActive: true })) });
    }
    return this.repo.find({ where: ids.map((id) => ({ id })) });
  }

  async findById(id: string) {
    const img = await this.repo.findOne({ where: { id } });
    if (!img) throw new NotFoundException('Image not found');
    return img;
  }

  async update(id: string, dto: {
    name?: string;
    dockerImage?: string;
    runtimeOverrides?: ImageRuntimeOverrides;
    description?: string | null;
    isActive?: boolean;
    disableSsh?: boolean;
  }) {
    const saved = await runSerializedTransaction(this.dataSource, async (manager) => {
      const img = await manager.findOneBy(ImageEntity, { id });
      if (!img) throw new NotFoundException('Image not found');
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
      if (dto.name !== undefined) img.name = dto.name;
      if (dto.runtimeOverrides !== undefined) {
        img.runtimeOverrides = normalizeRuntimeOverrides(dto.runtimeOverrides);
      }
      if (dto.description !== undefined) img.description = dto.description ?? null;
      if (dto.isActive !== undefined) img.isActive = dto.isActive;
      if (dto.disableSsh !== undefined) img.disableSsh = dto.disableSsh;
      return manager.save(ImageEntity, img);
    });
    await postCommitBestEffort(
      'Image update SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    return saved;
  }

  async delete(id: string) {
    const tasks = await runSerializedTransaction(this.dataSource, async (manager) => {
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
      await manager.save(ImageEntity, img);

      const cleanupTasks: ImagePullTaskRef[] = [];
      for (const server of servers) {
        const task = await this.tasks.enqueueInTransaction(manager, {
          kind: AgentTaskKind.ImageEnsureAbsent,
          serverId: server.id,
          resourceType: 'image',
          resourceId: img.id,
          requestedBy: null,
          request: { action: 'delete_image', dockerRef: img.dockerImage, cleanupGeneration },
          payload: { dockerRef: img.dockerImage, imageId: img.id },
          resourceKeys: [this.resourceKeys.image(server.id, img.id)],
        });
        cleanupTasks.push({ ...task, serverId: server.id });
      }
      if (servers.length === 0) await manager.remove(ImageEntity, img);
      return cleanupTasks;
    });
    await postCommitBestEffort(
      'Image delete SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    return { tasks };
  }

  /** Get per-server status for an image (present / pulling / absent) */
  async getServerStatuses(image: ImageEntity): Promise<ImageServerStatus[]> {
    const servers = await this.serversRepo.find({ order: { name: 'ASC' } });
    const recentTasks = await this.tasks.listForAdmin({
      resourceType: 'image',
      resourceId: image.id,
      limit: 100,
    });
    const latestTaskByServer = new Map<string, AgentTaskDto>();
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
  async pullOnServers(image: ImageEntity, serverIds?: string[]): Promise<ImagePullResponse> {
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
          requestedBy: null,
          payload: { dockerRef: image.dockerImage, imageId: image.id },
          resourceKeys: [this.resourceKeys.image(serverId, image.id)],
          beforeCommit: async (manager) => {
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
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Pull enqueue failed on ${serverId}: ${message}`);
        rejected.push({ serverId, message });
      }
    }

    return { tasks, rejected };
  }
}
