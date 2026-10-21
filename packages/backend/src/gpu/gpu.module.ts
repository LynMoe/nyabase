import { Module } from '@nestjs/common';
import { IncusModule } from '../incus/incus.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { GpuClaimsRepository } from './gpu-claims.repository.js';
import { AdminGpuController, UserGpuController } from './gpu.controller.js';
import { GpuService } from './gpu.service.js';

@Module({
  imports: [IncusModule, MetricsModule],
  controllers: [AdminGpuController, UserGpuController],
  providers: [GpuClaimsRepository, GpuService],
  exports: [GpuClaimsRepository, GpuService],
})
export class GpuModule {}
