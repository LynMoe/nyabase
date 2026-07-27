import { Global, Module } from '@nestjs/common';
import { NyabaseConfigService } from './nyabase-config.service.js';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';

@Global()
@Module({
  providers: [NyabaseConfigService, RuntimeRoleService],
  exports: [NyabaseConfigService, RuntimeRoleService],
})
export class NyabaseConfigModule {}
