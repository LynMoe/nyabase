import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AdminIpPoolsController } from './ip-pools.controller.js';
import { IpPoolsRepository } from './ip-pools.repository.js';
import { IpPoolsService } from './ip-pools.service.js';

@Module({
  imports: [AuthModule, AccessModule, AuditModule, DatabaseModule],
  providers: [IpPoolsRepository, IpPoolsService],
  controllers: [AdminIpPoolsController],
  exports: [IpPoolsRepository, IpPoolsService],
})
export class IpPoolsModule {}
