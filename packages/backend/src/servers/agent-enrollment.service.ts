import { ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import {
  AGENT_ENROLLMENT_TTL_MS,
  AuditAction,
  Capability,
  formatAgentSecret,
  parseAgentSecret,
  type AgentEnrollRequest,
  type AgentEnrollResponse,
  type ServerEnrollmentDto,
} from '@nyabase/common';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { AuditService } from '../iam/audit.service.js';
import { agentSecretDigest, digestsEqual } from '../incus/agent-credentials.js';
import { AgentRegistry } from '../incus/agent-registry.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { afterCommit } from '../platform/post-commit.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';

type Tx = Transaction<NyabaseDatabase>;

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The agent's way in: an administrator gets a one-time enrollment token per
 * server (only its digest is stored, it expires), and the agent trades it
 * for its long-lived credential. Re-issuing never revokes the running agent;
 * a successful enrollment replaces its credential and drops the old socket.
 */
@Injectable()
export class AgentEnrollmentService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly access: AccessResolverService,
    private readonly audit: AuditService,
    private readonly agents: AgentRegistry,
  ) {}

  /** Issue (replacing any outstanding) enrollment token inside the caller's transaction. */
  async issueInTransaction(transaction: Tx, serverId: string): Promise<ServerEnrollmentDto> {
    const token = formatAgentSecret('enrollment', serverId, newSecret());
    const expiresAt = new Date(Date.now() + AGENT_ENROLLMENT_TTL_MS);
    await transaction
      .updateTable('infra.servers')
      .set({ agent_enrollment_token_hash: agentSecretDigest(token), agent_enrollment_expires_at: expiresAt })
      .where('id', '=', serverId)
      .execute();
    return { enrollmentToken: token, expiresAt: expiresAt.toISOString() };
  }

  rotate(actorId: string, serverId: string, expectedRevision: number): Promise<ServerEnrollmentDto> {
    return this.transactions.run(async (transaction) => {
      await this.access.assertActorCapabilitiesInTransaction(transaction, actorId, [Capability.ManageServers]);
      const server = await transaction
        .selectFrom('infra.servers')
        .select(['id', 'revision'])
        .where('id', '=', serverId)
        .forUpdate()
        .executeTakeFirst();
      if (!server) throw new NotFoundException('Server not found');
      if (Number(server.revision) !== expectedRevision) throw new ConflictException({ code: 'REVISION_CONFLICT' });
      const enrollment = await this.issueInTransaction(transaction, serverId);
      await this.audit.append(transaction, actorId, AuditAction.IssueAgentEnrollment, serverId, 'server', {
        expiresAt: enrollment.expiresAt,
      });
      return enrollment;
    });
  }

  /** Trade an enrollment token for a credential; every failure looks the same to the caller. */
  async enroll(request: AgentEnrollRequest): Promise<AgentEnrollResponse> {
    const parsed = parseAgentSecret('enrollment', request.enrollmentToken);
    if (!parsed) throw new UnauthorizedException('Enrollment token is invalid or expired');
    const { serverId } = parsed;
    const credential = formatAgentSecret('credential', serverId, newSecret());
    await this.transactions.run(async (transaction) => {
      const server = await transaction
        .selectFrom('infra.servers')
        .select(['agent_enrollment_token_hash', 'agent_enrollment_expires_at'])
        .where('id', '=', serverId)
        .forUpdate()
        .executeTakeFirst();
      const expiresAt = server?.agent_enrollment_expires_at;
      if (
        !server?.agent_enrollment_token_hash
        || !expiresAt
        || new Date(expiresAt).getTime() <= Date.now()
        || !digestsEqual(server.agent_enrollment_token_hash, agentSecretDigest(request.enrollmentToken))
      ) {
        throw new UnauthorizedException('Enrollment token is invalid or expired');
      }
      await transaction
        .updateTable('infra.servers')
        .set({
          agent_credential_hash: agentSecretDigest(credential),
          agent_enrollment_token_hash: null,
          agent_enrollment_expires_at: null,
          agent_hostname: request.hostname,
        })
        .where('id', '=', serverId)
        .execute();
      await this.audit.append(transaction, null, AuditAction.EnrollAgent, serverId, 'server', {
        hostname: request.hostname,
      });
      // A previous agent's credential just stopped being valid.
      afterCommit(transaction, () => this.agents.disconnect(serverId));
    });
    return { serverId, credential };
  }
}
