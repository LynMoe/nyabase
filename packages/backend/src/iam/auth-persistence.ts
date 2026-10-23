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
  maximumSessions: number;
  successorHash: (sessionId: string) => string;
  /** Runs in the transaction that deleted a session for token reuse. */
  onReuse?: AuthTransactionHook<RefreshTokenReuse>;
}

export interface RefreshTokenReuse {
  userId: string;
  sessionId: string;
}

export type RefreshRotationResult =
  | { kind: 'invalid' }
  /** The just-retired token lost a concurrent rotation; the session is intact. */
  | { kind: 'superseded' }
  /** A retired token was presented again; the whole session was deleted. */
  | ({ kind: 'reused' } & RefreshTokenReuse)
  | { kind: 'recovered'; user: AuthUser; sessionId: string; expiresInMs: number }
  | { kind: 'rotated'; user: AuthUser; sessionId: string; expiresInMs: number };

export interface AuthPersistence {
  findUserByUsername(username: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  issueRefreshSession(
    userId: string,
    session: NewRefreshSession,
    maximumSessions: number,
    credentialSnapshot?: LoginCredentialSnapshot,
    onIssued?: AuthTransactionHook<AuthUser>,
  ): Promise<AuthUser | null>;
  rotateRefreshSession(input: RefreshRotationInput): Promise<RefreshRotationResult>;
  deleteRefreshSessionByCurrentOrPreviousHash(
    hash: string,
    onDeleted?: AuthTransactionHook<string>,
  ): Promise<string | null>;
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
