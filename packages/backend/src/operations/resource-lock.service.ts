import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';

export interface ResourceLockConflict {
  resourceKey: string;
  operationId: string;
}

export class ResourceLockedException extends ConflictException {
  constructor(readonly conflicts: ResourceLockConflict[]) {
    super({
      statusCode: 409,
      code: 'RESOURCE_LOCKED',
      reason: 'resource_locked',
      lockedResourceKeys: conflicts.map((conflict) => conflict.resourceKey),
      locks: conflicts.map((conflict) => ({
        resourceKey: conflict.resourceKey,
        operationId: conflict.operationId,
      })),
      message: 'Resource is locked by an active operation',
    });
  }
}

@Injectable()
export class ResourceLockService {
  constructor(
    @InjectRepository(ResourceLockEntity)
    private locksRepo: Repository<ResourceLockEntity>,
  ) {}

  async findConflicts(
    manager: EntityManager,
    resourceKeys: string[],
    operationId: string,
  ): Promise<ResourceLockConflict[]> {
    if (resourceKeys.length === 0) return [];
    const existing = await manager.find(ResourceLockEntity, {
      where: { resourceKey: In(resourceKeys) },
    });
    return existing
      .filter((lock) => lock.operationId !== operationId)
      .map((lock) => ({
        resourceKey: lock.resourceKey,
        operationId: lock.operationId,
      }))
      .sort((a, b) => a.resourceKey.localeCompare(b.resourceKey));
  }

  async insertForOperation(
    manager: EntityManager,
    input: {
      operationId: string;
      serverId: string;
      resourceKeys: string[];
    },
  ): Promise<void> {
    const keys = [...new Set(input.resourceKeys)].sort();
    const conflicts = await this.findConflicts(manager, keys, input.operationId);
    if (conflicts.length > 0) {
      throw new ResourceLockedException(conflicts);
    }
    for (const resourceKey of keys) {
      await manager.insert(ResourceLockEntity, {
        resourceKey,
        operationId: input.operationId,
        serverId: input.serverId,
      });
    }
  }

  async releaseOperation(operationId: string, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(ResourceLockEntity) : this.locksRepo;
    await repo.delete({ operationId });
  }

  async releaseOperations(operationIds: string[], manager: EntityManager): Promise<void> {
    if (operationIds.length === 0) return;
    await manager.delete(ResourceLockEntity, { operationId: In(operationIds) });
  }

  async findActiveByResourceKeys(resourceKeys: string[]): Promise<ResourceLockEntity[]> {
    if (resourceKeys.length === 0) return [];
    return this.locksRepo.find({
      where: { resourceKey: In(resourceKeys) },
      order: { resourceKey: 'ASC' },
    });
  }
}
