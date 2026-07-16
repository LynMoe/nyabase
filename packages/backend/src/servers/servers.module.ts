import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServersService } from './servers.service.js';
import { ServersController } from './servers.controller.js';
import { AdminServersController } from './admin-servers.controller.js';
import { ServerEntity } from '../entities/server.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { UsersModule } from '../users/users.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { QuotaModule } from '../quota/quota.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ServerEntity,
      MountSourceGrantEntity,
    ]),
    AuthModule,
    AccessModule,
    forwardRef(() => UsersModule),
    forwardRef(() => AgentGatewayModule),
    forwardRef(() => QuotaModule),
    forwardRef(() => SshModule),
    ProxySnapshotNotifierModule,
  ],
  providers: [ServersService],
  controllers: [ServersController, AdminServersController],
  exports: [ServersService],
})
export class ServersModule {}
