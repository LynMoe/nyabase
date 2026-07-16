import { Module } from '@nestjs/common';
import { ProxySnapshotNotifierService } from './proxy-snapshot-notifier.service.js';

@Module({
  providers: [ProxySnapshotNotifierService],
  exports: [ProxySnapshotNotifierService],
})
export class ProxySnapshotNotifierModule {}
