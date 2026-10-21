import { Global, Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { GpuClaimsRepository } from './gpu-claims.repository.js';
import { AdminGpuController, UserGpuController } from './gpu.controller.js';
import { GpuService } from './gpu.service.js';

@Global()
@Module({
  imports: [RuntimeModule],
  controllers: [AdminGpuController, UserGpuController],
  providers: [GpuClaimsRepository, GpuService],
  exports: [GpuClaimsRepository, GpuService],
})
export class GpuModule {}
