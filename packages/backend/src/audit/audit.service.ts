import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AuditLogEntity } from '../entities/audit-log.entity.js';
import { AuditAction } from '@nyabase/common';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLogEntity)
    private repo: Repository<AuditLogEntity>,
  ) {}

  async log(
    actorId: string | null,
    action: AuditAction,
    targetId: string,
    targetType: string,
    payload?: unknown,
  ): Promise<void> {
    await this.repo.save(
      this.repo.create({
        id: uuidv4(),
        actorId,
        action,
        targetId,
        targetType,
        payload: payload ?? null,
        ts: new Date(),
      }),
    );
  }
}
