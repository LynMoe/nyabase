import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { AccessModule } from '../access/access.module.js';
import { SystemSettingsController } from './system-settings.controller.js';

@Module({
  imports: [
    AccessModule,
    AuthModule,
    forwardRef(() => SshModule),
  ],
  controllers: [SystemSettingsController],
})
export class SystemSettingsModule {}
