import {
  IncusError,
  isAlreadyExistsError,
  readAfterTimeout,
  requestAndWait,
  type IncusClientPort,
  type IncusSchema,
} from '../incus/index.js';
import type { IntentFailure } from '../reconcile/intent.repository.js';
import { intentFailure } from '../reconcile/intent-model.js';
import { failedOutcome, type ReconcileOutcome } from '../reconcile/managed-reconciler.js';
import {
  normalizeObservedVolumeUsage,
  type VolumeDriver,
  type VolumeResizeDecision,
} from './volume-rules.js';

/*
 * Plain functions over one Incus custom volume: size parsing, the physical
 * create/update/verify/delete operations and the failure shapes the volume
 * reconciler reports. They take `client` and explicit values; auditing,
 * logging and SQL stay in the reconciler.
 */

export type StorageVolume = IncusSchema<'StorageVolume'>;
export type StorageVolumeState = IncusSchema<'StorageVolumeState'>;
export type CatalogGetStatus = 'present' | 'missing' | 'error';

/** Labels every custom volume the platform creates: it is ours, and whose. */
export const VOLUME_MANAGED_KEY = 'user.nyabase.managed';
/** The server (local volume) or shared backend (shared volume) that owns it. */
export const VOLUME_SCOPE_KEY = 'user.nyabase.scope';

/** The owner scope a volume is labelled with: its shared backend, else its server. */
export function volumeOwnerScope(row: {
  readonly server_id: string | null;
  readonly shared_backend_id: string | null;
}): string | null {
  return row.shared_backend_id ?? row.server_id;
}

export function volumeLabels(ownerScope: string | null | undefined): Record<string, string> {
  return ownerScope ? { [VOLUME_MANAGED_KEY]: 'true', [VOLUME_SCOPE_KEY]: ownerScope } : {};
}

/**
 * Only a volume labelled with one of `scopes` was created by this platform for
 * this pool. Another installation that shares the Incus host, or a volume
 * created by hand, never qualifies, whatever its name.
 */
export function labelledFor(volume: StorageVolume | string, scopes: ReadonlySet<string>): boolean {
  if (typeof volume === 'string') return false;
  const config = volume.config ?? {};
  const scope = config[VOLUME_SCOPE_KEY];
  return config[VOLUME_MANAGED_KEY] === 'true' && typeof scope === 'string' && scopes.has(scope.toLowerCase());
}

export function isNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

export function asBytes(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value !== 'string') return null;
  const match = /^([0-9]+)(?:\s*)(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i.exec(value.trim());
  if (!match) return null;
  const unit = (match[2] ?? 'b').toLowerCase();
  const multipliers: Record<string, bigint> = {
    b: 1n,
    kb: 1000n,
    kib: 1024n,
    mb: 1000n ** 2n,
    mib: 1024n ** 2n,
    gb: 1000n ** 3n,
    gib: 1024n ** 3n,
    tb: 1000n ** 4n,
    tib: 1024n ** 4n,
  };
  return BigInt(match[1]) * multipliers[unit];
}

