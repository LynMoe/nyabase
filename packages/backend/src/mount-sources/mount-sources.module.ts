import { Module, forwardRef } from '@nestjs/common';
import { MountSourcesController } from './mount-sources.controller.js';
import { AdminMountSourcesController } from './admin-mount-sources.controller.js';
import { MountSourcesService } from './mount-sources.service.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { StorageModule } from '../storage/storage.module.js';

@Module({
  imports: [
    StorageModule,
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
    forwardRef(() => AuditModule),
    forwardRef(() => AgentGatewayModule),
  ],
  controllers: [MountSourcesController, AdminMountSourcesController],
  providers: [MountSourcesService],
  exports: [MountSourcesService],
})
export class MountSourcesModule {}
