import { AuditAction } from '@nyabase/common';
import { IncusError, type IncusSchema } from '../incus/index.js';
import type { AuditService } from '../iam/audit.service.js';
import type { IntentFailure, IntentRecord } from '../reconcile/intent.repository.js';
import type { ReconcileOutcome } from '../reconcile/managed-reconciler.js';
import type { VolumeDriver } from './volume-usage.js';

export type StorageVolume = IncusSchema<'StorageVolume'>;
export type StorageVolumeState = IncusSchema<'StorageVolumeState'>;

export interface VolumeRecord {
  id: string;
  pool_id: string | null;
  server_id: string | null;
  shared_backend_id: string | null;
  incus_name: string;
  size_bytes: string;
  used_bytes: string | null;
  revision: number;
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  needs_attention: boolean;
  dir_ensured: boolean;
  remove_all_committed: boolean;
  remove_all_server_id: string | null;
}

export interface VolumeRow extends VolumeRecord {
  driver: VolumeDriver;
  resize_family: 'quota_online' | 'block_backed';
  block_filesystem: string | null;
  target_server_id: string;
  catalog_state: 'ensuring' | 'present';
  placement_pool_id: string;
  placement_pool_name: string;
}

export interface VolumeAttachmentRow {
  id: string;
  container_id: string;
  power_intent: 'running' | 'stopped';
}

export interface CatalogRow {
  server_id: string;
  pool_id: string;
  pool_name: string;
  catalog_state: 'ensuring' | 'present';
  server_status: 'online' | 'unreachable' | 'unknown';
}

export type CatalogGetStatus = 'present' | 'missing' | 'error';

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

export function volumeFailure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): IntentFailure {
  return { code, message, details };
}

export function destroyRetry(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ReconcileOutcome {
  return {
    outcome: 'retry',
    failure: volumeFailure(code, message, details),
  };
}

export async function auditIncusMutate(
  audit: AuditService,
  intent: IntentRecord,
  detail: {
    readonly method: string;
    readonly path: string;
    readonly instanceName?: string;
  },
): Promise<void> {
  await audit.log(
    intent.requestedBy,
    AuditAction.IncusMutate,
    intent.resourceId,
    intent.resourceType,
    {
      method: detail.method,
      path: detail.path,
      instanceName: detail.instanceName,
      serverId: intent.serverId,
      intentId: intent.id,
    },
  );
}

/** Attempts after which a volume adoption that keeps failing is given up on. */
export const VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS = 8;

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
  if (actualSize === null || desiredSize === null) return false;
  return actualSize !== desiredSize;
}

export function poolForPlacement<T extends { id: string }>(
  pools: readonly T[],
  poolId: string,
): T | undefined {
  return pools.find((pool) => pool.id === poolId);
}

export function storageVolumeName(volume: StorageVolume | string): string {
  if (typeof volume === 'string') {
    const parts = volume.split('/').filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? '';
  }
  return volume.name ?? '';
}
