import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  AuditAction,
  ContainerPhase,
  ContainerPowerIntent,
} from '@nyabase/common';
import { AuditService } from '../audit/audit.service.js';
import { ContainerControlRepository } from '../containers/container-control.repository.js';
import { ContainerControlService } from '../containers/container-control.service.js';
import { DataDirsService } from '../datadirs/datadirs.service.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AccessResolverService } from './access-resolver.service.js';

export interface PurgeUserServerResourcesResult {
  taskIds: string[];
  containerIds: string[];
  dataDirectoryIds: string[];
}

/**
 * Enqueues deletion of a user's containers and local data directories on one
 * server. Remote/shared data directories are intentionally retained and do not
 * block server-grant revocation.
 */
@Injectable()
export class UserServerResourcePurgeService {
  private readonly logger = new Logger(UserServerResourcePurgeService.name);

  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly containerRepository: ContainerControlRepository,
    private readonly containers: ContainerControlService,
    private readonly dataDirs: DataDirsService,
    private readonly access: AccessResolverService,
    private readonly audit: AuditService,
  ) {}

  async purge(
    userId: string,
    serverId: string,
    actorId: string,
    reason: 'admin' | 'expiry' = 'admin',
  ): Promise<PurgeUserServerResourcesResult> {
    const owned = await this.containerRepository.list({ ownerId: userId, serverId });
    const deletable = owned.filter((container) =>
      container.lifecyclePhase !== ContainerPhase.Deleting);
    const localDirs = await this.database.selectFrom('control.data_directories')
      .selectAll()
      .where('user_id', '=', userId)
      .where('server_id', '=', serverId)
      .where('source_kind', '=', 'local')
      .execute();
    const removableDirs = localDirs.filter((dir) =>
      dir.desired_state === 'active' || dir.desired_state === 'failed');

    const taskIds: string[] = [];
    const containerIds: string[] = [];
    const dataDirectoryIds: string[] = [];

    for (const container of deletable) {
      try {
        const task = await this.containers.actionForAdmin(
          container.id,
          'delete',
          actorId,
        );
        taskIds.push(task.taskId);
        containerIds.push(container.id);
      } catch (error) {
        this.logger.warn(
          `Failed to enqueue delete for container ${container.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Container deletes hold shared mount/quota locks briefly. Retry local
    // directory deletes with directory-only locks so purge can finish both.
    for (const dir of removableDirs) {
      let enqueued = false;
      for (let attempt = 0; attempt < 8 && !enqueued; attempt += 1) {
        try {
          const result = await this.dataDirs.deleteDir(
            actorId,
            userId,
            serverId,
            'local',
            dir.source_id,
            dir.name,
            'admin',
            {
              skipContainerReferenceCheck: true,
              directoryOnlyResourceLocks: true,
            },
          );
          if (result.taskId) {
            taskIds.push(result.taskId);
            dataDirectoryIds.push(dir.id);
            enqueued = true;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const locked = /resource is locked/i.test(message);
          if (!locked || attempt === 7) {
            this.logger.warn(
              `Failed to enqueue delete for local data directory ${dir.id}: ${message}`,
            );
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
    }

    await this.transactions.run(async (transaction) => {
      await this.audit.append(
        transaction,
        actorId,
        reason === 'expiry'
          ? AuditAction.ExpiryPurgeResources
          : AuditAction.PurgeUserServerResources,
        userId,
        'user',
        {
          serverId,
          containerIds,
          dataDirectoryIds,
          taskIds,
          reason,
        },
      );
    });
    await this.access.authorizationCommitted([userId]);
    return { taskIds, containerIds, dataDirectoryIds };
  }

  /**
   * Grace-entry side effect: enqueue stops for running containers.
   * GrantExpired is written by the worker when it completes the lease claim
   * so multi-replica retries do not duplicate the one-shot audit.
   * ExpiryStopContainers is written only when stop tasks were enqueued.
   */
  async stopRunningContainersForGraceEntry(
    userId: string,
    serverId: string,
    actorId: string,
  ): Promise<{ taskIds: string[] }> {
    const owned = await this.containerRepository.list({ ownerId: userId, serverId });
    const running = owned.filter((container) =>
      container.lifecyclePhase === ContainerPhase.Active
      && container.powerIntent === ContainerPowerIntent.Running
      && container.activeTaskId === null);
    const taskIds: string[] = [];
    for (const container of running) {
      try {
        const task = await this.containers.actionForAdmin(
          container.id,
          'stop',
          actorId,
        );
        taskIds.push(task.taskId);
      } catch (error) {
        this.logger.warn(
          `Failed to enqueue stop for container ${container.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (taskIds.length > 0) {
      await this.transactions.run(async (transaction) => {
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.ExpiryStopContainers,
          userId,
          'user',
          { serverId, taskIds },
        );
      });
    }
    return { taskIds };
  }
}
