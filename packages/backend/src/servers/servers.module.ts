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
import { ServerPreflightIntentService } from './server-intents.service.js';
import { AdminAgentRejectionsController } from './admin-agent-rejections.controller.js';
import { AgentEnrollController } from './agent-enroll.controller.js';
import { AgentEnrollmentService } from './agent-enrollment.service.js';
import { AgentPresenceService } from './agent-presence.service.js';
import { ServerConnector } from './server-connector.js';
import { ServerPreflightStore } from './server-preflight.store.js';
import { ServerHealthService } from './server-health.service.js';
import { ServerRecoveryService } from './server-recovery.service.js';
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
    ServerPreflightStore,
    ServerConnector,
    ServerHealthService,
    ServerRecoveryService,
    IncusPreflightChecksAdapter,
    ServerPreflightIntentService,
    AgentEnrollmentService,
    AgentPresenceService,
  ],
  controllers: [ServersController, AgentEnrollController, AdminAgentRejectionsController],
  exports: [ServersService],
})
export class ServersModule {}
