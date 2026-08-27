import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { StoragePoolsModule } from '../storage-pools/storage-pools.module.js';
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
    AuthModule,
    AccessModule,
    AuditModule,
    DatabaseModule,
    RuntimeModule,
    StoragePoolsModule,
  ],
  providers: [VolumesRepository, VolumesService],
  controllers: [
    VolumesController,
    ContainerVolumesController,
    AdminContainerVolumesController,
    AdminVolumesController,
    StorageCapacityController,
  ],
  exports: [VolumesRepository, VolumesService],
})
export class VolumesModule {}
