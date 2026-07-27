import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { ImageRecord } from '../domain/domain-records.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import {
  WorkflowRepository,
  type WorkflowTaskSummary,
} from '../agent-tasks/workflow.repository.js';
import { AGENT_TASK_MIN_RETENTION_MS } from '../agent-tasks/agent-task-retention.service.js';
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
import { postCommitBestEffort } from '../common/post-commit.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '@nyabase/common';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';

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

function advanceImageRevision(image: ImageRecord): void {
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
    private readonly infrastructure: InfrastructureRepository,
    private agentGateway: AgentGateway,
    private readonly workflow: WorkflowEnqueuePort,
    private readonly workflowRepository: WorkflowRepository,
    private resourceKeys: ResourceKeyService,
    private sshProxyGateway: SshProxyGateway,
    private readonly transactions: PgTransactionManager,
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
    const saved = await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction, actorId, [Capability.ManageImages],
      );
      await this.infrastructure.lockImageCapacity(transaction);
      if (await this.infrastructure.countImages(transaction) >= MAX_PLATFORM_IMAGES) {
        throw new ConflictException({
          code: 'IMAGE_CAPACITY_REACHED',
          message: `At most ${MAX_PLATFORM_IMAGES} images are supported`,
        });
      }
      const created = await this.infrastructure.insertImage({
        id: uuidv4(),
        name: dto.name,
        dockerImage,
        runtimeOverrides,
        description: dto.description ?? null,
        isActive: true,
        disableSsh: dto.disableSsh ?? false,
      }, transaction);
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.CreateImage,
        created.id,
        'image',
        {
          name: created.name,
          dockerImage: created.dockerImage,
          disableSsh: created.disableSsh,
        },
      );
      return created;
    }).catch((error: unknown) => {
      if (!isPgUniqueViolation(error)) throw error;
      const constraint = (error as { constraint?: string }).constraint ?? '';
      throw new ConflictException(
        constraint.includes('docker_image')
          ? 'Docker image reference already has a logical owner'
          : 'Image name already has a logical owner',
      );
    });
    await postCommitBestEffort(
      'Image create SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    return this.toAdminDto(saved);
  }

  async findAllAdmin(activeOnly = false): Promise<AdminImageDto[]> {
    const rows = activeOnly
      ? await this.infrastructure.listActiveImages()
      : await this.infrastructure.listImages();
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
    const rows = (await this.infrastructure.listImages()).filter((image) =>
      imageIdSet.has(image.id)
      && !image.deleting
      && (!activeOnly || image.isActive));
    return rows.map((image) => this.toDto(image));
  }

  async findById(id: string) {
    const img = await this.infrastructure.findImageById(id);
    if (!img) throw new NotFoundException('Image not found');
    return img;
  }

  async findAdminDtoById(id: string): Promise<AdminImageDto> {
    return this.toAdminDto(await this.findById(id));
  }

  toDto(image: ImageRecord): ImageDto {
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
    const saved = await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction, actorId, [Capability.ManageImages],
      );
      const img = await this.infrastructure.findImageById(id, transaction);
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
      advanceImageRevision({ ...img });
      const updated = await this.infrastructure.updateImageCas(
        id,
        expectedRevision,
        {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.runtimeOverrides !== undefined
            ? { runtimeOverrides: normalizeRuntimeOverrides(dto.runtimeOverrides) }
            : {}),
          ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(dto.disableSsh !== undefined ? { disableSsh: dto.disableSsh } : {}),
        },
        transaction,
      );
      if (!updated) {
        const current = await this.infrastructure.findImageById(id, transaction);
        throw new ConflictException({
          code: 'IMAGE_REVISION_CONFLICT',
          message: 'Image changed; reload and resolve the conflicting fields',
          current: current ? this.toAdminDto(current) : null,
        });
      }
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.UpdateImage,
        id,
        'image',
        dto,
      );
      return updated;
    }).catch((error: unknown) => {
      if (isPgUniqueViolation(error)) {
        throw new ConflictException('Image name already has a logical owner');
      }
      throw error;
    });
    await postCommitBestEffort(
      'Image update SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    return this.toAdminDto(saved);
  }

  async delete(actorId: string, id: string) {
    const result = await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction, actorId, [Capability.ManageImages],
      );
      const img = await this.infrastructure.findImageById(id, transaction);
      if (!img) throw new NotFoundException('Image not found');
      const grant = await transaction
        .selectFrom('iam.image_grants')
        .select('id')
        .where('image_id', '=', id)
        .executeTakeFirst();
      if (grant) {
        throw new ConflictException('Image is still referenced by a container, grant, or retained task lock');
      }
      const [container, retainedClaim] = await Promise.all([
        transaction.selectFrom('control.containers')
          .select('id')
          .where('image_id', '=', id)
          .limit(1)
          .executeTakeFirst(),
        transaction.selectFrom('workflow.resource_claims')
          .select('resource_key')
          .where('resource_key', 'like', `image:%:${id}`)
          .limit(1)
          .executeTakeFirst(),
      ]);
      if (container || retainedClaim) {
        throw new ConflictException(
          'Image is still referenced by a container, grant, or retained task lock',
        );
      }
      const servers = await this.infrastructure.listServers(transaction);
      const deleting = await this.infrastructure.markImageDeletingCas(
        id,
        img.revision,
        transaction,
      );
      if (!deleting) throw new ConflictException('Image cleanup is already in progress');
      const cleanupTasks: ImagePullTaskRef[] = [];
      for (const server of servers) {
        const task = await this.workflow.enqueueInTransaction(transaction, {
          kind: AgentTaskKind.ImageEnsureAbsent,
          serverId: server.id,
          resourceType: 'image',
          resourceId: deleting.id,
          requestedBy: actorId,
          request: {
            action: 'delete_image',
            dockerRef: deleting.dockerImage,
            cleanupGeneration: deleting.cleanupGeneration,
          },
          payload: {
            dockerRef: deleting.dockerImage,
            imageId: deleting.id,
          },
          resourceKeys: [this.resourceKeys.image(server.id, deleting.id)],
        });
        cleanupTasks.push({ ...task, serverId: server.id });
      }
      if (servers.length === 0) {
        await this.infrastructure.deleteImage(id, transaction);
      }
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.DeleteImage,
        id,
        'image',
        {
          name: deleting.name,
          dockerImage: deleting.dockerImage,
          cleanupGeneration: deleting.cleanupGeneration,
        },
      );
      return {
        cleanupTasks,
      };
    });
    await postCommitBestEffort(
      'Image delete SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    return { tasks: result.cleanupTasks };
  }

  /** Get per-server status for an image (present / pulling / absent) */
  async getServerStatuses(image: ImageRecord): Promise<ImageServerStatus[]> {
    const servers = await this.infrastructure.listServers();
    const recentTasks = (await this.workflowRepository.listTasks({
      resourceType: 'image',
      resourceId: image.id,
      limit: 100,
    })).map((task) => this.toUserTask(task));
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
    image: ImageRecord,
    serverIds?: string[],
  ): Promise<ImagePullResponse> {
    const targetIds = serverIds
      ? [...new Set(serverIds)]
      : (await this.infrastructure.listServers()).map((server) => server.id);

    const tasks: ImagePullTaskRef[] = [];
    const rejected: ImagePullResponse['rejected'] = [];

    for (const serverId of targetIds) {
      try {
        const task = await this.transactions.run(async (transaction) => {
          await this.accessResolver.assertActorCapabilitiesInTransaction(
            transaction,
            actorId,
            [Capability.ManageImages],
          );
          const current = await this.infrastructure.findImageById(
            image.id,
            transaction,
          );
          if (!current) throw new NotFoundException('Image not found');
          if (current.deleting) {
            throw new ConflictException('Image cleanup is in progress');
          }
          if (current.dockerImage !== image.dockerImage) {
            throw new ConflictException(
              'Image reference changed while preparing pull; retry',
            );
          }
          const task = await this.workflow.enqueueInTransaction(transaction, {
            kind: AgentTaskKind.ImageEnsurePresent,
            serverId,
            resourceType: 'image',
            resourceId: image.id,
            requestedBy: actorId,
            payload: { dockerRef: image.dockerImage, imageId: image.id },
            resourceKeys: [this.resourceKeys.image(serverId, image.id)],
          });
          await this.auditService.append(
            transaction,
            actorId,
            AuditAction.PullImage,
            image.id,
            'image',
            {
              dockerImage: image.dockerImage,
              requestedServerIds: targetIds,
              serverId,
              taskId: task.taskId,
            },
          );
          return task;
        });
        tasks.push({ ...task, serverId });
      } catch (err) {
        if (err instanceof ForbiddenException && tasks.length === 0) throw err;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Pull enqueue failed on ${serverId}: ${message}`);
        rejected.push({ serverId, message });
      }
    }

    return { tasks, rejected };
  }

  private toAdminDto(image: ImageRecord): AdminImageDto {
    return {
      ...this.toDto(image),
      revision: image.revision,
      deleting: image.deleting,
      cleanupGeneration: image.cleanupGeneration,
      createdAt: image.createdAt.toISOString(),
      updatedAt: image.updatedAt.toISOString(),
    };
  }

  private toUserTask(task: WorkflowTaskSummary): UserAgentTaskDto {
    const error = task.error
      ? task.failureStage === 'dispatch'
        ? {
            code: 'TASK_DISPATCH_FAILED' as const,
            message: 'The task could not be sent to the server',
          }
        : task.failureStage === 'agent'
          ? {
              code: 'TASK_EXECUTION_FAILED' as const,
              message: 'The server could not complete the task',
            }
          : task.failureStage === 'finalizer'
            ? {
                code: 'TASK_FINALIZATION_FAILED' as const,
                message:
                  'The server completed the task, but control-plane finalization failed',
              }
            : { code: 'TASK_FAILED' as const, message: 'The task failed' }
      : null;
    return {
      id: task.id,
      kind: task.kind as AgentTaskKind,
      status: task.status,
      resourceType: task.resourceType,
      resourceId: task.resourceId,
      serverId: task.serverId,
      error,
      failureStage: task.failureStage,
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt?.toISOString() ?? null,
      lastSentAt: task.lastSentAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      retentionUntil: task.completedAt
        ? new Date(
            task.completedAt.getTime() + AGENT_TASK_MIN_RETENTION_MS,
          ).toISOString()
        : null,
    };
  }
}

function isPgUniqueViolation(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === '23505';
}
