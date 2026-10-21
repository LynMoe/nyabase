import { Module } from '@nestjs/common';
import { IncusModule } from '../incus/incus.module.js';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { StoragePoolsModule } from '../storage-pools/storage-pools.module.js';
import {
  AdminContainerSharedVolumesController,
  AdminSharedBackendCatalogInspectController,
  AdminSharedVolumesController,
  ContainerSharedVolumesController,
  SharedVolumesController,
} from './shared-volumes.controller.js';
import {
  AdminSharedVolumeIntentsController,
  AdminVolumeIntentsController,
  SharedVolumeIntentsController,
  VolumeIntentsController,
} from './volume-intents.controller.js';
import { VolumeReconciler } from './volume-reconciler.service.js';
import {
  AdminVolumesController,
  AdminContainerVolumesController,
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
    AdminContainerVolumesController,
    AdminContainerSharedVolumesController,
    AdminVolumesController,
    AdminSharedVolumesController,
    AdminSharedBackendCatalogInspectController,
    StorageCapacityController,
    VolumeIntentsController,
    SharedVolumeIntentsController,
    AdminVolumeIntentsController,
    AdminSharedVolumeIntentsController,
  ],
  exports: [VolumesRepository, VolumesService],
})
export class VolumesModule {}
