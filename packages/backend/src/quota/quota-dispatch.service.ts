import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { HookKind } from '@nyabase/common';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { LifecycleHookRegistryService } from '../operations/lifecycle-hook-registry.service.js';

export interface QuotaApplyRequest {
  serverId: string;
  userId: string;
  numericUserId: number;
  diskBytes: number;
  requestedBy: string | null;
}

@Injectable()
export class QuotaDispatchService {
  private durableQueue: Promise<void> = Promise.resolve();

  constructor(
    @InjectRepository(QuotaDesiredEntity)
    private quotaDesiredRepo: Repository<QuotaDesiredEntity>,
    private lifecycleHooks: LifecycleHookRegistryService,
  ) {}

  async apply(request: QuotaApplyRequest): Promise<void> {
    await this.enqueueDurableDispatch(async () => {
      const existing = await this.quotaDesiredRepo.findOne({
        where: { serverId: request.serverId, userId: request.userId },
      });
      const desired = await this.quotaDesiredRepo.save(
        this.quotaDesiredRepo.create({
          id: existing?.id ?? uuidv4(),
          serverId: request.serverId,
          userId: request.userId,
          numericUserId: request.numericUserId,
          limitBytes: request.diskBytes,
          source: 'grant',
          generation: (existing?.generation ?? 0) + 1,
          lastOperationId: existing?.lastOperationId ?? null,
        }),
      );

      await this.lifecycleHooks.enqueue({
        hook: HookKind.Quota,
        resourceType: 'quota',
        resourceId: request.userId,
        serverId: request.serverId,
        desiredGeneration: desired.generation,
        result: {
          source: 'quota_dispatch',
          requestedBy: request.requestedBy,
          numericUserId: request.numericUserId,
          diskBytes: request.diskBytes,
        },
      });
    });
  }

  private enqueueDurableDispatch(fn: () => Promise<void>): Promise<void> {
    const run = this.durableQueue.then(fn, fn);
    this.durableQueue = run.catch(() => undefined);
    return run;
  }
}
