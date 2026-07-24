import { ConflictException } from '@nestjs/common';
import { In, type EntityManager } from 'typeorm';
import { MAX_MANAGED_DATA_DIRS_PER_AGENT } from '@nyabase/common';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';

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
  manager: EntityManager,
  serverId: string,
  options: ProjectionOptions = {},
): Promise<void> {
  const assignments = await manager.find(RemoteFsServerAssignmentEntity, {
    where: { serverId },
  });
  const remoteMountIds = new Set(assignments.map((assignment) => assignment.remoteFsMountId));
  if (options.includeRemoteMountId) remoteMountIds.add(options.includeRemoteMountId);
  const [localCount, remoteCount] = await Promise.all([
    manager.count(DataDirectoryEntity, {
      where: { sourceKind: 'local', serverId },
    }),
    remoteMountIds.size === 0
      ? Promise.resolve(0)
      : manager.count(DataDirectoryEntity, {
        where: { sourceKind: 'remote', sourceId: In([...remoteMountIds]) },
      }),
  ]);
  const projected = localCount + remoteCount + (options.additionalRows ?? 0);
  if (projected > MAX_MANAGED_DATA_DIRS_PER_AGENT) {
    throw new ConflictException({
      code: 'DATA_DIRECTORY_CAPACITY_REACHED',
      message: `Server data-directory inventory would exceed ${MAX_MANAGED_DATA_DIRS_PER_AGENT} entries`,
    });
  }
}
