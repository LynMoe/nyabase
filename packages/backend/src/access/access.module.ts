import { Module, forwardRef } from '@nestjs/common';
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
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { AccessCacheEpochModule } from './access-cache-epoch.module.js';
import { AccessRevocationGuardService } from './access-revocation-guard.service.js';

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
    ]),
    AccessCacheEpochModule,
    forwardRef(() => AgentGatewayModule),
  ],
  providers: [AccessResolverService, AccessRevocationGuardService],
  exports: [AccessResolverService, AccessRevocationGuardService],
})
export class AccessModule {}
