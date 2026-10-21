import { Module } from '@nestjs/common';
import { IamBootstrapService } from './iam-bootstrap.service.js';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';
import { AdminUsersController } from './admin-users.controller.js';
import { GroupsModule } from '../groups/groups.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';

@Module({
  imports: [
    GroupsModule,
    SshModule,
    ProxySnapshotNotifierModule,
  ],
  providers: [UsersService, IamBootstrapService],
  controllers: [UsersController, AdminUsersController],
  exports: [UsersService],
})
export class UsersModule {}
