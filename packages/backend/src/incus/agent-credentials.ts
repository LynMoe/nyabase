import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { parseAgentSecret } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';

/** sha256 hex of an agent secret; the only form secrets are stored in. */
export function agentSecretDigest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function digestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.byteLength === 32 && b.byteLength === 32 && timingSafeEqual(a, b);
}

function bearerCredential(authorization: string | undefined): { credential: string; serverId: string } | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? '');
  const credential = match?.[1];
  if (!credential) return undefined;
  const parsed = parseAgentSecret('credential', credential);
  return parsed ? { credential, serverId: parsed.serverId } : undefined;
}

/** Resolves an agent bearer credential to the server it was issued for. */
@Injectable()
export class AgentCredentialVerifier {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  async authenticate(authorization: string | undefined): Promise<string | undefined> {
    const bearer = bearerCredential(authorization);
    if (!bearer) return undefined;
    const server = await this.database
      .selectFrom('infra.servers')
      .select('agent_credential_hash')
      .where('id', '=', bearer.serverId)
      .executeTakeFirst();
    if (!server?.agent_credential_hash) return undefined;
    return digestsEqual(server.agent_credential_hash, agentSecretDigest(bearer.credential)) ? bearer.serverId : undefined;
  }

  /**
   * Re-check a control socket's credential when its agent says hello (the
   * credential may have been rotated, or the server deleted, since the
   * upgrade), and spend the enrollment token the credential was minted from
   * on its first successful use. Serialized with enrollment on the row lock.
   */
  async confirmControl(serverId: string, authorization: string | undefined): Promise<boolean> {
    const bearer = bearerCredential(authorization);
    if (!bearer || bearer.serverId !== serverId) return false;
    return this.database.transaction().execute(async (transaction) => {
      const server = await transaction
        .selectFrom('infra.servers')
        .select(['agent_credential_hash', 'agent_credential_unconfirmed'])
        .where('id', '=', serverId)
        .forUpdate()
        .executeTakeFirst();
      if (!server?.agent_credential_hash) return false;
      if (!digestsEqual(server.agent_credential_hash, agentSecretDigest(bearer.credential))) return false;
      if (server.agent_credential_unconfirmed) {
        await transaction
          .updateTable('infra.servers')
          .set({
            agent_credential_unconfirmed: false,
            agent_enrollment_token_hash: null,
            agent_enrollment_expires_at: null,
          })
          .where('id', '=', serverId)
          .execute();
      }
      return true;
    });
  }
}
