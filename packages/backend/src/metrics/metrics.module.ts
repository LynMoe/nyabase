import { Module, forwardRef } from '@nestjs/common';
import { MetricsWriter } from './metrics-writer.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AdminRuntimeMetricsController } from './admin-runtime-metrics.controller.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { NodeMetricsScrapeService } from './node-metrics-scrape.service.js';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    AccessModule,
    RuntimeModule,
  ],
  providers: [MetricsWriter, NodeMetricsScrapeService],
  controllers: [AdminRuntimeMetricsController],
  exports: [MetricsWriter, NodeMetricsScrapeService],
})
export class MetricsModule {}
