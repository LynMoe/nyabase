import { Module } from '@nestjs/common';
import { GpuModule } from '../gpu/gpu.module.js';
import { IncusModule } from '../incus/incus.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { StoragePoolsModule } from '../storage-pools/storage-pools.module.js';
import { UsersModule } from '../users/users.module.js';
import { VolumesModule } from '../volumes/volumes.module.js';
import { AdminIncusClientCertificateController } from './admin-incus-client-certificate.controller.js';
import { CertificateAutoRotationWorker } from './certificate-auto-rotation.worker.js';
import { CertificateRotationReconciler } from './certificate-rotation-reconciler.service.js';
import { IncusClientCertificateService } from './incus-client-certificate.service.js';
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
    InfrastructureModule,
    GpuModule,
    MetricsModule,
  ],
  providers: [
    ServersService,
    IncusClientCertificateService,
    CertificateAutoRotationWorker,
    CertificateRotationReconciler,
    ServerPreflightReconciler,
    ServerHealthService,
    IncusPreflightChecksAdapter,
    ServerConnectIntentService,
    ServerPreflightIntentService,
  ],
  controllers: [
    ServersController,
    AdminIncusClientCertificateController,
  ],
  exports: [ServersService],
})
export class ServersModule {}
