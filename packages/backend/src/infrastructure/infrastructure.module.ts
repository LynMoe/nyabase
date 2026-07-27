import { Module } from '@nestjs/common';
import { InfrastructureRepository } from './infrastructure.repository.js';

@Module({
  providers: [InfrastructureRepository],
  exports: [InfrastructureRepository],
})
export class InfrastructureModule {}
