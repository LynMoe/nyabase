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
import { OperationsModule } from '../operations/operations.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, SshPublicKeyEntity]),
    AuthModule,
    AccessModule,
    GroupsModule,
    forwardRef(() => OperationsModule),
  ],
  providers: [UsersService],
  controllers: [UsersController, AdminUsersController],
  exports: [UsersService],
})
export class UsersModule {}
