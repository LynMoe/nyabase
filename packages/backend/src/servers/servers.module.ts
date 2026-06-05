import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServersService } from './servers.service.js';
import { ServersController } from './servers.controller.js';
import { AdminServersController } from './admin-servers.controller.js';
import { ServerEntity } from '../entities/server.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDiskRuntimeObservationEntity } from '../entities/data-disk-runtime-observation.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { QuotaRuntimeObservationEntity } from '../entities/quota-runtime-observation.entity.js';
import { RuntimeGpuInventoryEntity } from '../entities/runtime-gpu-inventory.entity.js';
import { DockerDaemonRuntimeObservationEntity } from '../entities/docker-daemon-runtime-observation.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { UsersModule } from '../users/users.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { OperationsModule } from '../operations/operations.module.js';
import { QuotaModule } from '../quota/quota.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ServerEntity,
      DataDiskEntity,
      DataDirectoryEntity,
      DataDiskRuntimeObservationEntity,
      ContainerMountEntity,
      MountSourceGrantEntity,
      QuotaRuntimeObservationEntity,
      RuntimeGpuInventoryEntity,
      DockerDaemonRuntimeObservationEntity,
    ]),
    AuthModule,
    AccessModule,
    UsersModule,
    AgentGatewayModule,
    OperationsModule,
    QuotaModule,
  ],
  providers: [ServersService],
  controllers: [ServersController, AdminServersController],
  exports: [ServersService],
})
export class ServersModule {}
