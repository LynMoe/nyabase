import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import {
  AdminStoragePoolsController,
  StoragePoolsController,
} from './storage-pools.controller.js';
import { StoragePoolsRepository } from './storage-pools.repository.js';
import { StoragePoolsService } from './storage-pools.service.js';

@Module({
  imports: [AuthModule, AccessModule, DatabaseModule, RuntimeModule],
  providers: [StoragePoolsRepository, StoragePoolsService],
  controllers: [
    StoragePoolsController,
    AdminStoragePoolsController,
  ],
  exports: [StoragePoolsRepository, StoragePoolsService],
})
export class StoragePoolsModule {}
