import { createHash, timingSafeEqual } from 'node:crypto';
import type * as http from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { parseAgentSecret } from '@nyabase/common';
import { clientAddressBucket, LoginAttemptLimiter } from '../iam/login-throttling.js';
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

/** Failed agent authentications one client address bucket may cause per window. */
export const AGENT_AUTH_FAILURE_WINDOW_MS = 10 * 60_000;
export const MAX_AGENT_AUTH_FAILURES_PER_WINDOW = 30;
export const MAX_TRACKED_AGENT_AUTH_ADDRESSES = 4_096;
/** Credential lookups in flight at once, across all clients. */
export const MAX_PENDING_AGENT_AUTHENTICATIONS = 64;

/** Express' compiled `trust proxy` function: is the hop at `index` (0 = socket peer) a trusted proxy? */
export type TrustProxy = (address: string, index: number) => boolean;

export type AgentUpgradeAdmission =
  | { readonly refused: 429 | 503 }
  | {
    readonly refused?: undefined;
    /** Report the credential check: a success gives the attempt back, a failure keeps it counted. */
    settle(authenticated: boolean): void;
  };

/**
 * Bounds what unauthenticated agent WebSocket upgrades cost before their
 * credential is checked against the database: each client address bucket
 * (as `clientAddressBucket` forms it, behind trusted proxies only) may fail
 * a limited number of times per window, and only so many lookups run at
 * once. Successful checks are given back, so connected agents (and their
 * stream sockets) never use up the budget.
 */
export class AgentUpgradeAdmissions {
  private readonly failures: LoginAttemptLimiter;
  private pending = 0;

  constructor(
    private readonly trustProxy: TrustProxy = () => false,
    now: () => number = Date.now,
    private readonly maxPending = MAX_PENDING_AGENT_AUTHENTICATIONS,
  ) {
    this.failures = new LoginAttemptLimiter(now, MAX_TRACKED_AGENT_AUTH_ADDRESSES, AGENT_AUTH_FAILURE_WINDOW_MS);
  }

  admit(request: http.IncomingMessage): AgentUpgradeAdmission {
    if (this.pending >= this.maxPending) return { refused: 503 };
    const key = `agent:${clientAddressBucket(clientAddress(request, this.trustProxy))}`;
    const reservation = this.failures.reserve([{ key, limit: MAX_AGENT_AUTH_FAILURES_PER_WINDOW }]);
    if (!reservation) return { refused: 429 };
    this.pending += 1;
    let settled = false;
    return {
      settle: (authenticated) => {
        if (settled) return;
        settled = true;
        this.pending -= 1;
        if (authenticated) this.failures.release(reservation);
      },
    };
  }
}

/**
 * The client address Express would report as `req.ip` for this request:
 * walk X-Forwarded-For from the socket peer outward while each hop is a
 * trusted proxy (the same algorithm as proxy-addr).
 */
export function clientAddress(request: http.IncomingMessage, trustProxy: TrustProxy): string | undefined {
  const peer = request.socket?.remoteAddress;
  if (!peer) return undefined;
  const header = request.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : header ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean)
    .reverse();
  const hops = [peer, ...forwarded];
  for (let index = 0; index < hops.length - 1; index += 1) {
    if (!trustProxy(hops[index]!, index)) return hops[index];
  }
  return hops[hops.length - 1];
}
