import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { QuotaDispatchService } from './quota-dispatch.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([QuotaDesiredEntity]), forwardRef(() => AgentTasksModule)],
  providers: [QuotaDispatchService],
  exports: [QuotaDispatchService],
})
export class QuotaModule {}
