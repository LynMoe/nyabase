import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { ServersModule } from './servers/servers.module.js';
import { ImagesModule } from './images/images.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { AgentGatewayModule } from './gateway/agent-gateway.module.js';
import { ContainersModule } from './containers/containers.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { DataDirsModule } from './datadirs/datadirs.module.js';
import { AuditModule } from './audit/audit.module.js';
import { RemoteFsMountsModule } from './remote-fs/remote-fs-mounts.module.js';
import { MountSourcesModule } from './mount-sources/mount-sources.module.js';
import { AgentTasksModule } from './agent-tasks/agent-tasks.module.js';
import { AgentTasksController } from './agent-tasks/agent-tasks.controller.js';
import { AdminAgentTasksController } from './agent-tasks/admin-agent-tasks.controller.js';
import { AdminAgentQuarantineController } from './agent-tasks/admin-agent-quarantine.controller.js';
import { SshModule } from './ssh/ssh.module.js';
import { SystemSettingsModule } from './system-settings/system-settings.module.js';
import { HttpProxyModule } from './http-proxy/http-proxy.module.js';
import { AppService } from './app.service.js';
import { NyabaseConfigModule } from './config/nyabase-config.module.js';
import { AccessModule } from './access/access.module.js';
import { GrantExpiryModule } from './access/grant-expiry.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { HealthController } from './health/health.controller.js';
import { RedisRuntimeModule } from './runtime/redis-runtime.module.js';
import { RuntimeLifecycleService } from './health/runtime-lifecycle.service.js';

@Module({
  imports: [
    NyabaseConfigModule,
    RedisRuntimeModule,
    DatabaseModule,
    AccessModule,
    AuthModule,
    UsersModule,
    ServersModule,
    ImagesModule,
    GroupsModule,
    AgentGatewayModule,
    ContainersModule,
    MetricsModule,
    DataDirsModule,
    AuditModule,
    RemoteFsMountsModule,
    MountSourcesModule,
    AgentTasksModule,
    SshModule,
    HttpProxyModule,
    SystemSettingsModule,
    CatalogModule,
    GrantExpiryModule,
  ],
  controllers: [
    HealthController,
    AgentTasksController,
    AdminAgentTasksController,
    AdminAgentQuarantineController,
  ],
  providers: [AppService, RuntimeLifecycleService],
})
export class AppModule {}
