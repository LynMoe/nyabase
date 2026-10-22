import { Module } from '@nestjs/common';
import { GpuModule } from '../gpu/gpu.module.js';
import { IncusModule } from '../incus/incus.module.js';
import { CpuModule } from '../cpu/cpu.module.js';
import { IpPoolsModule } from '../ip-pools/ip-pools.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { VolumesModule } from '../volumes/volumes.module.js';
import { ConsoleBridgeGateway } from './console-bridge.gateway.js';
import { ConsoleSessionService } from './console-session.service.js';
import { ContainerControlRepository } from './container-control.repository.js';
import { ContainerCreateService } from './container-create.service.js';
import { ContainerDtoAssembler } from './container-dtos.js';
import { ContainerReconcileStore } from './container-reconcile.store.js';
import { ContainerControlService } from './container-control.service.js';
import { ContainerReconciler } from './container-reconciler.service.js';
import { ContainerSshConvergenceService, IncusContainerSshStateAdapter } from './container-ssh.js';
import { ContainersController } from './containers.controller.js';

@Module({
  imports: [
    ReconcileModule,
    IncusModule,
    CpuModule,
    IpPoolsModule,
    VolumesModule,
    GpuModule,
    ProxySnapshotNotifierModule,
  ],
  providers: [
    ContainerControlService,
    ContainerControlRepository,
    ContainerSshConvergenceService,
    ContainerCreateService,
    ContainerDtoAssembler,
    ContainerReconcileStore,
    ContainerReconciler,
    IncusContainerSshStateAdapter,
    ConsoleSessionService,
    ConsoleBridgeGateway,
  ],
  controllers: [
    ContainersController,
  ],
  exports: [
    ContainerControlService,
    ContainerControlRepository,
    ContainerSshConvergenceService,
    ConsoleBridgeGateway,
  ],
})
export class ContainersModule {}
