import { Global, Module } from '@nestjs/common';
import { NyabaseConfigService } from './nyabase-config.service.js';

@Global()
@Module({
  providers: [NyabaseConfigService],
  exports: [NyabaseConfigService],
})
export class NyabaseConfigModule {}
