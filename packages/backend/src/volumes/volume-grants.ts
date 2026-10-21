import { ForbiddenException } from '@nestjs/common';
import {
  resolvePoolAccess,
  resolveServerAccess,
  resolveSharedBackendAccess,
} from '../iam/effective-access.js';
import type { VolumeExecutor } from './volumes.repository.js';

/** The owner's current server coverage; throws 403 when absent or expired. */
export async function requireServerAccess(
  executor: VolumeExecutor,
  ownerId: string,
  serverId: string,
) {
  const access = await resolveServerAccess(executor, ownerId, serverId);
  if (!access) throw new ForbiddenException('Server storage access is not granted');
  return access;
}

export async function assertPoolGrant(
  executor: VolumeExecutor,
  ownerId: string,
  poolId: string,
): Promise<void> {
  if (!await resolvePoolAccess(executor, ownerId, poolId)) {
    throw new ForbiddenException('Storage pool access is not granted');
  }
}

/** Capacity limit of the owner's current backend coverage: null = unlimited, undefined = none. */
export async function effectiveSharedGrant(
  executor: VolumeExecutor,
  ownerId: string,
  backendId: string,
): Promise<number | null | undefined> {
  const access = await resolveSharedBackendAccess(executor, ownerId, backendId);
  return access ? access.limitBytes : undefined;
}

export async function assertSharedGrant(
  executor: VolumeExecutor,
  ownerId: string,
  backendId: string,
): Promise<void> {
  const row = await effectiveSharedGrant(executor, ownerId, backendId);
  if (row === undefined) throw new ForbiddenException('Shared backend access is not granted');
}
