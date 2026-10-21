import { Module } from '@nestjs/common';
import { IamBootstrapService } from './iam-bootstrap.service.js';
import { UsersService } from './users.service.js';
import { UserSshKeysService } from './user-ssh-keys.service.js';
import { UsersController } from './users.controller.js';
import { ContainersModule } from '../containers/containers.module.js';
import { GroupsModule } from '../groups/groups.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';

@Module({
  imports: [
    GroupsModule,
    ContainersModule,
    SshModule,
    ProxySnapshotNotifierModule,
  ],
  providers: [UsersService, UserSshKeysService, IamBootstrapService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
