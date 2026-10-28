import { Module } from '@nestjs/common';
import { GpuModule } from '../gpu/gpu.module.js';
import { GrantBundlesController } from './grant-bundles.controller.js';
import { GrantBundlesService } from './grant-bundles.service.js';
import { GrantsService } from './grants.service.js';
import { MeAccessController } from './me-access.controller.js';
import { UserGrantsController } from './user-grants.controller.js';

@Module({
  imports: [GpuModule],
  providers: [GrantBundlesService, GrantsService],
  controllers: [GrantBundlesController, UserGrantsController, MeAccessController],
  exports: [GrantsService],
})
export class GrantsModule {}
