import { Module } from '@nestjs/common';
import { CpuSetService } from './cpu-sets.service.js';

@Module({
  providers: [CpuSetService],
  exports: [CpuSetService],
})
export class CpuModule {}
