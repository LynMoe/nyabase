import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuditAction, Capability } from '@nyabase/common';
import { RequireAnyCaps, RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { postCommitBestEffort } from '../common/post-commit.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { SshProxyGateway } from './ssh-proxy-gateway.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
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
  async status(@CurrentUser() actor: UserRecord) {
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
  async disconnectAll(@CurrentUser() actor: UserRecord) {
    const requestId = randomBytes(12).toString('hex');
    await this.accessResolver.runWithActorCapabilities(
      actor.id,
      [Capability.ManageSystemSettings],
      (transaction) => this.audit.append(
        transaction,
        actor.id,
        AuditAction.DisconnectSshProxySessions,
        requestId,
        'ssh_proxy',
        { intent: 'disconnect_all' },
      ),
    );
    return this.sshProxyGateway.disconnectAll('admin disconnect all', requestId);
  }

  @Get('host-key')
  @RequireCaps(Capability.ManageSystemSettings)
  async hostKey(@CurrentUser() actor: UserRecord): Promise<SshProxyHostKeySummaryDto> {
    return this.hostKeyDto(actor.id);
  }

  @Post('host-key/rotate')
  @HttpCode(200)
  @RequireCaps(Capability.ManageSystemSettings)
  async rotateHostKey(@CurrentUser() actor: UserRecord): Promise<SshProxyHostKeySummaryDto> {
    const rotated = await this.sshIdentities.rotateProxyHostKey(
      async (manager) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          manager, actor.id, [Capability.ManageSystemSettings],
        );
      },
      (transaction, key) => this.audit.append(
        transaction,
        actor.id,
        AuditAction.RotateSshProxyHostKey,
        'host-key',
        'ssh_proxy',
        {
          fingerprint: key.fingerprint,
          generation: key.generation,
        },
      ),
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
