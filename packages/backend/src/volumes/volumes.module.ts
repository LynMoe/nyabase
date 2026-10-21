import { Module } from '@nestjs/common';
import { IncusModule } from '../incus/incus.module.js';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { StoragePoolsModule } from '../storage-pools/storage-pools.module.js';
import {
  ContainerSharedVolumesController,
  SharedBackendCatalogInspectController,
  SharedVolumesController,
} from './shared-volumes.controller.js';
import { VolumeReconciler } from './volume-reconciler.service.js';
import {
  ContainerVolumesController,
  StorageCapacityController,
  VolumesController,
} from './volumes.controller.js';
import { VolumesRepository } from './volumes.repository.js';
import { VolumesService } from './volumes.service.js';

@Module({
  imports: [ReconcileModule, IncusModule, StoragePoolsModule],
  providers: [VolumesRepository, VolumesService, VolumeReconciler],
  controllers: [
    VolumesController,
    SharedVolumesController,
    ContainerVolumesController,
    ContainerSharedVolumesController,
    SharedBackendCatalogInspectController,
    StorageCapacityController,
  ],
  exports: [VolumesRepository, VolumesService],
})
export class VolumesModule {}
