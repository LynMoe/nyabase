import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { StoragePoolsModule } from '../storage-pools/storage-pools.module.js';
import {
  AdminContainerSharedVolumesController,
  AdminSharedBackendCatalogInspectController,
  AdminSharedVolumesController,
  ContainerSharedVolumesController,
  SharedVolumesController,
} from './shared-volumes.controller.js';
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
  imports: [
    RuntimeModule,
    StoragePoolsModule,
  ],
  providers: [VolumesRepository, VolumesService],
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
  ],
  exports: [VolumesRepository, VolumesService],
})
export class VolumesModule {}
