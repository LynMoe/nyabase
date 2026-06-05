import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { OperationsModule } from '../operations/operations.module.js';
import { QuotaDispatchService } from './quota-dispatch.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([QuotaDesiredEntity]), forwardRef(() => OperationsModule)],
  providers: [QuotaDispatchService],
  exports: [QuotaDispatchService],
})
export class QuotaModule {}
