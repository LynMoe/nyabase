import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { GroupEntity } from '../entities/group.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { AdminCatalogController } from './admin-catalog.controller.js';
import { AccessModule } from '../access/access.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      GroupEntity,
      ImageEntity,
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      ServerEntity,
    ]),
    AuthModule,
    // CapabilitiesGuard resolves current durable authority through this
    // provider; importing AuthModule alone does not re-export its dependency.
    AccessModule,
    AgentGatewayModule,
  ],
  controllers: [AdminCatalogController],
})
export class CatalogModule {}
