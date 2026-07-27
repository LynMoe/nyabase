import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { GroupsModule } from '../groups/groups.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { QuotaModule } from '../quota/quota.module.js';
import { UserSshIdentityService } from './user-ssh-identity.service.js';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
    forwardRef(() => GroupsModule),
    forwardRef(() => SshModule),
    ProxySnapshotNotifierModule,
    forwardRef(() => AuditModule),
    forwardRef(() => QuotaModule),
  ],
  providers: [UsersService, UserSshIdentityService],
  controllers: [UsersController, AdminUsersController],
  exports: [UsersService, UserSshIdentityService],
})
export class UsersModule {}
