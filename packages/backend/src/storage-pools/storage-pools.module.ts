import { Module } from '@nestjs/common';
import { IncusModule } from '../incus/incus.module.js';
import {
  AdminStoragePoolsController,
  StoragePoolsController,
} from './storage-pools.controller.js';
import { StoragePoolsRepository } from './storage-pools.repository.js';
import { StoragePoolsService } from './storage-pools.service.js';

@Module({
  imports: [IncusModule],
  providers: [StoragePoolsRepository, StoragePoolsService],
  controllers: [
    StoragePoolsController,
    AdminStoragePoolsController,
  ],
  exports: [StoragePoolsRepository, StoragePoolsService],
})
export class StoragePoolsModule {}
