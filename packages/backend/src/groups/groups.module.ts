import { Module } from '@nestjs/common';
import { GpuModule } from '../gpu/gpu.module.js';
import { GrantsService } from './grants.service.js';
import { GroupsController } from './groups.controller.js';
import { GroupsService } from './groups.service.js';
import { MeAccessController } from './me-access.controller.js';
import { UserGrantsController } from './user-grants.controller.js';

@Module({
  imports: [GpuModule],
  providers: [GroupsService, GrantsService],
  controllers: [GroupsController, UserGrantsController, MeAccessController],
  exports: [GroupsService, GrantsService],
})
export class GroupsModule {}
