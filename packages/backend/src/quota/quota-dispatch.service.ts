import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AgentCommandKind, OperationKind } from '@nyabase/common';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { OperationsService } from '../operations/operations.service.js';
import { ResourceKeyService } from '../operations/resource-key.service.js';

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
    private operations: OperationsService,
    private resourceKeys: ResourceKeyService,
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

      const dispatched = await this.operations.dispatchAgentCommand({
        operationKind: OperationKind.QuotaApply,
        commandKind: AgentCommandKind.QuotaApply,
        serverId: request.serverId,
        resourceType: 'quota',
        resourceId: request.userId,
        requestedBy: request.requestedBy,
        payload: {
          numericUserId: request.numericUserId,
          diskBytes: request.diskBytes,
        },
        request: {
          source: 'quota_dispatch',
          numericUserId: request.numericUserId,
          diskBytes: request.diskBytes,
        },
        resourceKeys: [this.resourceKeys.quota(request.serverId, request.userId)],
      });
      await this.quotaDesiredRepo.update(desired.id, {
        lastOperationId: dispatched.operationId,
      });
    });
  }

  private enqueueDurableDispatch(fn: () => Promise<void>): Promise<void> {
    const run = this.durableQueue.then(fn, fn);
    this.durableQueue = run.catch(() => undefined);
    return run;
  }
}
