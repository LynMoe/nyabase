import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module.js';
import {
  AdminStoragePoolsController,
  StoragePoolsController,
} from './storage-pools.controller.js';
import { StoragePoolsRepository } from './storage-pools.repository.js';
import { StoragePoolsService } from './storage-pools.service.js';

@Module({
  imports: [RuntimeModule],
  providers: [StoragePoolsRepository, StoragePoolsService],
  controllers: [
    StoragePoolsController,
    AdminStoragePoolsController,
  ],
  exports: [StoragePoolsRepository, StoragePoolsService],
})
export class StoragePoolsModule {}
