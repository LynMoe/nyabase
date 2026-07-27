import type { Transaction } from 'kysely';
import type { UserStatus } from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';

export interface AuthUser {
  id: string;
  numericId: number;
  username: string;
  passwordHash: string;
  displayName: string;
  status: UserStatus;
  authVersion: number;
  authzVersion?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthApiToken {
  id: string;
  userId: string;
  name: string;
  hash: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

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

export type RefreshRotationResult =
  | { kind: 'invalid' }
  | { kind: 'recovered'; user: AuthUser; sessionId: string }
  | { kind: 'rotated'; user: AuthUser; sessionId: string };

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
  rotateRefreshSession(input: {
    hash: string;
    requestIdHash: string;
    expiresInMs: number;
    maximumSessions: number;
    successorHash: (sessionId: string) => string;
  }): Promise<RefreshRotationResult>;
  deleteRefreshSessionByCurrentOrPreviousHash(
    hash: string,
    onDeleted?: AuthTransactionHook<string>,
  ): Promise<string | null>;
  validateApiToken(
    hash: string,
    now: Date,
    touchIntervalMs: number,
  ): Promise<AuthUser | null>;
  createApiToken(
    userId: string,
    token: AuthApiToken,
    maximumTokens: number,
    onCreated?: AuthTransactionHook<AuthApiToken>,
  ): Promise<'created' | 'inactive-user' | 'capacity'>;
  listApiTokens(userId: string): Promise<AuthApiToken[]>;
  deleteApiToken(
    userId: string,
    tokenId: string,
    onDeleted?: AuthTransactionHook<AuthApiToken>,
  ): Promise<AuthApiToken | null>;
  revokeBrowserSessions(
    transaction: Transaction<NyabaseDatabase>,
    userId: string,
  ): Promise<void>;
  deleteUserCredentials(
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
