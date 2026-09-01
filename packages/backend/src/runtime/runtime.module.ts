import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { RedisRuntimeModule } from './redis-runtime.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ContainerReconciler } from './container-reconciler.service.js';
import {
  IMAGE_ASSIGNMENT_SOURCE,
  ImageAssignmentReconciler,
  type ImageAssignmentSource,
} from './image-assignment-reconciler.service.js';
import { IntentRepository } from './intent.repository.js';
import { ReconcileClaimRepository } from './reconcile-claim.repository.js';
import { ReconcileWakeService, RECONCILE_WAKE } from './reconcile-wake.service.js';
import {
  PgResourceStatusRepository,
  ReconcileWorkerService,
  RECONCILER_REGISTRY,
  RESOURCE_STATUS,
} from './reconcile-worker.service.js';
import { ServerPreflightReconciler } from './server-preflight-reconciler.service.js';
import {
  NODE_METRICS_PULL,
  PREFLIGHT_CHECKS,
  SERVER_TRUST_TOKEN,
} from './server-preflight-reconciler.service.js';
import { VolumeReconciler } from './volume-reconciler.service.js';
import { DatabaseIncusClientFactory } from './incus-client.factory.js';
import { INCUS_CLIENT_FACTORY } from './reconcile-worker.service.js';
import { RedisDisposableAdapter } from './redis-disposable.adapter.js';
import { AuthenticatedNodeMetricsPullAdapter } from './node-metrics-pull.adapter.js';
import { IncusPreflightChecksAdapter } from './preflight-checks.adapter.js';
import { ServerConnectIntentService } from './server-connect-intent.service.js';
import { ServerPreflightIntentService } from './server-preflight-intent.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import {
  AdminContainerIntentsController,
  AdminIntentsController,
  AdminImageAssignmentIntentsController,
  AdminImageIntentsController,
  AdminServerIntentsController,
  AdminSharedVolumeIntentsController,
  AdminVolumeIntentsController,
  ContainerIntentsController,
  IntentsController,
  SharedVolumeIntentsController,
  VolumeIntentsController,
} from './intents.controller.js';
import { ConsoleSessionService } from './console-session.service.js';
import { ConsoleBridgeGateway } from './console-bridge.gateway.js';
import { IncusConsoleBridgeAdapter } from './incus-console-bridge.adapter.js';
import { CONSOLE_BRIDGE } from './console-bridge.port.js';
import { CertificateRotationReconciler } from './certificate-rotation-reconciler.service.js';
import { CertificateAutoRotationWorker } from './certificate-auto-rotation.worker.js';
import {
  CONTAINER_SSH_STATE,
  IncusContainerSshStateAdapter,
} from './container-ssh-state.adapter.js';

@Module({
  imports: [DatabaseModule, RedisRuntimeModule, AuthModule, AccessModule, ProxySnapshotNotifierModule, AuditModule],
  providers: [
    ReconcileWakeService,
    DatabaseIncusClientFactory,
    IncusConsoleBridgeAdapter,
    IncusContainerSshStateAdapter,
    ConsoleSessionService,
    ConsoleBridgeGateway,
    AuthenticatedNodeMetricsPullAdapter,
    IncusPreflightChecksAdapter,
    {
      provide: NODE_METRICS_PULL,
      useExisting: AuthenticatedNodeMetricsPullAdapter,
    },
    {
      provide: PREFLIGHT_CHECKS,
      useExisting: IncusPreflightChecksAdapter,
    },
    {
      provide: SERVER_TRUST_TOKEN,
      useExisting: RedisDisposableAdapter,
    },
    {
      provide: INCUS_CLIENT_FACTORY,
      useExisting: DatabaseIncusClientFactory,
    },
    {
      provide: CONSOLE_BRIDGE,
      useExisting: IncusConsoleBridgeAdapter,
    },
    {
      provide: CONTAINER_SSH_STATE,
      useExisting: IncusContainerSshStateAdapter,
    },
    {
      provide: IMAGE_ASSIGNMENT_SOURCE,
      inject: [NyabaseConfigService],
      useFactory: (config: NyabaseConfigService): ImageAssignmentSource => {
        const dedicated = config.get<string>('incus.imageSourceServer');
        return {
          alias: '',
          fingerprint: null,
          sourceServer: dedicated || config.get<string>('incus.preflightSourceServer'),
        };
      },
    },
    {
      provide: RECONCILE_WAKE,
      useExisting: ReconcileWakeService,
    },
    IntentRepository,
    ServerConnectIntentService,
    ServerPreflightIntentService,
    ReconcileClaimRepository,
    ContainerReconciler,
    VolumeReconciler,
    ImageAssignmentReconciler,
    ServerPreflightReconciler,
    CertificateRotationReconciler,
    CertificateAutoRotationWorker,
    PgResourceStatusRepository,
    {
      provide: RECONCILER_REGISTRY,
      inject: [
        ContainerReconciler,
        VolumeReconciler,
        ImageAssignmentReconciler,
        ServerPreflightReconciler,
        CertificateRotationReconciler,
      ],
      useFactory: (
        container: ContainerReconciler,
        volume: VolumeReconciler,
        image: ImageAssignmentReconciler,
        server: ServerPreflightReconciler,
        certificate: CertificateRotationReconciler,
      ) => [container, volume, image, server, certificate],
    },
    {
      provide: RESOURCE_STATUS,
      useExisting: PgResourceStatusRepository,
    },
    ReconcileWorkerService,
  ],
  controllers: [
    ContainerIntentsController,
    AdminContainerIntentsController,
    AdminIntentsController,
    AdminImageAssignmentIntentsController,
    AdminImageIntentsController,
    AdminServerIntentsController,
    IntentsController,
    VolumeIntentsController,
    SharedVolumeIntentsController,
    AdminVolumeIntentsController,
    AdminSharedVolumeIntentsController,
  ],
  exports: [
    INCUS_CLIENT_FACTORY,
    NODE_METRICS_PULL,
    IntentRepository,
    ReconcileClaimRepository,
    ServerConnectIntentService,
    ServerPreflightIntentService,
    ReconcileWakeService,
    ReconcileWorkerService,
    ConsoleSessionService,
    ConsoleBridgeGateway,
  ],
})
export class RuntimeModule {}
