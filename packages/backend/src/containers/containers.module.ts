import { Module } from '@nestjs/common';
import { GpuModule } from '../gpu/gpu.module.js';
import { IncusModule } from '../incus/incus.module.js';
import { IpPoolsModule } from '../ip-pools/ip-pools.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { VolumesModule } from '../volumes/volumes.module.js';
import { ConsoleBridgeGateway } from './console-bridge.gateway.js';
import { ConsoleSessionService } from './console-session.service.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import { ContainerControlRepository } from './container-control.repository.js';
import { ContainerControlService } from './container-control.service.js';
import { ContainerReconciler } from './container-reconciler.service.js';
import { ContainerSshConvergenceService } from './container-ssh-convergence.service.js';
import { IncusContainerSshStateAdapter } from './container-ssh-state.adapter.js';
import { ContainersController } from './containers.controller.js';
import { IncusConsoleBridgeAdapter } from './incus-console-bridge.adapter.js';

@Module({
  imports: [
    ReconcileModule,
    IncusModule,
    IpPoolsModule,
    VolumesModule,
    GpuModule,
    ProxySnapshotNotifierModule,
  ],
  providers: [
    ContainerActionPolicyService,
    ContainerControlService,
    ContainerControlRepository,
    ContainerSshConvergenceService,
    ContainerReconciler,
    IncusContainerSshStateAdapter,
    ConsoleSessionService,
    ConsoleBridgeGateway,
    IncusConsoleBridgeAdapter,
  ],
  controllers: [
    ContainersController,
  ],
  exports: [
    ContainerActionPolicyService,
    ContainerControlService,
    ContainerControlRepository,
    ContainerSshConvergenceService,
    ConsoleBridgeGateway,
  ],
})
export class ContainersModule {}
