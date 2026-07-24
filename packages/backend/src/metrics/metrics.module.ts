import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MetricsWriter } from './metrics-writer.js';
import { MetricsController } from './metrics.controller.js';
import { AdminMetricsController } from './admin-metrics.controller.js';
import { MetricsQueryService } from './metrics-query.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { UsersModule } from '../users/users.module.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ContainerEntity]),
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
    // forwardRef breaks the AgentGateway → Users → Groups → AgentGateway →
    // Metrics → Users module-evaluation cycle (UsersModule is still being
    // defined when this file is loaded transitively).
    forwardRef(() => UsersModule),
    forwardRef(() => AgentGatewayModule),
  ],
  providers: [MetricsWriter, MetricsQueryService],
  controllers: [MetricsController, AdminMetricsController],
  exports: [MetricsWriter],
})
export class MetricsModule {}
