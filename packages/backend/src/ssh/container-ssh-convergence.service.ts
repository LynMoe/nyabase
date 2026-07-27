import {
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  AgentTaskKind,
  ContainerPhase,
  ContainerStatus,
} from '@nyabase/common';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { ResourceLockedException } from '../agent-tasks/resource-lock.error.js';
import { ContainerControlRepository } from '../containers/container-control.repository.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';

/**
 * Report-triggered SSH convergence over the canonical PostgreSQL projection.
 */
@Injectable()
export class ContainerSshConvergenceService {
  private readonly logger = new Logger(ContainerSshConvergenceService.name);

  constructor(
    private readonly transactions: PgTransactionManager,
    private readonly containers: ContainerControlRepository,
    private readonly workflow: WorkflowEnqueuePort,
    private readonly resourceKeys: ResourceKeyService,
  ) {}

  async reconcileServer(serverId: string): Promise<void> {
    const containerIds = [...new Set(
      (await this.containers.listRoutes({ serverId }))
        .map((route) => route.containerId),
    )];
    await this.reconcileContainerIds(containerIds, null);
  }

  async reconcileUser(userId: string): Promise<void> {
    const containerIds = (await this.containers.list({ ownerId: userId }))
      .map((container) => container.id);
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
        if (
          error instanceof ResourceLockedException
          || error instanceof ConflictException
        ) {
          this.logger.debug(
            `SSH convergence deferred for ${containerId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        this.logger.error(
          `SSH convergence failed for ${containerId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async reconcileContainer(
    containerId: string,
    requestedBy: string | null,
  ): Promise<void> {
    const queued = await this.transactions.run(async (transaction) => {
      const container = await this.containers.lock(containerId, transaction);
      if (!container) return null;
      const route = (await this.containers.routes(
        [container.id],
        transaction,
      )).get(container.id);
      if (!route) return null;
      if (
        container.lifecyclePhase !== ContainerPhase.Active
        || container.activeTaskId !== null
      ) return null;
      if (!container.boundRuntimeId) {
        throw new Error(
          `Active container ${container.id} has no bound runtime identity`,
        );
      }
      if (route.serverId !== container.serverId) {
        throw new Error(
          `Container ${container.id} SSH route belongs to the wrong server`,
        );
      }
      if (
        route.runtimeId !== container.boundRuntimeId
        || route.runtimeStatus !== ContainerStatus.Running
      ) return null;

      const image = await transaction.selectFrom('infra.images')
        .select(['id', 'disable_ssh'])
        .where('id', '=', container.imageId)
        .executeTakeFirst();
      if (!image) {
        throw new Error(
          `Container ${container.id} references missing image ${container.imageId}`,
        );
      }
      const enabled = !image.disable_ssh;
      const key = enabled
        ? await transaction.selectFrom('iam.user_internal_ssh_keys')
          .select(['public_key', 'generation'])
          .where('user_id', '=', container.ownerId)
          .executeTakeFirst()
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
      if (converged) return null;

      const result = await this.workflow.enqueueInTransaction(transaction, {
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
          runtimeId: container.boundRuntimeId,
          enabled,
          ...(enabled ? {
            internalPublicKey: key!.public_key,
            internalKeyGeneration: key!.generation,
          } : {}),
        },
        resourceKeys: [this.resourceKeys.container(container.id)],
        beforeCommit: async (taskTransaction, context) => {
          const updated = await this.containers.transition(
            container.id,
            container.revision,
            {
              lifecyclePhase: ContainerPhase.Updating,
              activeTaskId: context.taskId,
              failureReason: null,
              failureCode: null,
            },
            taskTransaction,
          );
          if (
            !updated
            || updated.boundRuntimeId !== route.runtimeId
          ) {
            throw new ConflictException(
              'Container lifecycle changed during SSH convergence',
            );
          }
        },
      });
      return result.taskId;
    });
    if (queued) {
      this.logger.debug(
        `Queued SSH convergence task ${queued} for container ${containerId}`,
      );
    }
  }

  private hasHostFingerprint(value: string | null): boolean {
    return typeof value === 'string'
      && /^SHA256:[A-Za-z0-9+/]{43}$/u.test(value);
  }
}
