/*
 * REST: GET /admin/agent-rejections (admin). Not part of the agent
 * protocol (protocol/agent.ts), so changing it never needs an agent release.
 */

/**
 * A credential the Backend turned away: `unknown_server` names a server this
 * database does not have (typically a host enrolled after the backup a
 * restore came from), `bad_secret` a known server whose stored credential
 * differs (re-enrolled since, or never enrolled here). Either host needs a
 * fresh enrollment token. Kept in memory only, since the Backend started.
 */
export interface RejectedAgentCredentialDto {
  serverId: string;
  reason: 'unknown_server' | 'bad_secret';
  /** The client address of the most recent attempt, as the Backend sees it behind trusted proxies. */
  clientAddress: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  attempts: number;
}
