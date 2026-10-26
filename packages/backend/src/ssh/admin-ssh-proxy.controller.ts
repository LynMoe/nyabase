import {
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuditAction, Role, zSshProxyRefusalsQuery, type SshProxyRefusalsDto } from '@nyabase/common';
import { RequireRole, CurrentUser } from '../iam/decorators.js';
import { postCommitBestEffort } from '../platform/post-commit.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { SshProxyGateway } from './ssh-proxy-gateway.js';
import { SshSessionsService } from './ssh-sessions.service.js';
import type { UserRecord } from '../iam/auth-persistence.js';
import { AuditService } from '../iam/audit.service.js';
import { assertActorRole } from '../iam/administration.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { ContainerSshConvergenceService } from '../containers/container-ssh.js';
import { SshHostCaService } from '../ssh-host-ca/ssh-host-ca.service.js';

interface SshProxyHostKeySummaryDto {
  publicKey: string | null;
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
    private hostCa: SshHostCaService,
    private containerSsh: ContainerSshConvergenceService,
    private sessions: SshSessionsService,
  ) {}

  @Get('status')
  @RequireRole(Role.Admin)
  status() {
    return this.sshProxyGateway.getStatus();
  }

  /** Unauthenticated connections (refused keys, scanners, limits) summed per address and reason. */
  @Get('refusals')
  @RequireRole(Role.Admin)
  refusals(@Query() query: Record<string, unknown>): Promise<SshProxyRefusalsDto> {
    return this.sessions.refusals(zSshProxyRefusalsQuery.parse(query).hours);
  }

  @Post('disconnect-all')
  @HttpCode(200)
  @RequireRole(Role.Admin)
  async disconnectAll(@CurrentUser() actor: UserRecord) {
    const requestId = randomBytes(12).toString('hex');
    await this.accessResolver.runWithActorRole(
      actor.id,
      Role.Admin,
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

  /**
   * Recovery after ssh.keyEncryptionSecret was lost: every user gets a new
   * host CA and every container a new certificate. Users must replace their
   * `@cert-authority` known_hosts line.
   */
  @Post('host-authorities/reset')
  @HttpCode(200)
  @RequireRole(Role.Admin)
  async resetHostAuthorities(@CurrentUser() actor: UserRecord): Promise<{ reset: number }> {
    const reset = await this.accessResolver.runWithActorRole(
      actor.id,
      Role.Admin,
      async (transaction) => {
        const count = await this.hostCa.resetAll(transaction);
        await this.audit.append(
          transaction,
          actor.id,
          AuditAction.ResetSshHostAuthorities,
          'host-authorities',
          'ssh_proxy',
          { reset: count },
        );
        return count;
      },
    );
    // Re-signing every container runs in the background; a retry would reset the CAs again.
    this.containerSsh.startReconcileAllHostCertificates();
    return { reset };
  }

  @Get('host-key')
  @RequireRole(Role.Admin)
  async hostKey(@CurrentUser() actor: UserRecord): Promise<SshProxyHostKeySummaryDto> {
    return this.hostKeyDto(actor.id);
  }

  @Post('host-key/rotate')
  @HttpCode(200)
  @RequireRole(Role.Admin)
  async rotateHostKey(@CurrentUser() actor: UserRecord): Promise<SshProxyHostKeySummaryDto> {
    const rotated = await this.sshIdentities.rotateProxyHostKey(
      async (manager) => {
        await assertActorRole(manager, actor.id, Role.Admin);
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
      publicKey: rotated.publicKey,
      fingerprint: rotated.fingerprint,
      generation: rotated.generation,
      rotatedAt: rotated.rotatedAt.toISOString(),
    };
    return result;
  }

  private async hostKeyDto(actorId: string): Promise<SshProxyHostKeySummaryDto> {
    const hostKey = await this.sshIdentities.getProxyHostKeySummary(
      async (manager) => {
        await assertActorRole(manager, actorId, Role.Admin);
      },
    );
    return {
      publicKey: hostKey.publicKey,
      fingerprint: hostKey.fingerprint,
      generation: hostKey.generation,
      rotatedAt: hostKey.rotatedAt.toISOString(),
    };
  }
}
