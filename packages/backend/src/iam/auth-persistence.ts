import type { Transaction } from 'kysely';
import type { Role, UserStatus } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

export interface AuthUser {
  id: string;
  numericId: number;
  username: string;
  passwordHash: string;
  displayName: string;
  status: UserStatus;
  authVersion: number;
  role: Role;
  /** Set by an administrator's create / reset; the web UI blocks until the user changes it. */
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The authenticated principal attached to a request (service-facing camelCase contract). */
export type UserRecord = AuthUser;

export interface NewRefreshSession {
  id: string;
  hash: string;
  expiresInMs: number;
}

export interface LoginCredentialSnapshot {
  id: string;
  passwordHash: string;
  authVersion: number;
}

export type AuthTransactionHook<T> = (
  transaction: Transaction<NyabaseDatabase>,
  value: T,
) => Promise<void>;

export interface RefreshRotationInput {
  hash: string;
  requestIdHash: string;
  /** Idle timeout: a rotation moves the expiry to now + idleMs... */
  idleMs: number;
  /** ...but never past the session start (login) + absoluteMs. */
  absoluteMs: number;
  /**
   * How long the immediately previous token, presented with a different
   * request id, still counts as a concurrent refresh instead of reuse.
   */
  reuseGraceMs: number;
  /** Retired hashes kept per session; older ones are forgotten (just invalid). */
  retainedAncestors: number;
  /**
   * A rotation that would forget a hash retired less than this long ago is
   * refused (`throttled`), so every recent ancestor stays detectable however
   * fast a holder loops refresh.
   */
  ancestorMinimumAgeMs: number;
  maximumSessions: number;
  successorHash: (sessionId: string) => string;
  /** Runs in the transaction that deleted a session for token reuse. */
  onReuse?: AuthTransactionHook<RefreshTokenReuse>;
}

export interface RefreshTokenReuse {
  userId: string;
  sessionId: string;
}

/** A browser (refresh) session, identified by its stable row id. */
export interface RefreshSessionRef {
  userId: string;
  sessionId: string;
}

/** A live browser session: `expiresAt` is the idle expiry, `createdAt` the login time. */
export interface LiveRefreshSession {
  expiresAt: Date;
  createdAt: Date;
}

export type RefreshRotationResult =
  | { kind: 'invalid' }
  /** The just-retired token lost a concurrent rotation; the session is intact. */
  | { kind: 'superseded' }
  /**
   * The session rotated `retainedAncestors` times within `ancestorMinimumAgeMs`;
   * the next rotation is allowed in `retryAfterMs`.
   */
  | { kind: 'throttled'; retryAfterMs: number }
  /** A retired token was presented again; the whole session was deleted. */
  | ({ kind: 'reused' } & RefreshTokenReuse)
  | { kind: 'recovered'; user: AuthUser; sessionId: string; expiresInMs: number }
  | { kind: 'rotated'; user: AuthUser; sessionId: string; expiresInMs: number };

export interface AuthPersistence {
  findUserByUsername(username: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  /** The user, only while their session `sessionId` is live (see `findLiveRefreshSession`). */
  findSessionUser(userId: string, sessionId: string): Promise<AuthUser | null>;
  issueRefreshSession(
    userId: string,
    session: NewRefreshSession,
    maximumSessions: number,
    credentialSnapshot?: LoginCredentialSnapshot,
    onIssued?: AuthTransactionHook<AuthUser>,
  ): Promise<AuthUser | null>;
  rotateRefreshSession(input: RefreshRotationInput): Promise<RefreshRotationResult>;
  deleteRefreshSessionByCurrentOrRetiredHash(
    hash: string,
    onDeleted?: AuthTransactionHook<string>,
  ): Promise<RefreshSessionRef | null>;
  /** The user's session `sessionId` if it exists, is not revoked and has not idled out. */
  findLiveRefreshSession(userId: string, sessionId: string): Promise<LiveRefreshSession | null>;
  revokeBrowserSessions(
    transaction: Transaction<NyabaseDatabase>,
    userId: string,
  ): Promise<void>;
}

export function isPgIamTransaction(
  value: unknown,
): value is Transaction<NyabaseDatabase> {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { deleteFrom?: unknown }).deleteFrom === 'function'
    && typeof (value as { selectFrom?: unknown }).selectFrom === 'function',
  );
}
