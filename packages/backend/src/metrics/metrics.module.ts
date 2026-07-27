import { Module, forwardRef } from '@nestjs/common';
import { MetricsWriter } from './metrics-writer.js';
import { MetricsController } from './metrics.controller.js';
import { AdminMetricsController } from './admin-metrics.controller.js';
import { MetricsQueryService } from './metrics-query.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminRuntimeMetricsController } from './admin-runtime-metrics.controller.js';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
    forwardRef(() => AgentGatewayModule),
    forwardRef(() => UsersModule),
  ],
  providers: [MetricsWriter, MetricsQueryService],
  controllers: [MetricsController, AdminMetricsController, AdminRuntimeMetricsController],
  exports: [MetricsWriter],
})
export class MetricsModule {}
