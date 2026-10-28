import { Module } from '@nestjs/common';
import { IamBootstrapService } from './iam-bootstrap.service.js';
import { UsersService } from './users.service.js';
import { UserSshKeysService } from './user-ssh-keys.service.js';
import { UsersController } from './users.controller.js';
import { ContainersModule } from '../containers/containers.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { SshHostCaModule } from '../ssh-host-ca/ssh-host-ca.module.js';
import { SshClientConfigService } from './ssh-client-config.service.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';

@Module({
  imports: [
    ContainersModule,
    SshModule,
    SshHostCaModule,
    ProxySnapshotNotifierModule,
  ],
  providers: [UsersService, UserSshKeysService, SshClientConfigService, IamBootstrapService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
