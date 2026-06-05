import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GroupsService } from './groups.service.js';
import { GroupsController } from './groups.controller.js';
import { UserGrantsController } from './user-grants.controller.js';
import { MeAccessController } from './me-access.controller.js';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { QuotaModule } from '../quota/quota.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GroupEntity,
      GroupMemberEntity,
      ServerGrantEntity,
      ImageGrantEntity,
      MountSourceGrantEntity,
      RemoteFsMountEntity,
      DataDiskEntity,
      UserEntity,
    ]),
    AccessModule,
    AuthModule,
    AuditModule,
    QuotaModule,
  ],
  providers: [GroupsService],
  controllers: [GroupsController, UserGrantsController, MeAccessController],
  exports: [GroupsService],
})
export class GroupsModule {}
