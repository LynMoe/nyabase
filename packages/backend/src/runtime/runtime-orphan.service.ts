import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { RuntimeOrphanEntity, type RuntimeOrphanReason } from '../entities/runtime-orphan.entity.js';

export interface RuntimeOrphanInput {
  serverId: string;
  runtimeId: string;
  reason: RuntimeOrphanReason;
  labels: Record<string, string>;
  observedAt: Date;
  cleanupHint?: unknown;
}

@Injectable()
export class RuntimeOrphanService {
  constructor(
    @InjectRepository(RuntimeOrphanEntity)
    private orphansRepo: Repository<RuntimeOrphanEntity>,
  ) {}

  async upsert(input: RuntimeOrphanInput, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(RuntimeOrphanEntity) : this.orphansRepo;
    const entity = repo.create({
      id: `${input.serverId}:${input.runtimeId}`,
      serverId: input.serverId,
      runtimeId: input.runtimeId,
      reason: input.reason,
      labelsJson: input.labels,
      observedAt: input.observedAt,
      cleanupHintJson: input.cleanupHint ?? { action: 'inspect_or_delete_runtime_container' },
    });
    await repo.upsert(entity as unknown as import('typeorm').QueryDeepPartialEntity<RuntimeOrphanEntity>, ['serverId', 'runtimeId']);
  }

  async clear(serverId: string, runtimeId: string, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(RuntimeOrphanEntity) : this.orphansRepo;
    await repo.delete({ serverId, runtimeId });
  }

  classify(labels: Record<string, string>, desiredExists: boolean): RuntimeOrphanReason | null {
    const containerId = this.containerIdFromLabels(labels);
    if (!containerId) return 'missing_label';
    if (!desiredExists) return 'desired_missing';
    return null;
  }

  containerIdFromLabels(labels: Record<string, string>): string | null {
    const value = labels['nyabase.containerId'] ?? labels['nyabase.container_id'];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }
}
