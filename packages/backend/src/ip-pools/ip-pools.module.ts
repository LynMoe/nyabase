import { Module } from '@nestjs/common';
import { AdminIpPoolsController } from './ip-pools.controller.js';
import { IpPoolsRepository } from './ip-pools.repository.js';
import { IpPoolsService } from './ip-pools.service.js';

@Module({
  providers: [IpPoolsRepository, IpPoolsService],
  controllers: [AdminIpPoolsController],
  exports: [IpPoolsRepository, IpPoolsService],
})
export class IpPoolsModule {}
