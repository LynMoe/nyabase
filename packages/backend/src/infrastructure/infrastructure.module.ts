import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { InfrastructureRepository } from './infrastructure.repository.js';

@Module({
  imports: [DatabaseModule],
  providers: [InfrastructureRepository],
  exports: [InfrastructureRepository],
})
export class InfrastructureModule {}
