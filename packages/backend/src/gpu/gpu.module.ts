import { forwardRef, Global, Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { GpuClaimsRepository } from './gpu-claims.repository.js';
import { AdminGpuController, UserGpuController } from './gpu.controller.js';
import { GpuService } from './gpu.service.js';

@Global()
@Module({
  imports: [AuthModule, AccessModule, AuditModule, forwardRef(() => RuntimeModule)],
  controllers: [AdminGpuController, UserGpuController],
  providers: [GpuClaimsRepository, GpuService],
  exports: [GpuClaimsRepository, GpuService],
})
export class GpuModule {}
