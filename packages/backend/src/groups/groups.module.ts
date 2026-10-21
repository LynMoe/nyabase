import { Module } from '@nestjs/common';
import { GpuModule } from '../gpu/gpu.module.js';
import { GroupsService } from './groups.service.js';
import { GroupsController } from './groups.controller.js';
import { UserGrantsController } from './user-grants.controller.js';
import { MeAccessController } from './me-access.controller.js';

@Module({
  imports: [GpuModule],
  providers: [GroupsService],
  controllers: [GroupsController, UserGrantsController, MeAccessController],
  exports: [GroupsService],
})
export class GroupsModule {}
