import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContainersService } from './containers.service.js';
import { ContainersController } from './containers.controller.js';
import { AdminContainersController } from './admin-containers.controller.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import { ContainerControlService } from './container-control.service.js';
import { ContainerTaskService } from './container-task.service.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ContainerEntity,
      ServerEntity,
      UserEntity,
      ImageEntity,
      GpuAllocationEntity,
      ContainerLifecycleEntity,
      ContainerDesiredSpecEntity,
      AgentTaskEntity,
      DataDirectoryEntity,
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      UserInternalSshKeyEntity,
      ContainerSshRouteEntity,
    ]),
    AuthModule,
    AccessModule,
    AgentTasksModule,
    AgentGatewayModule,
    SshModule,
    ProxySnapshotNotifierModule,
  ],
  providers: [
    ContainersService,
    ContainerActionPolicyService,
    ContainerControlService,
    ContainerTaskService,
  ],
  controllers: [ContainersController, AdminContainersController],
  exports: [
    ContainersService,
    ContainerActionPolicyService,
    ContainerControlService,
    ContainerTaskService,
  ],
})
export class ContainersModule {}
