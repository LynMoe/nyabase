import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RemoteFsMountsService } from './remote-fs-mounts.service.js';
import { RemoteFsMountsController } from './remote-fs-mounts.controller.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { RemoteFsSecretCryptoService } from './remote-fs-secret-crypto.service.js';
import { ServerEntity } from '../entities/server.entity.js';
import { MountSourcesModule } from '../mount-sources/mount-sources.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      ContainerMountEntity,
      DataDirectoryEntity,
      ServerEntity,
    ]),
    AuthModule,
    AccessModule,
    AuditModule,
    AgentTasksModule,
    AgentGatewayModule,
    MountSourcesModule,
    ProxySnapshotNotifierModule,
  ],
  providers: [RemoteFsMountsService, RemoteFsSecretCryptoService],
  controllers: [RemoteFsMountsController],
  exports: [RemoteFsMountsService],
})
export class RemoteFsMountsModule {}
