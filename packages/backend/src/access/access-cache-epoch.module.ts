import { Module } from '@nestjs/common';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';

@Module({
  providers: [AccessCacheEpochService],
  exports: [AccessCacheEpochService],
})
export class AccessCacheEpochModule {}
