import { Module } from '@nestjs/common';
import { SshModule } from '../ssh/ssh.module.js';
import { SystemSettingsController } from './system-settings.controller.js';
import { SystemSettingsAuthorityService } from './system-settings-authority.service.js';

@Module({
  imports: [
    SshModule,
  ],
  providers: [SystemSettingsAuthorityService],
  controllers: [SystemSettingsController],
  exports: [SystemSettingsAuthorityService],
})
export class SystemSettingsModule {}
