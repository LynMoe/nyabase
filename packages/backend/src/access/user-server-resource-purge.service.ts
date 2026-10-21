import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  AuditAction,
  ContainerPhase,
  ContainerPowerIntent,
  IntentKind,
  IntentResourceType,
} from '@nyabase/common';
import { AuditService } from '../iam/audit.service.js';
import { ContainerControlRepository } from '../containers/container-control.repository.js';
import { ContainerControlService } from '../containers/container-control.service.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { ReconcileClaimRepository } from '../reconcile/reconcile-claim.repository.js';
import { VOLUME_DESTROY_PLACEMENT_ID } from '../reconcile/reconcile-claim.repository.js';
import { listEligibleDestroyExecutors } from '../volumes/eligible-destroy-executors.js';
import { VolumesRepository } from '../volumes/volumes.repository.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { isSystemActor, type Actor } from '../iam/actor.js';

const OPERATOR_PURGE_AUDIT_ACTION = 'user.server.purge_resources' as AuditAction;

export interface PurgeUserServerResourcesResult {
  intentIds: string[];
  containerIds: string[];
  volumeIntentIds: string[];
  volumeIds: string[];
}

@Injectable()
export class UserServerResourcePurgeService {
  constructor(
    private readonly transactions: PgTransactionManager,
    private readonly containerRepository: ContainerControlRepository,
    private readonly containers: ContainerControlService,
    private readonly volumes: VolumesRepository,
    private readonly intents: IntentRepository,
    private readonly reconcileClaims: ReconcileClaimRepository,
    private readonly access: AccessResolverService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Deletes a user's containers and local volumes on one server. An operator
   * (`ManageGrants` + `ManageContainersAny`) purges as themselves; grant expiry
   * purges as the system.
   */
  async purge(
    actor: Actor,
    userId: string,
    serverId: string,
  ): Promise<PurgeUserServerResourcesResult> {
    const actorId = actor.userId;
    const reason = isSystemActor(actor) ? 'expiry' : 'admin';
    const owned = await this.containerRepository.list({ ownerId: userId, serverId });
    const intentIds: string[] = [];
    const containerIds: string[] = [];
    for (const container of owned) {
      if (container.lifecycle_phase === ContainerPhase.Deleting) continue;
      const accepted = await this.containers.action(actor, container.id, 'delete');
      intentIds.push(accepted.intentId);
      containerIds.push(container.id);
    }
    const volumeResult = await this.purgeVolumes(
      userId,
      (volume) => volume.server_id === serverId && volume.shared_backend_id === null,
      actor,
    );
    await this.transactions.run(async (transaction) => {
      await this.audit.append(
        transaction,
        actorId,
        reason === 'expiry'
          ? AuditAction.ExpiryPurgeResources
          : OPERATOR_PURGE_AUDIT_ACTION,
        userId,
        'user',
        {
          serverId,
          containerIds,
          intentIds,
          volumeIds: volumeResult.volumeIds,
          volumeIntentIds: volumeResult.intentIds,
          reason,
        },
      );
    });
    await this.access.authorizationCommitted([userId]);
    return {
      intentIds,
      containerIds,
      volumeIntentIds: volumeResult.intentIds,
      volumeIds: volumeResult.volumeIds,
    };
  }

  async purgeStoragePoolVolumes(
    actor: Actor,
    userId: string,
    poolId: string,
  ): Promise<{ intentIds: string[]; volumeIds: string[] }> {
    const actorId = actor.userId;
    const result = await this.purgeVolumes(
      userId,
      (volume) => volume.pool_id === poolId && volume.shared_backend_id === null,
      actor,
      true,
    );
    if (result.volumeIds.length > 0) {
      await this.transactions.run(async (transaction) => {
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.ExpiryPurgeResources,
          poolId,
          'storage_pool',
          {
            userId,
            poolId,
            ...result,
            intentIds: [...result.intentIds, ...result.containerIntentIds],
          },
        );
      });
      await this.access.authorizationCommitted([userId]);
    }
    return {
      intentIds: [...result.intentIds, ...result.containerIntentIds],
      volumeIds: result.volumeIds,
    };
  }

