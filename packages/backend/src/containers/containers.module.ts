import { Module } from '@nestjs/common';
import { ContainersService } from './containers.service.js';
import { ContainersController } from './containers.controller.js';
import { AdminContainersController } from './admin-containers.controller.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import { ContainerControlService } from './container-control.service.js';
import { ContainerTaskService } from './container-task.service.js';
import { ContainerControlRepository } from './container-control.repository.js';
import { ContainerWorkflowFinalizerService } from './container-workflow-finalizer.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [
    AuthModule,
    AccessModule,
    AgentTasksModule,
    AgentGatewayModule,
    SshModule,
    ProxySnapshotNotifierModule,
    AuditModule,
  ],
  providers: [
    ContainersService,
    ContainerActionPolicyService,
    ContainerControlService,
    ContainerControlRepository,
    ContainerTaskService,
    ContainerWorkflowFinalizerService,
  ],
  controllers: [ContainersController, AdminContainersController],
  exports: [
    ContainersService,
    ContainerActionPolicyService,
    ContainerControlService,
    ContainerControlRepository,
    ContainerTaskService,
  ],
})
export class ContainersModule {}
