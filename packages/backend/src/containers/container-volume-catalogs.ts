import { IncusError, isMissingCustomVolumeError } from '../incus/index.js';
import type { ReconcileOutcome, ReconcileRunContext } from '../reconcile/managed-reconciler.js';
import { ensureSharedCatalogOnServer } from '../volumes/shared-catalog.js';
import { VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS } from '../volumes/volume-reconcile-support.js';
import type { ContainerReconcileDeps } from './container-reconcile-deps.js';
import { failure, isNotFound, type ContainerAttachment } from './container-reconcile-support.js';

/**
 * Every volume the instance mounts must already exist in this daemon's Incus
 * catalog before the instance PUT, or Incus rejects the device.
 */
export async function ensureDesiredCatalogs(
  deps: ContainerReconcileDeps,
  context: ReconcileRunContext,
  attachments: readonly ContainerAttachment[],
  serverId: string,
): Promise<ReconcileOutcome | undefined> {
  if (!context.client) {
    throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
  }
  for (const attachment of attachments) {
    if (!attachment.pool_name) {
      throw new IncusError(
        attachment.shared ? 'VOLUME_PLACEMENT_PENDING' : 'MISSING_STORAGE_POOL',
        attachment.shared ? 'retry' : 'managed_failure',
        { volumeId: attachment.volume_id, serverId },
      );
    }
    if (attachment.shared) {
      const result = await ensureSharedCatalogOnServer(context.client, {
        poolName: attachment.pool_name,
        incusName: attachment.incus_name,
        sizeBytes: attachment.size_bytes,
      });
      if (result === 'missing') {
        if (context.intent.attemptCount >= VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS) {
          return {
            outcome: 'failed',
            failure: failure(
              'VOLUME_CATALOG_ADOPT_FAILED',
              'Incus did not adopt the existing CephFS directory into this daemon catalog',
              { volumeId: attachment.volume_id, serverId },
            ),
          };
        }
        throw new IncusError('VOLUME_CATALOG_ADOPT_PENDING', 'retry', {
          volumeId: attachment.volume_id,
          serverId,
        });
      }
      await deps.store.markCatalogPresent(attachment.volume_id, serverId);
      deps.logger.log(
        `container=${context.intent.resourceId} ensure shared catalog volume=${attachment.volume_id} `
        + `server=${serverId} result=${result}`,
      );
      continue;
    }
    try {
      await context.client.getStorageVolume(attachment.pool_name, 'custom', attachment.incus_name);
      await deps.store.markCatalogPresent(attachment.volume_id, serverId);
    } catch (error) {
      if (error instanceof IncusError && error.code === 'MISSING_STORAGE_POOL') {
        throw error;
      }
      if (isNotFound(error) || isMissingCustomVolumeError(error)) {
        deps.logger.log(
          `Custom volume ${attachment.incus_name} is not present on ${serverId}`,
        );
        throw new IncusError('VOLUME_PLACEMENT_PENDING', 'retry', {
          volumeId: attachment.volume_id,
          reason: 'preflight',
        });
      }
      throw error;
    }
  }
}
