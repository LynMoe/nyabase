import { createHash, timingSafeEqual } from 'node:crypto';
import type * as http from 'node:http';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { parseAgentSecret, type RejectedAgentCredentialDto } from '@nyabase/common';
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

export const MAX_REJECTED_AGENT_CREDENTIALS = 256;
/** Agents retry a rejected credential about once a minute; an hour of silence means it stopped. */
export const REJECTED_AGENT_CREDENTIAL_TTL_MS = 60 * 60_000;

interface Rejection {
  readonly reason: RejectedAgentCredentialDto['reason'];
  readonly clientAddress: string | null;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly attempts: number;
}

/**
 * Well-formed agent credentials the Backend refused, by the server id they
 * claim, so operators can see hosts that still dial in after a restore or a
 * re-enrollment. In memory only (agents keep retrying, so it refills after a
 * restart); bounded, the least recently seen entry goes first. Provided by
 * factory (IncusModule), not constructor injection.
 */
export class AgentCredentialRejections {
  private readonly logger = new Logger(AgentCredentialRejections.name);
  private readonly entries = new Map<string, Rejection>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity = MAX_REJECTED_AGENT_CREDENTIALS,
  ) {}

  record(serverId: string, reason: Rejection['reason'], clientAddress: string | undefined): void {
    const now = this.now();
    this.prune(now);
    const previous = this.entries.get(serverId);
    this.entries.delete(serverId);
    if (!previous) {
      const from = clientAddress ?? 'an unknown address';
      this.logger.warn(reason === 'unknown_server'
        ? `Refused the agent at ${from}: its credential names server ${serverId}, which this database `
          + 'does not know (a host added after the backup this database was restored from?)'
        : `Refused the agent at ${from}: its credential for server ${serverId} does not match the stored `
          + 'one (enrolled again since, or a stale agent); re-enroll that host');
      while (this.entries.size >= this.capacity) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    this.entries.set(serverId, {
      reason,
      clientAddress: clientAddress ?? null,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      attempts: (previous?.attempts ?? 0) + 1,
    });
  }

  /** The server's agent authenticated: whatever was rejected for it has been resolved. */
  forget(serverId: string): void {
    this.entries.delete(serverId);
  }

  /** Most recently seen first. */
  list(): RejectedAgentCredentialDto[] {
    this.prune(this.now());
    return [...this.entries].reverse().map(([serverId, entry]) => ({
      serverId,
      reason: entry.reason,
      clientAddress: entry.clientAddress,
      firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
      lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
      attempts: entry.attempts,
    }));
  }

  /** Entries are kept in last-seen order, so the stale ones are at the front. */
  private prune(now: number): void {
    for (const [serverId, entry] of this.entries) {
      if (now - entry.lastSeenAt < REJECTED_AGENT_CREDENTIAL_TTL_MS) return;
      this.entries.delete(serverId);
    }
  }
}

/** Resolves an agent bearer credential to the server it was issued for. */
@Injectable()
export class AgentCredentialVerifier {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly rejections: AgentCredentialRejections,
  ) {}

  /** A well-formed credential that fails is recorded for operators, with the client it came from. */
  async authenticate(authorization: string | undefined, clientAddress?: string): Promise<string | undefined> {
    const bearer = bearerCredential(authorization);
    if (!bearer) return undefined;
    const server = await this.database
      .selectFrom('infra.servers')
      .select('agent_credential_hash')
      .where('id', '=', bearer.serverId)
      .executeTakeFirst();
    if (!server?.agent_credential_hash
      || !digestsEqual(server.agent_credential_hash, agentSecretDigest(bearer.credential))) {
      this.rejections.record(bearer.serverId, server ? 'bad_secret' : 'unknown_server', clientAddress);
      return undefined;
    }
    this.rejections.forget(bearer.serverId);
    return bearer.serverId;
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

/** Credential lookups in flight at once, across all clients. */
export const MAX_PENDING_AGENT_AUTHENTICATIONS = 64;

/** Express' compiled `trust proxy` function: is the hop at `index` (0 = socket peer) a trusted proxy? */
export type TrustProxy = (address: string, index: number) => boolean;

/**
 * Bounds how many agent upgrades may wait on their credential's database
 * lookup at once, so a reconnect storm (every agent after a Backend restart)
 * cannot pile up queries. There is deliberately no per-client failure budget:
 * agents behind one NAT or an unconfigured proxy share an address, and a
 * stale agent among them (or a database outage) must never lock the healthy
 * ones out of their control and stream sockets.
 */
export class AgentUpgradeAdmissions {
  private pending = 0;

  constructor(private readonly maxPending = MAX_PENDING_AGENT_AUTHENTICATIONS) {}

  /** A release function for one lookup slot, or undefined when all are taken. */
  admit(): (() => void) | undefined {
    if (this.pending >= this.maxPending) return undefined;
    this.pending += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pending -= 1;
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
