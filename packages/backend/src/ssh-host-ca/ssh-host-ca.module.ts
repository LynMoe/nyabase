import { Module } from '@nestjs/common';
import { SshHostCaService } from './ssh-host-ca.service.js';

/** Per-user SSH host certificate authorities; depends on platform only. */
@Module({
  providers: [SshHostCaService],
  exports: [SshHostCaService],
})
export class SshHostCaModule {}
