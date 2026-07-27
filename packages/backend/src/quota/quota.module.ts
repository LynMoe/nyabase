import { Module, forwardRef } from '@nestjs/common';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { QuotaDispatchService } from './quota-dispatch.service.js';
import { StorageModule } from '../storage/storage.module.js';
import {
  QuotaWorkflowFinalizerService,
} from './quota-workflow-finalizer.service.js';

@Module({
  imports: [StorageModule, forwardRef(() => AgentTasksModule)],
  providers: [QuotaDispatchService, QuotaWorkflowFinalizerService],
  exports: [QuotaDispatchService],
})
export class QuotaModule {}
