import { Module } from '@nestjs/common';
import { ImagesService } from './images.service.js';
import { ImagesController } from './images.controller.js';
import { AdminImagesController } from './admin-images.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { ImageWorkflowFinalizerService } from './image-workflow-finalizer.service.js';

@Module({
  imports: [
    AuthModule,
    AccessModule,
    AgentGatewayModule,
    AgentTasksModule,
    SshModule,
    AuditModule,
    InfrastructureModule,
  ],
  providers: [ImagesService, ImageWorkflowFinalizerService],
  controllers: [ImagesController, AdminImagesController],
  exports: [ImagesService],
})
export class ImagesModule {}
