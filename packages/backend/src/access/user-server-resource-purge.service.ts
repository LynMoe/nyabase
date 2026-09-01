import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  AuditAction,
  ContainerPhase,
  ContainerPowerIntent,
  IntentKind,
  IntentResourceType,
} from '@nyabase/common';
import { AuditService } from '../audit/audit.service.js';
import { ContainerControlRepository } from '../containers/container-control.repository.js';
import { ContainerControlService } from '../containers/container-control.service.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { IntentRepository } from '../runtime/intent.repository.js';
import { ReconcileClaimRepository } from '../runtime/reconcile-claim.repository.js';
import { VOLUME_DESTROY_PLACEMENT_ID } from '../runtime/reconcile-claim.repository.js';
import { listEligibleDestroyExecutors } from '../volumes/eligible-destroy-executors.js';
import { VolumesRepository } from '../volumes/volumes.repository.js';
import { AccessResolverService } from './access-resolver.service.js';

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

  async purge(
    userId: string,
    serverId: string,
    actorId: string,
    reason: 'admin' | 'expiry' = 'admin',
  ): Promise<PurgeUserServerResourcesResult> {
    const owned = await this.containerRepository.list({ ownerId: userId, serverId });
    const intentIds: string[] = [];
    const containerIds: string[] = [];
    for (const container of owned) {
      if (container.lifecycle_phase === ContainerPhase.Deleting) continue;
      const accepted = reason === 'expiry'
        ? await this.containers.actionForSystem(container.id, 'delete', actorId)
        : await this.containers.actionForAdmin(container.id, 'delete', actorId);
      intentIds.push(accepted.intentId);
      containerIds.push(container.id);
    }
    const volumeResult = await this.purgeVolumes(
      userId,
      (volume) => volume.server_id === serverId && volume.shared_backend_id === null,
      actorId,
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
    userId: string,
    poolId: string,
    actorId: string,
  ): Promise<{ intentIds: string[]; volumeIds: string[] }> {
    const result = await this.purgeVolumes(
      userId,
      (volume) => volume.pool_id === poolId && volume.shared_backend_id === null,
      actorId,
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
    userId: string,
    sharedBackendId: string,
    actorId: string,
  ): Promise<{ intentIds: string[]; volumeIds: string[] }> {
    const result = await this.purgeVolumes(
      userId,
      (volume) => volume.shared_backend_id === sharedBackendId,
      actorId,
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
    userId: string,
    poolId: string,
    actorId: string,
    workerId = actorId,
  ): Promise<{ intentIds: string[] }> {
    return this.stopRunningContainersForResource(
      userId,
      (volume) => volume.pool_id === poolId && volume.shared_backend_id === null,
      actorId,
      { resourceKind: 'storage_pool', resourceId: poolId },
      workerId,
    );
  }

  async stopRunningContainersForSharedBackend(
    userId: string,
    sharedBackendId: string,
    actorId: string,
    workerId = actorId,
  ): Promise<{ intentIds: string[] }> {
    return this.stopRunningContainersForResource(
      userId,
      (volume) => volume.shared_backend_id === sharedBackendId,
      actorId,
      { resourceKind: 'shared_backend', resourceId: sharedBackendId },
      workerId,
    );
  }

  async stopRunningContainersForGraceEntry(
    userId: string,
    serverId: string,
    actorId: string,
  ): Promise<{ intentIds: string[] }> {
    const owned = await this.containerRepository.list({ ownerId: userId, serverId });
    const intentIds: string[] = [];
    for (const container of owned) {
      if (
        container.lifecycle_phase !== ContainerPhase.Active
        || container.power_intent !== ContainerPowerIntent.Running
      ) continue;
      const accepted = await this.containers.actionForSystem(container.id, 'stop', actorId);
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
    actorId: string,
    resource: { resourceKind: string; resourceId: string },
    workerId: string,
  ): Promise<{ intentIds: string[] }> {
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
        const accepted = await this.containers.actionForSystem(containerId, 'stop', actorId);
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
    actorId: string,
    deleteAttachedContainers = false,
  ): Promise<{ intentIds: string[]; containerIntentIds: string[]; volumeIds: string[] }> {
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
        const accepted = await this.containers.actionForSystem(containerId, 'delete', actorId);
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
              locked.generation,
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
            targetGeneration: desired.generation,
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
            locked.generation,
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
          targetGeneration: desired.generation,
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
