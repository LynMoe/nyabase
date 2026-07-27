import { ConflictException } from '@nestjs/common';
import { MAX_MANAGED_DATA_DIRS_PER_AGENT } from '@nyabase/common';
import type { Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { StorageRepository } from '../storage/storage.repository.js';

interface ProjectionOptions {
  /** Include a RemoteFS mount that this transaction is about to assign. */
  includeRemoteMountId?: string;
  /** Rows this transaction is about to add to every included source. */
  additionalRows?: number;
}

/**
 * Enforce the Agent wire limit against one Server's complete projected view:
 * its local rows plus global RemoteFS rows for every durable assignment.
 * Transition assignments are intentionally included because the physical
 * source can already be mounted before its database-only finalizer runs.
 */
export async function assertAgentDataDirCapacity(
  storage: StorageRepository,
  transaction: Transaction<NyabaseDatabase>,
  serverId: string,
  options: ProjectionOptions = {},
): Promise<void> {
  await storage.lockDataDirectoryCapacity(serverId, transaction);
  const projected = await storage.countDataDirectoryProjection(
    serverId,
    options.includeRemoteMountId,
    transaction,
  ) + (options.additionalRows ?? 0);
  if (projected > MAX_MANAGED_DATA_DIRS_PER_AGENT) {
    throw new ConflictException({
      code: 'DATA_DIRECTORY_CAPACITY_REACHED',
      message: `Server data-directory inventory would exceed ${MAX_MANAGED_DATA_DIRS_PER_AGENT} entries`,
    });
  }
}
