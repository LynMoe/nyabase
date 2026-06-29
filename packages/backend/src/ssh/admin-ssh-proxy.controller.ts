import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { SshProxyGateway } from './ssh-proxy-gateway.js';

interface SshProxyHostKeySummaryDto {
  fingerprint: string | null;
  generation: number | null;
  rotatedAt: string | null;
}

@Controller('admin/ssh-proxy')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminSshProxyController {
  constructor(
    private sshProxyGateway: SshProxyGateway,
    private sshIdentities: SshIdentityService,
  ) {}

  @Get('status')
  @RequireCaps(Capability.ViewMetricsAll)
  status() {
    return this.sshProxyGateway.getStatus();
  }

  @Post('disconnect-all')
  @HttpCode(200)
  @RequireCaps(Capability.ManageSystemSettings)
  disconnectAll() {
    return this.sshProxyGateway.disconnectAll();
  }

  @Get('host-key')
  @RequireCaps(Capability.ManageSystemSettings)
  async hostKey(): Promise<SshProxyHostKeySummaryDto> {
    return this.hostKeyDto();
  }

  @Post('host-key/rotate')
  @HttpCode(200)
  @RequireCaps(Capability.ManageSystemSettings)
  async rotateHostKey(): Promise<SshProxyHostKeySummaryDto> {
    await this.sshIdentities.rotateProxyHostKey();
    await this.sshProxyGateway.broadcastSnapshot();
    return this.hostKeyDto();
  }

  private async hostKeyDto(): Promise<SshProxyHostKeySummaryDto> {
    const hostKey = await this.sshIdentities.getProxyHostKeySummary();
    return {
      fingerprint: hostKey.fingerprint,
      generation: hostKey.generation,
      rotatedAt: hostKey.rotatedAt.toISOString(),
    };
  }
}
