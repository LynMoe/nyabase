import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataDirsService } from './datadirs.service.js';
import { DataDirsController } from './datadirs.controller.js';
import { AdminDataDirsController } from './admin-datadirs.controller.js';
import { DataDirReconcilerService } from './data-dir-reconciler.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DataDirectoryEntity,
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      ContainerMountEntity,
      QuotaDesiredEntity,
    ]),
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
    forwardRef(() => ServersModule),
    forwardRef(() => UsersModule),
    forwardRef(() => AuditModule),
    AgentTasksModule,
    forwardRef(() => AgentGatewayModule),
  ],
  providers: [DataDirsService, DataDirReconcilerService],
  controllers: [DataDirsController, AdminDataDirsController],
  exports: [DataDirsService, DataDirReconcilerService],
})
export class DataDirsModule {}
