import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { AccessModule } from '../access/access.module.js';
import { SystemSettingsController } from './system-settings.controller.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [
    AccessModule,
    AuthModule,
    forwardRef(() => SshModule),
    AuditModule,
  ],
  controllers: [SystemSettingsController],
})
export class SystemSettingsModule {}
