import { Module } from '@nestjs/common';
import { MetricsWriter } from './metrics-writer.js';
import { AdminRuntimeMetricsController } from './admin-runtime-metrics.controller.js';
import { AdminPerformanceController } from './admin-performance.controller.js';
import { ContainerStateMetricsPublisher } from './container-state-metrics.service.js';
import { PerformanceController } from './performance.controller.js';
import { PerformanceQueryService } from './performance-query.service.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { StoragePoolsModule } from '../storage-pools/storage-pools.module.js';
import { NodeMetricsScrapeService } from './node-metrics-scrape.service.js';

@Module({
  imports: [
    RuntimeModule,
    StoragePoolsModule,
  ],
  providers: [
    MetricsWriter,
    NodeMetricsScrapeService,
    ContainerStateMetricsPublisher,
    PerformanceQueryService,
  ],
  controllers: [
    AdminRuntimeMetricsController,
    PerformanceController,
    AdminPerformanceController,
  ],
  exports: [MetricsWriter, NodeMetricsScrapeService],
})
export class MetricsModule {}
