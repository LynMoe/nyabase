import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  AgentCommandKind,
  ContainerPhase,
  ContainerStatus,
  HookKind,
  OperationKind,
} from '@nyabase/common';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { OperationOrchestratorService } from './operation-orchestrator.service.js';
import { AgentGateway } from '../gateway/agent-gateway.js';

export interface LifecycleHookTaskInput {
  hook: HookKind;
  resourceType: string;
  resourceId: string;
  serverId: string;
  desiredGeneration?: number | null;
  priority?: number;
  result?: unknown;
}

/**
 * Non-container reconcile registry. Container lifecycle/mount/SSH reconciliation is
 * owned by the V2 operation plane and must not be reintroduced here.
 */
@Injectable()
export class LifecycleHookRegistryService {
  private readonly logger = new Logger(LifecycleHookRegistryService.name);

  constructor(
    private orchestrator: OperationOrchestratorService,
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
    @InjectRepository(ContainerDesiredSpecEntity)
    private desiredRepo: Repository<ContainerDesiredSpecEntity>,
    @InjectRepository(ContainerLifecycleEntity)
    private lifecycleRepo: Repository<ContainerLifecycleEntity>,
    @InjectRepository(SshPublicKeyEntity)
    private sshKeysRepo: Repository<SshPublicKeyEntity>,
    private agentGateway: AgentGateway,
  ) {}

  enqueue(input: LifecycleHookTaskInput) {
    if (input.resourceType === 'container') {
      return Promise.resolve(null);
    }
    return this.orchestrator.enqueueReconcileTask(input);
  }

  async enqueueAgentReconnect(serverId: string): Promise<void> {
    await Promise.all([
      this.enqueue({ hook: HookKind.DataDisks, resourceType: 'server', resourceId: serverId, serverId, result: { source: 'agent_reconnect' } }),
      this.enqueue({ hook: HookKind.RemoteFs, resourceType: 'server', resourceId: serverId, serverId, result: { source: 'agent_reconnect' } }),
      this.enqueue({ hook: HookKind.Quota, resourceType: 'server', resourceId: serverId, serverId, result: { source: 'agent_reconnect' } }),
      this.enqueue({ hook: HookKind.DataDirs, resourceType: 'server', resourceId: serverId, serverId, result: { source: 'agent_reconnect' } }),
    ]);
  }

  async enqueueFullReport(serverId: string): Promise<void> {
    await this.enqueue({ hook: HookKind.DataDirs, resourceType: 'server', resourceId: serverId, serverId, result: { source: 'full_state_report' } });
  }

  async enqueueDataDirReport(serverId: string): Promise<void> {
    await this.enqueue({ hook: HookKind.DataDirs, resourceType: 'server', resourceId: serverId, serverId, result: { source: 'data_dir_report' } });
  }

  async enqueueUserSshKeyChange(userId: string): Promise<void> {
    const containers = (await this.containersRepo.find({ where: { ownerId: userId } }))
      .filter((container) => !container.deletedAt);
    if (containers.length === 0) return;

    const containerIds = containers.map((container) => container.id);
    const [desiredRows, lifecycleRows, keys] = await Promise.all([
      this.desiredRepo.find({ where: { containerId: In(containerIds), sshEnabled: true } }),
      this.lifecycleRepo.find({ where: { containerId: In(containerIds) } }),
      this.sshKeysRepo.find({ where: { userId } }),
    ]);
    const desiredByContainer = new Map(desiredRows.map((desired) => [desired.containerId, desired]));
    const lifecycleByContainer = new Map(lifecycleRows.map((lifecycle) => [lifecycle.containerId, lifecycle]));
    const publicKeys = keys.map((key) => key.keyText);

    for (const container of containers) {
      const desired = desiredByContainer.get(container.id);
      if (!desired?.sshEnabled) continue;
      const lifecycle = lifecycleByContainer.get(container.id);
      if (!lifecycle || lifecycle.phase !== ContainerPhase.Active || lifecycle.activeOperationId || !lifecycle.boundRuntimeId) continue;
      const runtime = this.agentGateway.stateCache.getContainerByContainerId(container.serverId, container.id);
      if (!runtime || runtime.status !== ContainerStatus.Running) continue;

      try {
        await this.orchestrator.createAgentCommand({
          operationKind: OperationKind.ContainerReconcileSsh,
          commandKind: AgentCommandKind.RuntimeContainerSshApply,
          serverId: container.serverId,
          resourceType: 'container',
          resourceId: container.id,
          requestedBy: userId,
          resourceKey: `container:${container.id}`,
          request: { action: 'sshKeySync', keyCount: publicKeys.length },
          payload: {
            runtimeId: lifecycle.boundRuntimeId,
            publicKeys,
          },
          beforePersist: async (manager, context) => {
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
