import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { AppService } from './app.service.js';
import { NyabaseConfigModule } from './config/nyabase-config.module.js';
import { HealthController } from './health/health.controller.js';
import { RedisRuntimeModule } from './runtime/redis-runtime.module.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { RuntimeLifecycleService } from './health/runtime-lifecycle.service.js';
import { AccessModule } from './access/access.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ContainersModule } from './containers/containers.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { HttpProxyModule } from './http-proxy/http-proxy.module.js';
import { ImagesModule } from './images/images.module.js';
import { ServersModule } from './servers/servers.module.js';
import { SharedBackendsModule } from './shared-backends/shared-backends.module.js';
import { IpPoolsModule } from './ip-pools/ip-pools.module.js';
import { SshModule } from './ssh/ssh.module.js';
import { StoragePoolsModule } from './storage-pools/storage-pools.module.js';
import { UsersModule } from './users/users.module.js';
import { VolumesModule } from './volumes/volumes.module.js';
import { SystemSettingsModule } from './system-settings/system-settings.module.js';
import { GrantExpiryModule } from './access/grant-expiry.module.js';

@Module({
  imports: [
    NyabaseConfigModule,
    RedisRuntimeModule,
    RuntimeModule,
    DatabaseModule,
    MetricsModule,
    AccessModule,
    AuditModule,
    AuthModule,
    ContainersModule,
    GroupsModule,
    HttpProxyModule,
    ImagesModule,
    ServersModule,
    SharedBackendsModule,
    IpPoolsModule,
    SshModule,
    StoragePoolsModule,
    SystemSettingsModule,
    UsersModule,
    VolumesModule,
    GrantExpiryModule,
  ],
  controllers: [
    HealthController,
  ],
  providers: [AppService, RuntimeLifecycleService],
})
export class AppModule {}
