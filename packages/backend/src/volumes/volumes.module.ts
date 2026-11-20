import { Module } from '@nestjs/common';
import { IncusModule } from '../incus/incus.module.js';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { StoragePoolsModule } from '../storage-pools/storage-pools.module.js';
import { VolumeReconciler } from './volume-reconciler.service.js';
import {
  SharedBackendCatalogInspectController,
  SharedVolumesController,
  StorageCapacityController,
  StorageMountPreviewController,
  VolumesController,
} from './volumes.controller.js';
import { StorageBalancer } from './storage-balancer.service.js';
import { VolumeProvisioner } from './volume-provisioner.service.js';
import { VolumesRepository } from './volumes.repository.js';
import { VolumesService } from './volumes.service.js';
import { SharedVolumeCatalogInspectService } from './shared-volume-catalog.service.js';
import { VolumeAttachmentsService } from './volume-attachments.service.js';
import { VolumeDtoAssembler } from './volume-dtos.js';
import { VolumeReconcileStore } from './volume-reconcile.store.js';

@Module({
  imports: [ReconcileModule, IncusModule, StoragePoolsModule],
  providers: [
    VolumesRepository,
    VolumesService,
    VolumeAttachmentsService,
    SharedVolumeCatalogInspectService,
    VolumeDtoAssembler,
    VolumeReconcileStore,
    VolumeReconciler,
    VolumeProvisioner,
    StorageBalancer,
  ],
  controllers: [
    VolumesController,
    SharedVolumesController,
    SharedBackendCatalogInspectController,
    StorageCapacityController,
    StorageMountPreviewController,
  ],
  exports: [VolumesRepository, VolumeAttachmentsService, VolumeProvisioner],
})
export class VolumesModule {}
