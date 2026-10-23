import { Module } from '@nestjs/common';
import { ContainersModule } from '../containers/containers.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { SystemSettingsController } from './system-settings.controller.js';
import { SystemSettingsAuthorityService } from './system-settings-authority.service.js';

@Module({
  imports: [
    ContainersModule,
    SshModule,
  ],
  providers: [SystemSettingsAuthorityService],
  controllers: [SystemSettingsController],
  exports: [SystemSettingsAuthorityService],
})
export class SystemSettingsModule {}