  async purgeSharedBackendVolumes(
    actor: Actor,
    userId: string,
    sharedBackendId: string,
  ): Promise<{ intentIds: string[]; volumeIds: string[] }> {
    const actorId = actor.userId;
    const result = await this.purgeVolumes(
      userId,
      (volume) => volume.shared_backend_id === sharedBackendId,
      actor,
      true,
    );
    if (result.volumeIds.length > 0) {
      await this.transactions.run(async (transaction) => {
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.ExpiryPurgeResources,
          sharedBackendId,
          'shared_backend',
          {
            userId,
            sharedBackendId,
            ...result,
            intentIds: [...result.intentIds, ...result.containerIntentIds],
          },
        );
      });
      await this.access.authorizationCommitted([userId]);
    }
    return {
      intentIds: [...result.intentIds, ...result.containerIntentIds],
      volumeIds: result.volumeIds,
    };
  }

  async stopRunningContainersForStoragePool(
    actor: Actor,
    userId: string,
    poolId: string,
    workerId = actor.userId,
  ): Promise<{ intentIds: string[] }> {
    return this.stopRunningContainersForResource(
      userId,
      (volume) => volume.pool_id === poolId && volume.shared_backend_id === null,
      actor,
      { resourceKind: 'storage_pool', resourceId: poolId },
      workerId,
    );
  }

  async stopRunningContainersForSharedBackend(
    actor: Actor,
    userId: string,
    sharedBackendId: string,
    workerId = actor.userId,
  ): Promise<{ intentIds: string[] }> {
    return this.stopRunningContainersForResource(
      userId,
      (volume) => volume.shared_backend_id === sharedBackendId,
      actor,
      { resourceKind: 'shared_backend', resourceId: sharedBackendId },
      workerId,
    );
  }

  async stopRunningContainersForGraceEntry(
    actor: Actor,
    userId: string,
    serverId: string,
  ): Promise<{ intentIds: string[] }> {
    const actorId = actor.userId;
    const owned = await this.containerRepository.list({ ownerId: userId, serverId });
    const intentIds: string[] = [];
    for (const container of owned) {
      if (
        container.lifecycle_phase !== ContainerPhase.Active
        || container.power_intent !== ContainerPowerIntent.Running
      ) continue;
      const accepted = await this.containers.action(actor, container.id, 'stop');
      intentIds.push(accepted.intentId);
    }
    if (intentIds.length > 0) {
      await this.transactions.run(async (transaction) => {
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.ExpiryStopContainers,
          userId,
          'user',
          { serverId, intentIds },
        );
      });
      await this.access.authorizationCommitted([userId]);
    }
    return { intentIds };
  }

  private async stopRunningContainersForResource(
    userId: string,
    matches: (volume: {
      id: string;
      owner_id: string;
      pool_id: string | null;
      server_id: string | null;
      shared_backend_id: string | null;
    }) => boolean,
    actor: Actor,
    resource: { resourceKind: string; resourceId: string },
    workerId: string,
  ): Promise<{ intentIds: string[] }> {
    const actorId = actor.userId;
    const volumes = (await this.volumes.list(userId)).filter(matches);
    const containerIds = new Set<string>();
    for (const volume of volumes) {
      for (const attachment of await this.volumes.listAttachments(undefined, volume.id)) {
        containerIds.add(attachment.container_id);
      }
    }
    const intentIds: string[] = [];
    for (const containerId of containerIds) {
      const container = await this.containerRepository.find(containerId);
      if (
        !container
        || container.lifecycle_phase !== ContainerPhase.Active
        || container.power_intent !== ContainerPowerIntent.Running
      ) continue;
      const claim = await this.reconcileClaims.claim({
        resourceType: IntentResourceType.Container,
        resourceId: containerId,
        placementServerId: container.server_id,
        serverId: container.server_id,
        workerId,
      });
      if (!claim) continue;
      try {
        const current = await this.containerRepository.find(containerId);
        if (
          !current
          || current.lifecycle_phase !== ContainerPhase.Active
          || current.power_intent !== ContainerPowerIntent.Running
        ) continue;
        // The desired power state and pending intent are the completion marker.
        const accepted = await this.containers.action(actor, containerId, 'stop');
        intentIds.push(accepted.intentId);
      } finally {
        await this.reconcileClaims.release({
          resourceType: claim.resourceType,
          resourceId: claim.resourceId,
          placementServerId: claim.placementServerId,
          workerId: claim.workerId,
        });
      }
    }
    if (intentIds.length > 0) {
      await this.transactions.run(async (transaction) => {
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.ExpiryStopContainers,
          userId,
          'user',
          { ...resource, intentIds },
        );
      });
      await this.access.authorizationCommitted([userId]);
    }
    return { intentIds };
  }

  private async purgeVolumes(
    userId: string,
    matches: (volume: {
      id: string;
      owner_id: string;
      pool_id: string | null;
      server_id: string | null;
      shared_backend_id: string | null;
    }) => boolean,
    actor: Actor,
    deleteAttachedContainers = false,
  ): Promise<{ intentIds: string[]; containerIntentIds: string[]; volumeIds: string[] }> {
    const actorId = actor.userId;
    const owned = (await this.volumes.list(userId)).filter(matches);
    const containerIds = new Set<string>();
    for (const volume of owned) {
      for (const attachment of await this.volumes.listAttachments(undefined, volume.id)) {
        containerIds.add(attachment.container_id);
      }
    }
    const containerIntentIds: string[] = [];
    if (deleteAttachedContainers) {
      for (const containerId of containerIds) {
        const container = await this.containerRepository.find(containerId);
        if (!container || container.lifecycle_phase === ContainerPhase.Deleting) continue;
        const accepted = await this.containers.action(actor, containerId, 'delete');
        containerIntentIds.push(accepted.intentId);
      }
    }
    const result = await this.transactions.run(async (transaction) => {
      const intentIds: string[] = [];
      const volumeIds: string[] = [];
      for (const volume of owned) {
        const locked = await transaction.selectFrom('control.volumes')
          .selectAll()
          .where('id', '=', volume.id)
          .forUpdate()
          .executeTakeFirst();
        if (!locked) continue;
        const sentinel = await transaction
          .selectFrom('control.reconcile_claims')
          .select('resource_id')
          .where('resource_type', '=', 'volume')
          .where('resource_id', '=', locked.id)
          .where('placement_server_id', '=', VOLUME_DESTROY_PLACEMENT_ID)
          .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
          .executeTakeFirst();
        if (sentinel) continue;
        const attachments = await this.volumes.listAttachments(undefined, locked.id, transaction);
        const placements = await this.volumes.listPlacements(locked.id, transaction);
        const eligible = locked.shared_backend_id
          ? await listEligibleDestroyExecutors(transaction, locked.shared_backend_id)
          : [];
        if (attachments.length > 0) {
          let desired = locked;
          if (locked.lifecycle_phase !== 'deleting') {
            const updated = await this.volumes.updateDesired(
              locked.id,
              locked.revision,
              {
                lifecycle_phase: 'deleting',
                failure_code: null,
                needs_attention: false,
              },
              transaction,
            );
            if (!updated) continue;
            desired = updated;
          }
          const intent = await this.intents.ensurePending({
            kind: IntentKind.VolumeDestroy,
            resourceType: IntentResourceType.Volume,
            resourceId: desired.id,
            requestedBy: actorId,
            targetRevision: desired.revision,
            request: {
              operation: 'destroy',
              idempotencyKey: 'destroy',
            },
          }, transaction);
          intentIds.push(intent.id);
          volumeIds.push(desired.id);
          continue;
        }
        if (placements.length === 0) {
          if (!locked.dir_ensured || eligible.length === 0) {
            const pending = await transaction
              .selectFrom('control.intents')
              .select('id')
              .where('resource_type', '=', 'volume')
              .where('resource_id', '=', locked.id)
              .where('status', '=', 'pending')
              .execute();
            for (const row of pending) {
              await this.intents.settleOne(row.id, { outcome: 'succeeded' }, transaction);
            }
            await this.volumes.deleteVolumeRow(locked.id, transaction);
            if (locked.dir_ensured && eligible.length === 0) {
              await this.audit.append(
                transaction,
                actorId,
                AuditAction.DeleteVolume,
                locked.id,
                'volume',
                { reason: 'destroy_executor_gone' },
              );
            }
            volumeIds.push(locked.id);
            continue;
          }
        }
        let desired = locked;
        if (locked.lifecycle_phase !== 'deleting') {
          const updated = await this.volumes.updateDesired(
            locked.id,
            locked.revision,
            {
              lifecycle_phase: 'deleting',
              failure_code: null,
              needs_attention: false,
            },
            transaction,
          );
          if (!updated) continue;
          desired = updated;
        }
        const intent = await this.intents.ensurePending({
          kind: IntentKind.VolumeDestroy,
          resourceType: IntentResourceType.Volume,
          resourceId: desired.id,
          requestedBy: actorId,
          targetRevision: desired.revision,
          request: {
            operation: 'destroy',
            idempotencyKey: 'destroy',
          },
        }, transaction);
        intentIds.push(intent.id);
        volumeIds.push(desired.id);
      }
      return { intentIds, volumeIds };
    }, { isolationLevel: 'serializable', maxAttempts: 5 });
    return {
      intentIds: result.intentIds,
      containerIntentIds,
      volumeIds: result.volumeIds,
    };
  }
}
