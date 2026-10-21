import { Module } from '@nestjs/common';
import { IncusModule } from '../incus/incus.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { SystemSettingsController } from './system-settings.controller.js';
import { SystemSettingsAuthorityService } from './system-settings-authority.service.js';

@Module({
  imports: [
    IncusModule,
    SshModule,
  ],
  providers: [SystemSettingsAuthorityService],
  controllers: [SystemSettingsController],
  exports: [SystemSettingsAuthorityService],
})
export class SystemSettingsModule {}
