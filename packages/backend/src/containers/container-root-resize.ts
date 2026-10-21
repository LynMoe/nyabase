import { ConflictException } from '@nestjs/common';
import { ContainerPowerIntent, FailureCode } from '@nyabase/common';
import type { Transaction } from 'kysely';
import type { ServerAccess } from '../iam/effective-access.js';
import { nullableNumber, numberValue } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { assertRootCapacity } from './container-capacity.js';
import type { ContainerControlRepository, ContainerRow } from './container-control.repository.js';
import { checkRootResize, containerStatus } from './container-rules.js';

/**
 * Validate a root-disk resize against the image minimum, the storage grant,
 * pool capacity (growth) or the shrink safety rules (shrink), under the
 * container row lock the caller already holds.
 */
export async function validateRootResize(
  repository: ContainerControlRepository,
  transaction: Transaction<NyabaseDatabase>,
  locked: ContainerRow,
  size: number,
  grant: ServerAccess | null,
): Promise<void> {
  if (locked.root_size_pending_bytes !== null) {
    throw new ConflictException({
      code: FailureCode.RootQuotaPending,
      message: 'A previous root quota change is still pending',
      details: { containerId: locked.id },
    });
  }
  const image = await transaction.selectFrom('infra.images')
    .select('min_root_size_bytes')
    .where('id', '=', locked.image_id)
    .forUpdate()
    .executeTakeFirst();
  const minimum = image?.min_root_size_bytes === null || image?.min_root_size_bytes === undefined
    ? 0
    : numberValue(image.min_root_size_bytes);
  if (size < minimum) {
    throw new ConflictException({
      code: FailureCode.RootSizeBelowImageMinimum,
      message: 'Root size is below the image minimum',
      details: {
        imageId: locked.image_id,
        requestedBytes: size,
        minimumBytes: minimum,
      },
    });
  }
  const current = numberValue(locked.root_size_bytes);
  if (size === current) return;
  if (size > current) {
    await assertRootCapacity(
      repository,
      transaction,
      locked.owner_id,
      locked.server_id,
      locked.root_pool_id,
      size - current,
      grant?.diskBytes ?? null,
    );
    return;
  }
  const pool = await transaction.selectFrom('infra.storage_pools')
    .select(['resize_family', 'quota_effective'])
    .where('id', '=', locked.root_pool_id)
    .where('registered', '=', true)
    .forUpdate()
    .executeTakeFirst();
  if (!pool) {
    throw new ConflictException({
      code: FailureCode.StoragePoolExhausted,
      message: 'The root storage pool is no longer usable',
      details: { poolId: locked.root_pool_id },
    });
  }
  if (pool.resize_family === 'quota_online' && pool.quota_effective !== true) {
    throw new ConflictException({
      code: FailureCode.StoragePoolQuotaIneffective,
      message: 'The root storage pool cannot enforce root quotas',
      details: { poolId: locked.root_pool_id },
    });
  }
  const route = await repository.currentRoute(locked.id, transaction);
  const failure = checkRootResize({
    containerId: locked.id,
    requestedBytes: size,
    currentBytes: current,
    usedBytes: nullableNumber(locked.root_used_bytes),
    resizeFamily: pool.resize_family,
    observedStatus: containerStatus(
      route?.instance_status,
      locked.power_intent as ContainerPowerIntent,
    ),
  });
  if (failure) throw new ConflictException(failure);
}
