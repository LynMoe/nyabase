import {
  Controller,
  Get,
  HttpCode,
  Post,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuditAction, Role } from '@nyabase/common';
import { RequireRole, CurrentUser } from '../iam/decorators.js';
import { postCommitBestEffort } from '../platform/post-commit.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { SshProxyGateway } from './ssh-proxy-gateway.js';
import type { UserRecord } from '../iam/auth-persistence.js';
import { AuditService } from '../iam/audit.service.js';
import { assertActorRole } from '../iam/administration.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';

interface SshProxyHostKeySummaryDto {
  fingerprint: string | null;
  generation: number | null;
  rotatedAt: string | null;
}

@Controller('admin/ssh-proxy')
export class AdminSshProxyController {
  constructor(
    private sshProxyGateway: SshProxyGateway,
    private sshIdentities: SshIdentityService,
    private audit: AuditService,
    private accessResolver: AccessResolverService,
  ) {}

  @Get('status')
  @RequireRole(Role.Operator)
  status() {
    return this.sshProxyGateway.getStatus();
  }

  @Post('disconnect-all')
  @HttpCode(200)
  @RequireRole(Role.Operator)
  async disconnectAll(@CurrentUser() actor: UserRecord) {
    const requestId = randomBytes(12).toString('hex');
    await this.accessResolver.runWithActorRole(
      actor.id,
      Role.Operator,
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
  @RequireRole(Role.Operator)
  async hostKey(@CurrentUser() actor: UserRecord): Promise<SshProxyHostKeySummaryDto> {
    return this.hostKeyDto(actor.id);
  }

  @Post('host-key/rotate')
  @HttpCode(200)
  @RequireRole(Role.Operator)
  async rotateHostKey(@CurrentUser() actor: UserRecord): Promise<SshProxyHostKeySummaryDto> {
    const rotated = await this.sshIdentities.rotateProxyHostKey(
      async (manager) => {
        await assertActorRole(manager, actor.id, Role.Operator);
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
        await assertActorRole(manager, actorId, Role.Operator);
      },
    );
    return {
      fingerprint: hostKey.fingerprint,
      generation: hostKey.generation,
      rotatedAt: hostKey.rotatedAt.toISOString(),
    };
  }
}
