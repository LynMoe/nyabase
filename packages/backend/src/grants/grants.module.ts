import { Module } from '@nestjs/common';
import { GpuModule } from '../gpu/gpu.module.js';
import { IncusModule } from '../incus/incus.module.js';
import { GrantBundlesController } from './grant-bundles.controller.js';
import { GrantBundlesService } from './grant-bundles.service.js';
import { GrantServerProfileService } from './grant-server-profile.js';
import { GrantsService } from './grants.service.js';
import { MeAccessController } from './me-access.controller.js';
import { UserGrantsController } from './user-grants.controller.js';

@Module({
  imports: [GpuModule, IncusModule],
  providers: [GrantBundlesService, GrantServerProfileService, GrantsService],
  controllers: [GrantBundlesController, UserGrantsController, MeAccessController],
  exports: [GrantsService],
})
export class GrantsModule {}
