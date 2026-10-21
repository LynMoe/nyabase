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
import { LocalVolumesService } from './local-volumes.service.js';
import { SharedVolumeCatalogInspectService } from './shared-volume-catalog.service.js';
import { SharedVolumesService } from './shared-volumes.service.js';
import { VolumeAttachmentsService } from './volume-attachments.service.js';
import { VolumeCapacityService } from './volume-capacity.service.js';
import { VolumeDtoAssembler } from './volume-dtos.js';
import { VolumeLifecycleService } from './volume-lifecycle.service.js';
import { VolumeReconcileStore } from './volume-reconcile.store.js';

@Module({
  imports: [ReconcileModule, IncusModule, StoragePoolsModule],
  providers: [
    VolumesRepository,
    LocalVolumesService,
    SharedVolumesService,
    VolumeAttachmentsService,
    SharedVolumeCatalogInspectService,
    VolumeDtoAssembler,
    VolumeCapacityService,
    VolumeLifecycleService,
    VolumeReconcileStore,
    VolumeReconciler,
  ],
  controllers: [
    VolumesController,
    SharedVolumesController,
    ContainerVolumesController,
    ContainerSharedVolumesController,
    SharedBackendCatalogInspectController,
    StorageCapacityController,
  ],
  exports: [VolumesRepository, VolumeAttachmentsService],
})
export class VolumesModule {}
