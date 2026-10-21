import {
  isAlreadyExistsError,
  readAfterTimeout,
  requestAndWait,
  type IncusClientPort,
} from '../incus/index.js';
import type { IntentFailure } from '../reconcile/intent.repository.js';
import type { ReconcileOutcome, ReconcileRunContext } from '../reconcile/managed-reconciler.js';
import type { VolumeReconcileDeps } from './volume-reconcile-deps.js';
import {
  asBytes,
  auditIncusMutate,
  isNotFound,
  volumeFailure,
  type StorageVolume,
  type StorageVolumeState,
  type VolumeAttachmentRow,
  type VolumeRow,
} from './volume-reconcile-support.js';
import {
  decideVolumeResize,
  normalizeObservedVolumeUsage,
  type VolumeResizeDecision,
} from './volume-usage.js';

/** Create the custom volume (or let Incus adopt the CephFS directory) and return what Incus now has. */
export async function adoptOrCreate(
  deps: VolumeReconcileDeps,
  context: ReconcileRunContext,
  row: VolumeRow,
): Promise<StorageVolume | undefined> {
  const client = context.client!;
  await auditIncusMutate(deps.audit, context.intent, {
    method: 'POST',
    path: `/1.0/storage-pools/${row.placement_pool_name}/volumes`,
    instanceName: row.incus_name,
  });
  try {
    await readAfterTimeout(
      () => requestAndWait(
        client,
        (options) => client.createStorageVolume(
          row.placement_pool_name,
          {
            name: row.incus_name,
            type: 'custom',
            content_type: 'filesystem',
            config: {
              size: row.size_bytes,
              'security.shifted': 'true',
            },
          },
          options,
        ),
      ),
      async () => {
        await client.getStorageVolume(row.placement_pool_name, 'custom', row.incus_name);
        return undefined;
      },
    );
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  try {
    return (await client.getStorageVolume(
      row.placement_pool_name,
      'custom',
      row.incus_name,
    )).metadata;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return undefined;
  }
}

function blockedResizeFailure(
  decision: Extract<VolumeResizeDecision, { action: 'blocked' }>,
  row: VolumeRow,
  desiredSize: bigint,
  usedBytes: bigint | null,
  attachments: VolumeAttachmentRow[],
): IntentFailure {
  const details = {
    volumeId: row.id,
    requestedBytes: desiredSize.toString(),
    usedBytes: usedBytes?.toString() ?? null,
    attachments: attachments.map((attachment) => ({
      attachmentId: attachment.id,
      containerId: attachment.container_id,
    })),
  };
  switch (decision.reason) {
    case 'usage_unknown':
      return volumeFailure('VOLUME_USAGE_UNKNOWN', 'Volume usage is unknown; shrink is not allowed until usage is observed', details);
    case 'usage_floor':
      return volumeFailure('VOLUME_SHRINK_BELOW_USAGE', 'The requested size is below volume usage', details);
    case 'detach':
      return volumeFailure('VOLUME_SHRINK_REQUIRES_DETACH', 'The block-backed volume must be detached before shrinking', details);
    default:
      return volumeFailure('VOLUME_SHRINK_REQUIRES_STOP', 'The block-backed volume consumers must be stopped before shrinking', details);
  }
}

/** PUT the desired size and `security.shifted`, then wait until Incus reports them. */
async function updateIncusVolume(
  deps: VolumeReconcileDeps,
  context: ReconcileRunContext,
  row: VolumeRow,
  actual: StorageVolume,
  config: Record<string, string>,
  desiredSize: bigint,
): Promise<void> {
  const client = context.client!;
  await auditIncusMutate(deps.audit, context.intent, {
    method: 'PUT',
    path: `/1.0/storage-pools/${row.placement_pool_name}/volumes/custom/${row.incus_name}`,
    instanceName: row.incus_name,
  });
  await readAfterTimeout(
    () => requestAndWait(
      client,
      (options) => client.updateStorageVolume(
        row.placement_pool_name,
        'custom',
        row.incus_name,
        {
          config: {
            ...config,
            size: desiredSize.toString(),
          },
          description: actual.description,
        },
        options,
      ),
    ),
    async () => {
      const after = await client.getStorageVolume(row.placement_pool_name, 'custom', row.incus_name);
      const afterSize = asBytes(after.metadata.config?.size);
      if (
        afterSize === null
        || afterSize !== desiredSize
        || after.metadata.config?.['security.shifted'] !== 'true'
      ) {
        throw new Error('VOLUME_UPDATE_NOT_CONFIRMED');
      }
      return undefined;
    },
  );
}

/** The volume as Incus reports it must now match the managed specification. */
async function verifyVolume(
  client: IncusClientPort,
  row: VolumeRow,
  desiredSize: bigint,
): Promise<ReconcileOutcome | null> {
  const verified = (await client.getStorageVolume(
    row.placement_pool_name,
    'custom',
    row.incus_name,
  )).metadata;
  const verifiedSize = asBytes(verified.config?.size);
  if (
    verifiedSize === null
    || verifiedSize !== desiredSize
    || verified.config?.['security.shifted'] !== 'true'
    || verified.content_type !== 'filesystem'
  ) {
    return {
      outcome: 'failed',
      failure: volumeFailure(
        'VOLUME_VERIFY_FAILED',
        'The volume did not match the managed specification after reconciliation',
        {
          size: verified.config?.size ?? '',
          shifted: verified.config?.['security.shifted'] ?? '',
          contentType: verified.content_type ?? '',
        },
      ),
    };
  }
  return null;
}

/** Bring size and `security.shifted` in line with the desired state, then record the placement as present. */
export async function alignSizeAndShifted(
  deps: VolumeReconcileDeps,
  context: ReconcileRunContext,
  row: VolumeRow,
  actual: StorageVolume,
  attachments: VolumeAttachmentRow[],
): Promise<ReconcileOutcome> {
  const client = context.client!;
  const config = { ...(actual.config ?? {}) };
  const attached = attachments.length > 0;
  if (config['security.shifted'] !== 'true') {
    if (attached) {
      return {
        outcome: 'failed',
        failure: volumeFailure(
          'VOLUME_SECURITY_SHIFTED_MISMATCH',
          'An in-use volume is missing security.shifted and cannot be rewritten',
          { volumeId: row.id },
        ),
      };
    }
    config['security.shifted'] = 'true';
  }
  const currentSize = asBytes(config.size);
  const desiredSize = BigInt(row.size_bytes);
  if (currentSize === null) {
    return {
      outcome: 'failed',
      failure: volumeFailure(
        'VOLUME_SIZE_UNREADABLE',
        'Incus did not return a readable volume size',
      ),
    };
  }
  const state: StorageVolumeState = (await client.getStorageVolumeState(
    row.placement_pool_name,
    'custom',
    row.incus_name,
  )).metadata;
  const usedBytes = normalizeObservedVolumeUsage({
    resizeFamily: row.resize_family,
    driver: row.driver,
    usedBytes: asBytes(state.usage?.used) ?? null,
    totalBytes: asBytes(state.usage?.total) ?? null,
    currentSizeBytes: currentSize,
  });
  const decision = decideVolumeResize({
    resizeFamily: row.resize_family,
    currentSizeBytes: currentSize,
    desiredSizeBytes: desiredSize,
    usedBytes,
    attached,
    allConsumersStopped: attachments.every((item) => item.power_intent !== 'running'),
  });
  if (decision.action === 'blocked') {
    const failure = blockedResizeFailure(decision, row, desiredSize, usedBytes, attachments);
    if (decision.reason === 'usage_floor' || decision.reason === 'usage_unknown') {
      await deps.store.revertImpossibleShrink(row.id, currentSize, usedBytes, failure.code);
    }
    return { outcome: 'failed', failure };
  }
  if (decision.action !== 'none' || config['security.shifted'] !== actual.config?.['security.shifted']) {
    await updateIncusVolume(deps, context, row, actual, config, desiredSize);
  }
  const mismatch = await verifyVolume(client, row, desiredSize);
  if (mismatch) return mismatch;
  await deps.store.recordVerified(row, usedBytes);
  return { outcome: 'succeeded', observedRevision: row.revision };
}
