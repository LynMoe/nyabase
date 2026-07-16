import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MountSourcesController } from './mount-sources.controller.js';
import { AdminMountSourcesController } from './admin-mount-sources.controller.js';
import { MountSourcesService } from './mount-sources.service.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      MountSourceGrantEntity,
    ]),
    AuthModule,
    AccessModule,
    AuditModule,
    forwardRef(() => AgentGatewayModule),
  ],
  controllers: [MountSourcesController, AdminMountSourcesController],
  providers: [MountSourcesService],
  exports: [MountSourcesService],
})
export class MountSourcesModule {}
