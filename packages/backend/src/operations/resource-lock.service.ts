import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';

export interface AcquiredResourceLock {
  resourceKey: string;
  holderId: string;
  fencingToken: number;
}

@Injectable()
export class ResourceLockService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(ResourceLockEntity)
    private locksRepo: Repository<ResourceLockEntity>,
  ) {}

  async acquire(
    resourceKey: string,
    holderId: string,
    ttlMs = 30_000,
  ): Promise<AcquiredResourceLock | null> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    return runSerializedTransaction(this.dataSource, async (manager) => {
      await manager.delete(ResourceLockEntity, {
        resourceKey,
        expiresAt: LessThan(now),
      });

      const existing = await manager.findOne(ResourceLockEntity, {
        where: { resourceKey },
      });
      if (existing && existing.holderId !== holderId && existing.expiresAt > now) {
        return null;
      }

      const fencingToken = (existing?.fencingToken ?? 0) + 1;
      await manager.save(
        ResourceLockEntity,
        manager.create(ResourceLockEntity, {
          resourceKey,
          holderId,
          fencingToken,
          expiresAt,
        }),
      );
      return { resourceKey, holderId, fencingToken };
    });
  }

  async release(lock: AcquiredResourceLock): Promise<void> {
    await this.locksRepo.delete({
      resourceKey: lock.resourceKey,
      holderId: lock.holderId,
      fencingToken: lock.fencingToken,
    });
  }

  async recoverExpired(now = new Date()): Promise<number> {
    const result = await this.locksRepo.delete({ expiresAt: LessThan(now) });
    return result.affected ?? 0;
  }
}
