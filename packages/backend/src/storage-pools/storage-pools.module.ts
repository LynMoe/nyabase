import { Module } from '@nestjs/common';
import { IncusModule } from '../incus/incus.module.js';
import {
  StoragePoolsController,
} from './storage-pools.controller.js';
import { StoragePoolsRepository } from './storage-pools.repository.js';
import { SharedBackendExecutorsService } from './shared-backend-executors.service.js';
import { StoragePoolDiscoveryService } from './storage-pool-discovery.service.js';
import { StoragePoolsService } from './storage-pools.service.js';
import { DiskChangeNotifier } from './disk-mounts.js';

@Module({
  imports: [IncusModule],
  providers: [
    DiskChangeNotifier,
    StoragePoolsRepository,
    StoragePoolDiscoveryService,
    StoragePoolsService,
    SharedBackendExecutorsService,
  ],
  controllers: [
    StoragePoolsController,
  ],
  exports: [DiskChangeNotifier, StoragePoolsRepository, StoragePoolsService, SharedBackendExecutorsService],
})
export class StoragePoolsModule {}
