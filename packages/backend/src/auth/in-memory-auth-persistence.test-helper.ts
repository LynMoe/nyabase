import { UserStatus } from '@nyabase/common';
import type { Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import type {
  AuthApiToken,
  AuthPersistence,
  AuthUser,
  LoginCredentialSnapshot,
  NewRefreshSession,
  RefreshRotationResult,
} from './auth-persistence.js';

interface RefreshSession {
  id: string;
  hash: string;
  expiresAt: Date;
  createdAt: Date;
  userId: string;
  previousHash: string | null;
  previousRequestIdHash: string | null;
  revoked: boolean;
}

/** Deterministic no-ORM unit port. PostgreSQL locking is covered by repository PG tests. */
export class InMemoryAuthPersistenceTestAdapter implements AuthPersistence {
  private lease: Promise<void> = Promise.resolve();
  private readonly users = new Map<string, AuthUser>();
  private readonly refresh = new Map<string, RefreshSession>();
  private readonly apiTokens = new Map<string, AuthApiToken>();
  beforeApiTokenTouch?: (token: AuthApiToken) => Promise<void>;

  seedUser(input: Partial<AuthUser> & Pick<AuthUser, 'id' | 'username'>): AuthUser {
    const now = new Date();
    const user: AuthUser = {
      numericId: 1001,
      passwordHash: 'unused',
      displayName: input.username,
      status: UserStatus.Active,
      authVersion: 0,
      authzVersion: '0',
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.users.set(user.id, user);
    return user;
  }

  getUser(id: string): AuthUser {
    const user = this.users.get(id);
    if (!user) throw new Error('User not found');
    return user;
  }

  updateUser(id: string, changes: Partial<AuthUser>): void {
    Object.assign(this.getUser(id), changes);
  }

  refreshRows(): RefreshSession[] {
    return [...this.refresh.values()];
  }

  clearRefresh(): void {
    this.refresh.clear();
  }

  updateRefreshByHash(hash: string, changes: Partial<RefreshSession>): void {
    const row = [...this.refresh.values()].find((item) => item.hash === hash);
    if (!row) throw new Error('Refresh session not found');
    Object.assign(row, changes);
  }

  apiTokenRows(): AuthApiToken[] {
    return [...this.apiTokens.values()];
  }

  deleteApiTokenForTest(id: string): void {
    this.apiTokens.delete(id);
  }

  runExclusiveForTest<T>(work: () => Promise<T>): Promise<T> {
    return this.serialized(work);
  }

  async findUserByUsername(username: string): Promise<AuthUser | null> {
    return [...this.users.values()].find((user) => user.username === username) ?? null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    return this.users.get(id) ?? null;
  }

  issueRefreshSession(
    userId: string,
    session: NewRefreshSession,
    maximumSessions: number,
    snapshot?: LoginCredentialSnapshot,
  ): Promise<AuthUser | null> {
    return this.serialized(async () => {
      const user = this.users.get(userId);
      if (!user || user.status !== UserStatus.Active) return null;
      if (snapshot && (
        snapshot.id !== user.id
        || snapshot.passwordHash !== user.passwordHash
        || snapshot.authVersion !== user.authVersion
      )) return null;
      const now = new Date();
      this.purge(now);
      this.trim(userId, maximumSessions - 1);
      this.refresh.set(session.id, {
        id: session.id,
        hash: session.hash,
        expiresAt: new Date(now.getTime() + session.expiresInMs),
        createdAt: now,
        userId,
        previousHash: null,
        previousRequestIdHash: null,
        revoked: false,
      });
      return user;
    });
  }

  rotateRefreshSession(input: {
    hash: string;
    requestIdHash: string;
    expiresInMs: number;
    maximumSessions: number;
    successorHash: (sessionId: string) => string;
  }): Promise<RefreshRotationResult> {
    return this.serialized(async () => {
      const now = new Date();
      this.purge(now);
      const current = [...this.refresh.values()].find(
        (row) => row.hash === input.hash && !row.revoked && row.expiresAt > now,
      );
      if (!current) {
        const recovered = [...this.refresh.values()].find((row) =>
          row.previousHash === input.hash
          && row.previousRequestIdHash === input.requestIdHash
          && !row.revoked
          && row.expiresAt > now);
        const user = recovered ? this.users.get(recovered.userId) : undefined;
        if (!recovered || recovered.hash !== input.successorHash(recovered.id)
          || !user || user.status !== UserStatus.Active) return { kind: 'invalid' };
        return { kind: 'recovered', user, sessionId: recovered.id };
      }
      const user = this.users.get(current.userId);
      if (!user || user.status !== UserStatus.Active) return { kind: 'invalid' };
      this.trim(user.id, input.maximumSessions - 1, current.id);
      current.previousHash = input.hash;
      current.previousRequestIdHash = input.requestIdHash;
      current.hash = input.successorHash(current.id);
      current.expiresAt = new Date(now.getTime() + input.expiresInMs);
      return { kind: 'rotated', user, sessionId: current.id };
    });
  }

  deleteRefreshSessionByCurrentOrPreviousHash(hash: string): Promise<string | null> {
    return this.serialized(async () => {
      const row = [...this.refresh.values()].find(
        (item) => item.hash === hash || item.previousHash === hash,
      );
      if (!row) return null;
      this.refresh.delete(row.id);
      return row.userId;
    });
  }

  validateApiToken(hash: string, now: Date, touchIntervalMs: number): Promise<AuthUser | null> {
    return this.serialized(async () => {
      const token = [...this.apiTokens.values()].find((item) => item.hash === hash);
      if (!token) return null;
      const user = this.users.get(token.userId);
      if (!user || user.status !== UserStatus.Active) return null;
      const elapsed = token.lastUsedAt
        ? now.getTime() - token.lastUsedAt.getTime()
        : Number.POSITIVE_INFINITY;
      if (elapsed >= touchIntervalMs) {
        await this.beforeApiTokenTouch?.(token);
        if (!this.apiTokens.has(token.id)) return null;
        token.lastUsedAt = now;
      }
      return user;
    });
  }

  createApiToken(
    userId: string,
    token: AuthApiToken,
    maximumTokens: number,
  ): Promise<'created' | 'inactive-user' | 'capacity'> {
    return this.serialized(async () => {
      const user = this.users.get(userId);
      if (!user || user.status !== UserStatus.Active) return 'inactive-user';
      if ([...this.apiTokens.values()].filter((item) => item.userId === userId).length
        >= maximumTokens) return 'capacity';
      this.apiTokens.set(token.id, token);
      return 'created';
    });
  }

  async listApiTokens(userId: string): Promise<AuthApiToken[]> {
    return [...this.apiTokens.values()].filter((token) => token.userId === userId);
  }

  deleteApiToken(userId: string, tokenId: string): Promise<AuthApiToken | null> {
    return this.serialized(async () => {
      const token = this.apiTokens.get(tokenId);
      if (!token || token.userId !== userId) return null;
      this.apiTokens.delete(tokenId);
      return token;
    });
  }

  async revokeBrowserSessions(
    _transaction: Transaction<NyabaseDatabase>,
    userId: string,
  ): Promise<void> {
    for (const row of this.refresh.values()) {
      if (row.userId === userId) this.refresh.delete(row.id);
    }
  }

  async deleteUserCredentials(
    transaction: Transaction<NyabaseDatabase>,
    userId: string,
  ): Promise<void> {
    await this.revokeBrowserSessions(transaction, userId);
    for (const token of this.apiTokens.values()) {
      if (token.userId === userId) this.apiTokens.delete(token.id);
    }
  }

  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.lease;
    let release!: () => void;
    this.lease = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private purge(now: Date): void {
    for (const row of this.refresh.values()) {
      if (row.revoked || row.expiresAt <= now) this.refresh.delete(row.id);
    }
  }

  private trim(userId: string, keepCount: number, preserveId?: string): void {
    const candidates = [...this.refresh.values()]
      .filter((row) => row.userId === userId && !row.revoked && row.id !== preserveId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    for (const row of candidates.slice(0, Math.max(0, candidates.length - keepCount))) {
      this.refresh.delete(row.id);
    }
  }
}
