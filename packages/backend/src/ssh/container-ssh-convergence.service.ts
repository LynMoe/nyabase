import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  AgentTaskKind,
  ContainerPhase,
  ContainerStatus,
} from '@nyabase/common';
import { DataSource, IsNull } from 'typeorm';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { ResourceLockedException } from '../agent-tasks/resource-lock.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';

/**
 * Reconciles the durable Backend SSH generation with a running Agent runtime.
 * There is deliberately no retry state here: every complete Agent report is
 * the retry trigger, while Agent tasks and lifecycle rows remain the only
 * durable mutation state.
 */
@Injectable()
export class ContainerSshConvergenceService {
  private readonly logger = new Logger(ContainerSshConvergenceService.name);

  constructor(
    private dataSource: DataSource,
    private tasks: AgentTasksService,
    private resourceKeys: ResourceKeyService,
  ) {}

  async reconcileServer(serverId: string): Promise<void> {
    const containerIds = await runSerializedTransaction(this.dataSource, async (manager) => {
      const routes = await manager.find(ContainerSshRouteEntity, { where: { serverId } });
      return [...new Set(routes.map((route) => route.containerId))];
    });
    await this.reconcileContainerIds(containerIds, null);
  }

  async reconcileUser(userId: string): Promise<void> {
    const containerIds = await runSerializedTransaction(this.dataSource, async (manager) => {
      const containers = await manager.find(ContainerEntity, {
        where: { ownerId: userId },
      });
      return containers.map((container) => container.id);
    });
    await this.reconcileContainerIds(containerIds, userId);
  }

  private async reconcileContainerIds(
    containerIds: readonly string[],
    requestedBy: string | null,
  ): Promise<void> {
    for (const containerId of containerIds) {
      try {
        await this.reconcileContainer(containerId, requestedBy);
      } catch (error) {
        if (error instanceof ResourceLockedException || error instanceof ConflictException) {
          // A busy lifecycle or resource lock is expected. The next complete
          // report re-evaluates current durable state and retries if needed.
          this.logger.debug(
            `SSH convergence deferred for ${containerId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        // Convergence is a repair hook, never a reason to withhold the full
        // report's fail-closed proxy snapshot. A later complete report retries
        // the same durable state; other containers must still be processed.
        this.logger.error(
          `SSH convergence failed for ${containerId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async reconcileContainer(
    containerId: string,
    requestedBy: string | null,
  ): Promise<void> {
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const [container, lifecycle, route] = await Promise.all([
        manager.findOneBy(ContainerEntity, { id: containerId }),
        manager.findOneBy(ContainerLifecycleEntity, { containerId }),
        manager.findOneBy(ContainerSshRouteEntity, { containerId }),
      ]);
      if (!container || !route) return;
      if (!lifecycle) {
        throw new Error(`Container ${container.id} is missing its durable lifecycle row`);
      }
      if (lifecycle.phase !== ContainerPhase.Active || lifecycle.activeTaskId !== null) return;
      if (!lifecycle.boundRuntimeId) {
        throw new Error(`Active container ${container.id} has no bound runtime identity`);
      }
      if (route.serverId !== container.serverId) {
        throw new Error(`Container ${container.id} SSH route belongs to the wrong server`);
      }
      if (
        route.runtimeId !== lifecycle.boundRuntimeId
        || route.runtimeStatus !== ContainerStatus.Running
      ) return;

      const image = await manager.findOneBy(ImageEntity, { id: container.imageId });
      if (!image) throw new Error(`Container ${container.id} references a missing image ${container.imageId}`);
      const enabled = !image.disableSsh;
      const key = enabled
        ? await manager.findOneBy(UserInternalSshKeyEntity, { userId: container.ownerId })
        : null;
      if (enabled && !key) {
        throw new Error(
          `Container ${container.id} owner ${container.ownerId} is missing its durable internal SSH key`,
        );
      }

      const converged = enabled
        ? route.sshStatus === 'running'
          && route.appliedInternalKeyGeneration === key!.generation
          && this.hasHostFingerprint(route.containerHostKeyFingerprint)
        : route.sshStatus === 'disabled';
      if (converged) return;

      const task = await this.tasks.enqueueInTransaction(manager, {
        kind: AgentTaskKind.ContainerSshEnsure,
        serverId: container.serverId,
        resourceType: 'container',
        resourceId: container.id,
        requestedBy,
        request: {
          action: 'internalSshKeyConverge',
          enabled,
          desiredGeneration: key?.generation ?? null,
          observedGeneration: route.appliedInternalKeyGeneration,
        },
        payload: {
          containerId: container.id,
          runtimeId: lifecycle.boundRuntimeId,
          enabled,
          ...(enabled ? {
            internalPublicKey: key!.publicKey,
            internalKeyGeneration: key!.generation,
          } : {}),
        },
        resourceKeys: [this.resourceKeys.container(container.id)],
        beforeCommit: async (taskManager, context) => {
          const current = await taskManager.findOneBy(ContainerLifecycleEntity, {
            containerId: container.id,
          });
          if (
            !current
            || current.phase !== ContainerPhase.Active
            || current.activeTaskId !== null
            || current.boundRuntimeId !== route.runtimeId
          ) {
            throw new ConflictException('Container lifecycle changed during SSH convergence');
          }
          const updated = await taskManager.update(ContainerLifecycleEntity, {
            containerId: container.id,
            phase: ContainerPhase.Active,
            activeTaskId: IsNull(),
            boundRuntimeId: route.runtimeId,
          }, {
            phase: ContainerPhase.Updating,
            activeTaskId: context.taskId,
            lastTransitionAt: new Date(),
            failureReason: null,
            failureCode: null,
          });
          if (updated.affected !== 1) {
            throw new ConflictException('Container lifecycle changed during SSH convergence');
          }
        },
      });
      this.logger.debug(
        `Queued SSH convergence task ${task.taskId} for container ${container.id}`,
      );
    });
  }

  private hasHostFingerprint(value: string | null): boolean {
    return typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value);
  }
}
