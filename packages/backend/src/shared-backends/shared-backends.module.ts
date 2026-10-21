import { Module } from '@nestjs/common';
import {
  SharedBackendsController,
} from './shared-backends.controller.js';
import { SharedBackendsRepository } from './shared-backends.repository.js';
import { SharedBackendsService } from './shared-backends.service.js';
import { StoragePoolsModule } from '../storage-pools/storage-pools.module.js';

@Module({
  imports: [StoragePoolsModule],
  providers: [SharedBackendsRepository, SharedBackendsService],
  controllers: [SharedBackendsController],
  exports: [SharedBackendsRepository, SharedBackendsService],
})
export class SharedBackendsModule {}
