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
import { DataDiskRuntimeObservationEntity } from '../entities/data-disk-runtime-observation.entity.js';
import { RuntimeContainerEntity } from '../entities/runtime-container.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ContainerEntity, RuntimeContainerEntity, DataDiskRuntimeObservationEntity]),
    AuthModule,
    AccessModule,
    // forwardRef breaks the AgentGateway → Users → Groups → AgentGateway →
    // Metrics → Users module-evaluation cycle (UsersModule is still being
    // defined when this file is loaded transitively).
    forwardRef(() => UsersModule),
  ],
  providers: [MetricsWriter, MetricsQueryService],
  controllers: [MetricsController, AdminMetricsController],
  exports: [MetricsWriter],
})
export class MetricsModule {}
