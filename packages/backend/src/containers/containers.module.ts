import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContainersService } from './containers.service.js';
import { ContainersController } from './containers.controller.js';
import { AdminContainersController } from './admin-containers.controller.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import { ContainerControlService } from './container-control.service.js';
import { ContainerOperationService } from './container-operation.service.js';
import { ContainerSshSyncService } from './container-ssh-sync.service.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { RuntimeOrphanEntity } from '../entities/runtime-orphan.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { OperationsModule } from '../operations/operations.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { SshModule } from '../ssh/ssh.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ContainerEntity,
      ServerEntity,
      RuntimeOrphanEntity,
      UserEntity,
      ImageEntity,
      GpuAllocationEntity,
      ContainerLifecycleEntity,
      ContainerDesiredSpecEntity,
      OperationEntity,
      DataDiskEntity,
      DataDirectoryEntity,
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      UserInternalSshKeyEntity,
      ContainerSshRouteEntity,
    ]),
    AuthModule,
    AccessModule,
    OperationsModule,
    AgentGatewayModule,
    SshModule,
  ],
  providers: [
    ContainersService,
    ContainerActionPolicyService,
    ContainerControlService,
    ContainerOperationService,
    ContainerSshSyncService,
  ],
  controllers: [ContainersController, AdminContainersController],
  exports: [
    ContainersService,
    ContainerActionPolicyService,
    ContainerControlService,
    ContainerOperationService,
    ContainerSshSyncService,
  ],
})
export class ContainersModule {}
