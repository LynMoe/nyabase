import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuditAction, Capability } from '@nyabase/common';
import { RequireAnyCaps, RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { postCommitBestEffort } from '../common/post-commit.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { SshProxyGateway } from './ssh-proxy-gateway.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserEntity } from '../entities/user.entity.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';

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
    private audit: AuditService,
    private accessResolver: AccessResolverService,
  ) {}

  @Get('status')
  @RequireAnyCaps(
    Capability.ViewMetricsAll,
    Capability.ViewAudit,
    Capability.ManageSystemSettings,
  )
  async status(@CurrentUser() actor: UserEntity) {
    const capabilities = await this.accessResolver.userCapabilitiesCurrent(actor.id);
    if (![
      Capability.ViewMetricsAll,
      Capability.ViewAudit,
      Capability.ManageSystemSettings,
    ].some((capability) => capabilities.has(capability))) {
      throw new ForbiddenException('SSH proxy status access was revoked');
    }
    const status = this.sshProxyGateway.getStatus();
    if (
      capabilities.has(Capability.ViewAudit)
      || capabilities.has(Capability.ManageSystemSettings)
    ) {
      return status;
    }
    // ViewMetricsAll is intentionally limited to aggregate/proxy-health
    // telemetry. Connection identity, peer, user, container and runtime
    // evidence belongs to audit/system-administration purposes.
    return {
      ...status,
      proxies: status.proxies.map((proxy) => ({ ...proxy, connections: [] })),
    };
  }

  @Post('disconnect-all')
  @HttpCode(200)
  @RequireCaps(Capability.ManageSystemSettings)
  async disconnectAll(@CurrentUser() actor: UserEntity) {
    const started = await this.accessResolver.startExternalWithActorCapabilities(
      actor.id,
      [Capability.ManageSystemSettings],
      () => this.sshProxyGateway.disconnectAll(),
    );
    const result = await started.completion;
    await postCommitBestEffort(
      'SSH proxy disconnect-all audit',
      () => this.audit.log(
        actor.id,
        AuditAction.DisconnectSshProxySessions,
        result.requestId,
        'ssh_proxy',
        { requested: result.requested, disconnected: result.disconnected },
      ),
    );
    return result;
  }

  @Get('host-key')
  @RequireCaps(Capability.ManageSystemSettings)
  async hostKey(@CurrentUser() actor: UserEntity): Promise<SshProxyHostKeySummaryDto> {
    return this.hostKeyDto(actor.id);
  }

  @Post('host-key/rotate')
  @HttpCode(200)
  @RequireCaps(Capability.ManageSystemSettings)
  async rotateHostKey(@CurrentUser() actor: UserEntity): Promise<SshProxyHostKeySummaryDto> {
    const rotated = await this.sshIdentities.rotateProxyHostKey(
      async (manager) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          manager, actor.id, [Capability.ManageSystemSettings],
        );
      },
    );
    await postCommitBestEffort(
      'SSH proxy host-key snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
    );
    const result = {
      fingerprint: rotated.fingerprint,
      generation: rotated.generation,
      rotatedAt: rotated.rotatedAt.toISOString(),
    };
    await postCommitBestEffort(
      'SSH proxy host-key rotation audit',
      () => this.audit.log(actor.id, AuditAction.RotateSshProxyHostKey, 'host-key', 'ssh_proxy', {
        fingerprint: result.fingerprint,
        generation: result.generation,
      }),
    );
    return result;
  }

  private async hostKeyDto(actorId: string): Promise<SshProxyHostKeySummaryDto> {
    const hostKey = await this.sshIdentities.getProxyHostKeySummary(
      async (manager) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          manager, actorId, [Capability.ManageSystemSettings],
        );
      },
    );
    return {
      fingerprint: hostKey.fingerprint,
      generation: hostKey.generation,
      rotatedAt: hostKey.rotatedAt.toISOString(),
    };
  }
}
