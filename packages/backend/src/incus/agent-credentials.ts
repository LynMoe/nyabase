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

/** Resolves an agent bearer credential to the server it was issued for. */
@Injectable()
export class AgentCredentialVerifier {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  async authenticate(authorization: string | undefined): Promise<string | undefined> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? '');
    const credential = match?.[1];
    if (!credential) return undefined;
    const parsed = parseAgentSecret('credential', credential);
    if (!parsed) return undefined;
    const server = await this.database
      .selectFrom('infra.servers')
      .select('agent_credential_hash')
      .where('id', '=', parsed.serverId)
      .executeTakeFirst();
    if (!server?.agent_credential_hash) return undefined;
    return digestsEqual(server.agent_credential_hash, agentSecretDigest(credential)) ? parsed.serverId : undefined;
  }
}
