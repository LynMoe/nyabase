import { Module } from '@nestjs/common';
import { GpuModule } from '../gpu/gpu.module.js';
import { IncusModule } from '../incus/incus.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { StoragePoolsModule } from '../storage-pools/storage-pools.module.js';
import { UsersModule } from '../users/users.module.js';
import { VolumesModule } from '../volumes/volumes.module.js';
import { IncusPreflightChecksAdapter } from './preflight-checks.adapter.js';
import { ServerConnectIntentService } from './server-connect-intent.service.js';
import { ServerHealthService } from './server-health.service.js';
import { ServerPreflightIntentService } from './server-preflight-intent.service.js';
import { ServerPreflightReconciler } from './server-preflight-reconciler.service.js';
import { ServersController } from './servers.controller.js';
import { ServersService } from './servers.service.js';

@Module({
  imports: [
    ReconcileModule,
    IncusModule,
    ProxySnapshotNotifierModule,
    UsersModule,
    SshModule,
    StoragePoolsModule,
    VolumesModule,
    GpuModule,
    MetricsModule,
  ],
  providers: [
    ServersService,
    ServerPreflightReconciler,
    ServerHealthService,
    IncusPreflightChecksAdapter,
    ServerConnectIntentService,
    ServerPreflightIntentService,
  ],
  controllers: [ServersController],
  exports: [ServersService],
})
export class ServersModule {}