export function destroyRetry(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ReconcileOutcome {
  return {
    outcome: 'retry',
    failure: intentFailure(code, message, details),
  };
}

export function destroyRetryFromError(error: unknown, serverId: string): ReconcileOutcome {
  if (error instanceof IncusError) {
    return destroyRetry(error.code, error.message, { serverId });
  }
  return destroyRetry(
    'SERVER_UNREACHABLE',
    'Destroy cannot reach a catalog Incus',
    { serverId },
  );
}

export function scanNeedsEnsure(
  row: {
    readonly lifecycle_phase: string;
    readonly size_bytes: string | number | bigint;
  },
  listed: StorageVolume | string | undefined,
): boolean {
  if (listed === undefined) return true;
  if (typeof listed === 'string') return false;
  const actualSize = asBytes(listed.config?.size);
  const desiredSize = asBytes(row.size_bytes);
  if (listed.config?.['security.shifted'] !== 'true') return true;
  if (listed.config?.['security.unmapped'] !== undefined) return true;
  if (actualSize === null || desiredSize === null) return false;
  return actualSize !== desiredSize;
}

export function storageVolumeName(volume: StorageVolume | string): string {
  if (typeof volume === 'string') {
    const parts = volume.split('/').filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? '';
  }
  return volume.name ?? '';
}

// --- ensure / resize ------------------------------------------------------------

/** Create the custom volume (or let Incus adopt the CephFS directory) and return what Incus now has. */
export async function createCustomVolume(
  client: IncusClientPort,
  poolName: string,
  incusName: string,
  sizeBytes: string,
  ownerScope: string | null,
): Promise<StorageVolume | undefined> {
  try {
    await readAfterTimeout(
      () => requestAndWait(
        client,
        (options) => client.createStorageVolume(
          poolName,
          {
            name: incusName,
            type: 'custom',
            content_type: 'filesystem',
            config: {
              size: sizeBytes,
              'security.shifted': 'true',
              ...volumeLabels(ownerScope),
            },
          },
          options,
        ),
      ),
      async () => {
        await client.getStorageVolume(poolName, 'custom', incusName);
        return undefined;
      },
    );
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  try {
    return (await client.getStorageVolume(poolName, 'custom', incusName)).metadata;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return undefined;
  }
}

/** The observed usage of a custom volume, normalised for its driver and resize family. */
export async function readVolumeUsage(
  client: IncusClientPort,
  pool: { readonly incus_name: string; readonly driver: string; readonly resize_family: string },
  incusName: string,
  currentSizeBytes: bigint,
): Promise<bigint | null> {
  const state = (await client.getStorageVolumeState(pool.incus_name, 'custom', incusName)).metadata;
  return normalizeObservedVolumeUsage({
    resizeFamily: pool.resize_family === 'block_backed' ? 'block_backed' : 'quota_online',
    driver: pool.driver as VolumeDriver,
    usedBytes: asBytes(state.usage?.used) ?? null,
    totalBytes: asBytes(state.usage?.total) ?? null,
    currentSizeBytes,
  });
}

export function blockedResizeFailure(
  decision: Extract<VolumeResizeDecision, { action: 'blocked' }>,
  volumeId: string,
  desiredSize: bigint,
  usedBytes: bigint | null,
  attachments: ReadonlyArray<{ readonly id: string; readonly container_id: string }>,
): IntentFailure {
  const details = {
    volumeId,
    requestedBytes: desiredSize.toString(),
    usedBytes: usedBytes?.toString() ?? null,
    attachments: attachments.map((attachment) => ({
      attachmentId: attachment.id,
      containerId: attachment.container_id,
    })),
  };
  switch (decision.reason) {
    case 'usage_unknown':
      return intentFailure('VOLUME_USAGE_UNKNOWN', 'Volume usage is unknown; shrink is not allowed until usage is observed', details);
    case 'usage_floor':
      return intentFailure('VOLUME_SHRINK_BELOW_USAGE', 'The requested size is below volume usage', details);
    case 'detach':
      return intentFailure('VOLUME_SHRINK_REQUIRES_DETACH', 'The block-backed volume must be detached before shrinking', details);
    default:
      return intentFailure('VOLUME_SHRINK_REQUIRES_STOP', 'The block-backed volume consumers must be stopped before shrinking', details);
  }
}

/** PUT the desired size and `security.shifted`, then wait until Incus reports them. */
export async function updateCustomVolume(
  client: IncusClientPort,
  poolName: string,
  incusName: string,
  actual: StorageVolume,
  config: Record<string, string>,
  desiredSize: bigint,
): Promise<void> {
  await readAfterTimeout(
    () => requestAndWait(
      client,
      (options) => client.updateStorageVolume(
        poolName,
        'custom',
        incusName,
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
      const after = await client.getStorageVolume(poolName, 'custom', incusName);
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
export async function verifyCustomVolume(
  client: IncusClientPort,
  poolName: string,
  incusName: string,
  desiredSize: bigint,
): Promise<ReconcileOutcome | null> {
  const verified = (await client.getStorageVolume(poolName, 'custom', incusName)).metadata;
  const verifiedSize = asBytes(verified.config?.size);
  if (
    verifiedSize === null
    || verifiedSize !== desiredSize
    || verified.config?.['security.shifted'] !== 'true'
    || verified.content_type !== 'filesystem'
  ) {
    return failedOutcome(
        'VOLUME_VERIFY_FAILED',
        'The volume did not match the managed specification after reconciliation',
        {
          size: verified.config?.size ?? '',
          shifted: verified.config?.['security.shifted'] ?? '',
          contentType: verified.content_type ?? '',
        },
      );
  }
  return null;
}

// --- destroy ------------------------------------------------------------------------

export async function classifyCatalogGet(
  client: IncusClientPort,
  poolName: string,
  incusName: string,
  signal?: AbortSignal,
): Promise<CatalogGetStatus> {
  try {
    await client.getStorageVolume(poolName, 'custom', incusName, signal ? { signal } : undefined);
    return 'present';
  } catch (error) {
    if (isNotFound(error)) return 'missing';
    return 'error';
  }
}

async function verifyAbsent(
  client: IncusClientPort,
  poolName: string,
  incusName: string,
): Promise<void> {
  try {
    await client.getStorageVolume(poolName, 'custom', incusName);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
    reason: 'volume_still_present',
  });
}

/**
 * Delete a custom volume from one daemon's catalog, confirmed by a GET 404.
 * Idempotent: a DELETE answered with 404 (the volume went between our GET and
 * the DELETE, or an earlier pass already removed it) is not a failure, the
 * closing GET decides.
 */
export async function deleteCatalog(
  client: IncusClientPort,
  poolName: string,
  incusName: string,
): Promise<void> {
  try {
    await readAfterTimeout(
      () => requestAndWait(
        client,
        (options) => client.deleteStorageVolume(poolName, 'custom', incusName, options),
      ),
      async () => {
        try {
          await client.getStorageVolume(poolName, 'custom', incusName);
        } catch (error) {
          if (isNotFound(error)) return undefined;
          throw error;
        }
        throw new Error('VOLUME_DELETE_NOT_CONFIRMED');
      },
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await verifyAbsent(client, poolName, incusName);
}

// --- scan -----------------------------------------------------------------------------

export async function deleteOrphanVolume(
  client: IncusClientPort,
  poolName: string,
  volumeName: string,
  signal?: AbortSignal,
): Promise<void> {
  await readAfterTimeout(
    () => requestAndWait(
      client,
      (options) => client.deleteStorageVolume(poolName, 'custom', volumeName, {
        ...options,
        signal,
      }),
    ),
    async () => {
      try {
        await client.getStorageVolume(poolName, 'custom', volumeName, { signal });
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
      throw new Error('VOLUME_ORPHAN_DELETE_NOT_CONFIRMED');
    },
  );
}
