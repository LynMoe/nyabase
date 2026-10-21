import { Module } from '@nestjs/common';
import { AccessModule } from './access/access.module.js';
import { AuditModule } from './audit/audit.module.js';
import { ContainersModule } from './containers/containers.module.js';
import { GpuModule } from './gpu/gpu.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { HealthController } from './health/health.controller.js';
import { RuntimeLifecycleService } from './health/runtime-lifecycle.service.js';
import { HttpProxyModule } from './http-proxy/http-proxy.module.js';
import { IamModule } from './iam/iam.module.js';
import { ImagesModule } from './images/images.module.js';
import { IpPoolsModule } from './ip-pools/ip-pools.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { ServersModule } from './servers/servers.module.js';
import { SharedBackendsModule } from './shared-backends/shared-backends.module.js';
import { SshModule } from './ssh/ssh.module.js';
import { StoragePoolsModule } from './storage-pools/storage-pools.module.js';
import { SystemSettingsModule } from './system-settings/system-settings.module.js';
import { UsersModule } from './users/users.module.js';
import { VolumesModule } from './volumes/volumes.module.js';

@Module({
  imports: [
    PlatformModule,
    IamModule,
    RuntimeModule,
    MetricsModule,
    AccessModule,
    AuditModule,
    ContainersModule,
    GpuModule,
    GroupsModule,
    HttpProxyModule,
    ImagesModule,
    IpPoolsModule,
    ServersModule,
    SharedBackendsModule,
    SshModule,
    StoragePoolsModule,
    SystemSettingsModule,
    UsersModule,
    VolumesModule,
  ],
  controllers: [HealthController],
  providers: [RuntimeLifecycleService],
})
export class AppModule {}
