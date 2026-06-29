import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { ResourceKeyService } from '../operations/resource-key.service.js';
import { SshModule } from '../ssh/ssh.module.js';
import { COMMAND_HOOKS, CommandHookRegistry } from './command-hook-registry.service.js';
import { ContainerMountsEnsureHook } from './container-mounts-ensure.hook.js';
import { ContainerSshEnsureHook } from './container-ssh-ensure.hook.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ContainerEntity,
      ContainerDesiredSpecEntity,
      DataDirectoryEntity,
      DataDiskEntity,
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      ImageEntity,
    ]),
    forwardRef(() => AgentGatewayModule),
    forwardRef(() => SshModule),
  ],
  providers: [
    ResourceKeyService,
    ContainerMountsEnsureHook,
    ContainerSshEnsureHook,
    {
      provide: COMMAND_HOOKS,
      useFactory: (
        mounts: ContainerMountsEnsureHook,
        ssh: ContainerSshEnsureHook,
      ) => [mounts, ssh],
      inject: [
        ContainerMountsEnsureHook,
        ContainerSshEnsureHook,
      ],
    },
    CommandHookRegistry,
  ],
  exports: [
    CommandHookRegistry,
    ContainerMountsEnsureHook,
    ContainerSshEnsureHook,
  ],
})
export class CommandHooksModule {}
