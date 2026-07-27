import { Module, forwardRef } from '@nestjs/common';
import { DataDirsService } from './datadirs.service.js';
import { DataDirsController } from './datadirs.controller.js';
import { AdminDataDirsController } from './admin-datadirs.controller.js';
import { DataDirReconcilerService } from './data-dir-reconciler.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { StorageModule } from '../storage/storage.module.js';
import {
  DataDirWorkflowFinalizerService,
} from './data-dir-workflow-finalizer.service.js';

@Module({
  imports: [
    StorageModule,
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
    forwardRef(() => ServersModule),
    forwardRef(() => AuditModule),
    AgentTasksModule,
    forwardRef(() => AgentGatewayModule),
  ],
  providers: [
    DataDirsService,
    DataDirReconcilerService,
    DataDirWorkflowFinalizerService,
  ],
  controllers: [DataDirsController, AdminDataDirsController],
  exports: [DataDirsService, DataDirReconcilerService],
})
export class DataDirsModule {}
