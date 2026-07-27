import { Module, forwardRef } from '@nestjs/common';
import { ServersService } from './servers.service.js';
import { ServersController } from './servers.controller.js';
import { AdminServersController } from './admin-servers.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { UsersModule } from '../users/users.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { QuotaModule } from '../quota/quota.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
    forwardRef(() => UsersModule),
    forwardRef(() => AgentGatewayModule),
    forwardRef(() => QuotaModule),
    forwardRef(() => SshModule),
    ProxySnapshotNotifierModule,
    AuditModule,
    InfrastructureModule,
    AgentTasksModule,
  ],
  providers: [ServersService],
  controllers: [ServersController, AdminServersController],
  exports: [ServersService],
})
export class ServersModule {}
