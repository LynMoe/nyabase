import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { OperationsService } from '../operations/operations.service.js';
import type { AccessResolverService } from '../access/access-resolver.service.js';
import { AgentCommandKind, OperationKind } from '@nyabase/common';
import type { ImageRuntimeOverrides } from '@nyabase/common';

const DEFAULT_RUNTIME_OVERRIDES: ImageRuntimeOverrides = {
  uid: 0,
  entrypoint: null,
  cmd: null,
  init: false,
};

function normalizeRuntimeOverrides(
  overrides: ImageRuntimeOverrides | undefined,
  defaultUid?: number,
): ImageRuntimeOverrides {
  return {
    ...DEFAULT_RUNTIME_OVERRIDES,
    ...(overrides ?? {}),
    uid: overrides?.uid ?? defaultUid ?? DEFAULT_RUNTIME_OVERRIDES.uid,
  };
}

export interface ImageServerStatus {
  serverId: string;
  serverName: string;
  hostname: string;
  online: boolean;
  present: boolean;
  /** If a pull is in progress */
  pulling?: {
    progress: number;
    message: string;
  };
  error?: string;
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
    private operationsService: OperationsService,
  ) {}

  async create(dto: {
    name: string;
    dockerImage: string;
    runtimeOverrides?: ImageRuntimeOverrides;
    defaultUid?: number;
    description?: string;
  }) {
    const runtimeOverrides = normalizeRuntimeOverrides(dto.runtimeOverrides, dto.defaultUid);
    return this.repo.save(
      this.repo.create({
        id: uuidv4(),
        ...dto,
        defaultUid: runtimeOverrides.uid,
        runtimeOverrides,
        description: dto.description ?? null,
      }),
    );
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
    defaultUid?: number;
    description?: string | null;
    isActive?: boolean;
  }) {
    const img = await this.findById(id);
    if (dto.name !== undefined) img.name = dto.name;
    if (dto.dockerImage !== undefined) img.dockerImage = dto.dockerImage;
    if (dto.runtimeOverrides !== undefined) {
      img.runtimeOverrides = normalizeRuntimeOverrides(dto.runtimeOverrides, dto.defaultUid);
      img.defaultUid = img.runtimeOverrides.uid;
    } else if (dto.defaultUid !== undefined) {
      img.runtimeOverrides = {
        ...normalizeRuntimeOverrides(img.runtimeOverrides, img.defaultUid),
        uid: dto.defaultUid,
      };
      img.defaultUid = dto.defaultUid;
    } else if (!img.runtimeOverrides) {
      img.runtimeOverrides = normalizeRuntimeOverrides(undefined, img.defaultUid);
    }
    if (dto.description !== undefined) img.description = dto.description ?? null;
    if (dto.isActive !== undefined) img.isActive = dto.isActive;
    return this.repo.save(img);
  }

  async delete(id: string) {
    const img = await this.findById(id);
    await this.repo.remove(img);
  }

  /** Get per-server status for an image (present / pulling / absent) */
  async getServerStatuses(image: ImageEntity): Promise<ImageServerStatus[]> {
    const servers = await this.serversRepo.find({ order: { name: 'ASC' } });
    const results: ImageServerStatus[] = [];

    for (const server of servers) {
      const online = this.agentGateway.isOnline(server.id);

      const pullKey = `${server.id}:${image.dockerImage}`;
      const pp = this.agentGateway.pullProgress.get(pullKey);

      const present = pp?.status === 'done';

      const status: ImageServerStatus = {
        serverId: server.id,
        serverName: server.name,
        hostname: server.name,
        online,
        present,
      };

      if (pp && pp.status === 'pulling') {
        status.pulling = { progress: pp.progress, message: pp.message };
      } else if (pp && pp.status === 'error') {
        status.error = pp.error ?? pp.message;
      }

      results.push(status);
    }

    return results;
  }

  /** Trigger pull on one or all servers */
  async pullOnServers(image: ImageEntity, serverIds?: string[]): Promise<{ started: string[]; skipped: string[] }> {
    const servers = await this.serversRepo.find({ order: { name: 'ASC' } });
    const targets = serverIds
      ? servers.filter((s) => serverIds.includes(s.id))
      : servers;

    const started: string[] = [];
    const skipped: string[] = [];

    for (const server of targets) {
      if (!this.agentGateway.isOnline(server.id)) {
        skipped.push(server.id);
        continue;
      }

      try {
        await this.operationsService.dispatchAgentCommand({
          operationKind: OperationKind.ImagePull,
          commandKind: AgentCommandKind.ImagePull,
          serverId: server.id,
          resourceType: 'image',
          resourceId: image.id,
          requestedBy: null,
          payload: { dockerRef: image.dockerImage, imageId: image.id },
          resourceKey: `image:${server.id}:${image.id}`,
        });
        started.push(server.id);
      } catch (err) {
        this.logger.error(`Pull enqueue failed on ${server.id}: ${err instanceof Error ? err.message : String(err)}`);
        skipped.push(server.id);
      }
    }

    return { started, skipped };
  }
}
