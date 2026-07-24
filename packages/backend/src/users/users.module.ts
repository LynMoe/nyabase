import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';
import { AdminUsersController } from './admin-users.controller.js';
import { UserEntity } from '../entities/user.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { GroupsModule } from '../groups/groups.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { QuotaModule } from '../quota/quota.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, SshPublicKeyEntity, UserInternalSshKeyEntity]),
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
    forwardRef(() => GroupsModule),
    forwardRef(() => SshModule),
    ProxySnapshotNotifierModule,
    forwardRef(() => AuditModule),
    forwardRef(() => QuotaModule),
  ],
  providers: [UsersService],
  controllers: [UsersController, AdminUsersController],
  exports: [UsersService],
})
export class UsersModule {}
