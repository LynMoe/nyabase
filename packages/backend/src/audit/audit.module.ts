import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';
import { AuditLogEntity } from '../entities/audit-log.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLogEntity]),
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
  ],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
