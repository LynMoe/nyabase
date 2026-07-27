import { ConflictException } from '@nestjs/common';

export interface ResourceLockConflict {
  resourceKey: string;
  taskId: string;
}

/** Stable API error for conflicts reported by the PostgreSQL workflow lock set. */
export class ResourceLockedException extends ConflictException {
  constructor(readonly conflicts: ResourceLockConflict[]) {
    super({
      statusCode: 409,
      code: 'RESOURCE_LOCKED',
      reason: 'resource_locked',
      lockedResourceKeys: conflicts.map((conflict) => conflict.resourceKey),
      locks: conflicts.map((conflict) => ({
        resourceKey: conflict.resourceKey,
        taskId: conflict.taskId,
      })),
      message: 'Resource is locked by an active task',
    });
  }
}
