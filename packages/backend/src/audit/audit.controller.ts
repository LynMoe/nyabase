import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { AuditLogEntity } from '../entities/audit-log.entity.js';
import { Capability } from '@nyabase/common';

@Controller('audit')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ViewAudit)
export class AuditController {
  constructor(
    @InjectRepository(AuditLogEntity)
    private repo: Repository<AuditLogEntity>,
  ) {}

  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.repo.find({
      order: { ts: 'DESC' },
      take: parseInt(limit ?? '100', 10),
      skip: parseInt(offset ?? '0', 10),
    });
  }
}
