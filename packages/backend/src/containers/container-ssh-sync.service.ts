import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AgentCommandKind,
  ContainerPhase,
  ContainerStatus,
  OperationKind,
} from '@nyabase/common';
import { In, Repository } from 'typeorm';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { OperationsService } from '../operations/operations.service.js';
import { ResourceKeyService } from '../operations/resource-key.service.js';
import { SshIdentityService } from '../ssh/ssh-identity.service.js';

@Injectable()
export class ContainerSshSyncService {
  private readonly logger = new Logger(ContainerSshSyncService.name);

  constructor(
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
    @InjectRepository(ContainerLifecycleEntity)
    private lifecycleRepo: Repository<ContainerLifecycleEntity>,
    @InjectRepository(ImageEntity)
    private imagesRepo: Repository<ImageEntity>,
    private agentGateway: AgentGateway,
    private operations: OperationsService,
    private resourceKeys: ResourceKeyService,
    private sshIdentities: SshIdentityService,
  ) {}

  async enqueueForUser(userId: string): Promise<void> {
    const containers = (await this.containersRepo.find({ where: { ownerId: userId } }))
      .filter((container) => !container.deletedAt);
    if (containers.length === 0) return;

    const containerIds = containers.map((container) => container.id);
    const [lifecycleRows, images, internalKey] = await Promise.all([
      this.lifecycleRepo.find({ where: { containerId: In(containerIds) } }),
      this.imagesRepo.find({ where: { id: In([...new Set(containers.map((container) => container.imageId))]) } }),
      this.sshIdentities.getUserInternalPublicKey(userId),
    ]);
    const lifecycleByContainer = new Map(lifecycleRows.map((lifecycle) => [lifecycle.containerId, lifecycle]));
    const imageById = new Map(images.map((image) => [image.id, image]));

    for (const container of containers) {
      const lifecycle = lifecycleByContainer.get(container.id);
      if (!lifecycle || lifecycle.phase !== ContainerPhase.Active || lifecycle.activeOperationId || !lifecycle.boundRuntimeId) continue;
      const runtime = this.agentGateway.stateCache.getContainerByContainerId(container.serverId, container.id);
      if (!runtime || runtime.status !== ContainerStatus.Running) continue;
      const image = imageById.get(container.imageId);
      const enabled = image?.disableSsh !== true;

      try {
        await this.operations.enqueueCommand({
          kind: OperationKind.ContainerReconcileSsh,
          commandKind: AgentCommandKind.RuntimeContainerSshApply,
          serverId: container.serverId,
          resourceType: 'container',
          resourceId: container.id,
          requestedBy: userId,
          request: { action: 'internalSshKeySync', generation: internalKey.generation, enabled },
          payload: {
            containerId: container.id,
            runtimeId: lifecycle.boundRuntimeId,
            enabled,
            ...(enabled ? {
              internalPublicKey: internalKey.publicKey,
              internalKeyGeneration: internalKey.generation,
            } : {}),
          },
          baseResourceKeys: [this.resourceKeys.container(container.id)],
          unlockReportKind: 'state',
          beforeCommit: async (manager, context) => {
            const latestLifecycle = await manager.findOne(ContainerLifecycleEntity, {
              where: { containerId: container.id },
            });
            if (
              !latestLifecycle
              || latestLifecycle.phase !== ContainerPhase.Active
              || latestLifecycle.activeOperationId
              || !latestLifecycle.boundRuntimeId
            ) {
              throw new Error(`Container ${container.id} is not ready for SSH key sync`);
            }
            await manager.update(ContainerLifecycleEntity, container.id, {
              phase: ContainerPhase.Updating,
              activeOperationId: context.operationId,
              lastTransitionAt: new Date(),
              failureReason: null,
              failureCode: null,
            });
          },
        });
      } catch (error) {
        this.logger.warn(`SSH key sync enqueue skipped for container ${container.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
