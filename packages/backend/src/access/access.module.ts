import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessResolverService } from './access-resolver.service.js';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GroupEntity,
      GroupMemberEntity,
      ServerGrantEntity,
      ImageGrantEntity,
      ImageEntity,
      ServerEntity,
      MountSourceGrantEntity,
      RemoteFsServerAssignmentEntity,
      DataDiskEntity,
    ]),
  ],
  providers: [AccessResolverService],
  exports: [AccessResolverService],
})
export class AccessModule {}
