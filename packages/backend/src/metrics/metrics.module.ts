import { Module } from '@nestjs/common';
import { IncusModule } from '../incus/incus.module.js';
import { StoragePoolsModule } from '../storage-pools/storage-pools.module.js';
import { AdminRuntimeMetricsController } from './admin-runtime-metrics.controller.js';
import { ContainerStateMetricsPublisher } from './container-state-metrics.service.js';
import { MetricsWriter } from './metrics-writer.js';
import { AgentNodeMetricsPullAdapter } from './node-metrics-pull.adapter.js';
import { NodeMetricsScrapeService } from './node-metrics-scrape.service.js';
import { PerformanceController } from './performance.controller.js';
import { PerformanceQueryService } from './performance-query.service.js';

@Module({
  imports: [IncusModule, StoragePoolsModule],
  providers: [
    MetricsWriter,
    AgentNodeMetricsPullAdapter,
    NodeMetricsScrapeService,
    ContainerStateMetricsPublisher,
    PerformanceQueryService,
  ],
  controllers: [
    AdminRuntimeMetricsController,
    PerformanceController,
  ],
  exports: [MetricsWriter, NodeMetricsScrapeService, AgentNodeMetricsPullAdapter],
})
export class MetricsModule {}
