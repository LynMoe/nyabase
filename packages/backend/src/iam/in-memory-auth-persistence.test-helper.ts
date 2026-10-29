import { UserStatus, Role } from '@nyabase/common';
import type { Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type {
  AuthPersistence,
  AuthUser,
  LiveRefreshSession,
  LoginCredentialSnapshot,
  NewRefreshSession,
  RefreshRotationInput,
  RefreshRotationResult,
  RefreshSessionRef,
} from './auth-persistence.js';

interface RefreshSession {
  id: string;
  hash: string;
  expiresAt: Date;
  createdAt: Date;
  userId: string;
  previousHash: string | null;
  previousRequestIdHash: string | null;
  rotatedAt: Date | null;
  /** Retained retired hashes -> retirement time, oldest first. */
  ancestors: Map<string, Date>;
  revoked: boolean;
}

/** Deterministic no-ORM unit port. PostgreSQL locking is covered by repository PG tests. */
export class InMemoryAuthPersistenceTestAdapter implements AuthPersistence {
  /** Tests move this clock to cross idle, absolute and grace boundaries. */
  now: () => Date = () => new Date();
  private lease: Promise<void> = Promise.resolve();
  private readonly users = new Map<string, AuthUser>();
  private readonly refresh = new Map<string, RefreshSession>();

  seedUser(input: Partial<AuthUser> & Pick<AuthUser, 'id' | 'username'>): AuthUser {
    const now = new Date();
    const user: AuthUser = {
      numericId: 1001,
      passwordHash: 'unused',
      displayName: input.username,
      status: UserStatus.Active,
      authVersion: 0,
      role: Role.User,
      mustChangePassword: false,
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

  runExclusiveForTest<T>(work: () => Promise<T>): Promise<T> {
    return this.serialized(work);
  }

  async findUserByUsername(username: string): Promise<AuthUser | null> {
    return [...this.users.values()].find((user) => user.username === username) ?? null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    return this.users.get(id) ?? null;
  }

  async findSessionUser(userId: string, sessionId: string): Promise<AuthUser | null> {
    return await this.findLiveRefreshSession(userId, sessionId) ? this.findUserById(userId) : null;
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
      const now = this.now();
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
        rotatedAt: null,
        ancestors: new Map(),
        revoked: false,
      });
      return user;
    });
  }

  /** Mirrors `IamAuthRepository.rotateRefreshSession`; `now` is the adapter clock. */
  rotateRefreshSession(input: RefreshRotationInput): Promise<RefreshRotationResult> {
    return this.serialized(async () => {
      const now = this.now();
      const current = [...this.refresh.values()].find(
        (row) => row.hash === input.hash && !row.revoked,
      );
      if (!current) return this.resolveRetired(input, now);
      const user = this.users.get(current.userId);
      if (!user || user.status !== UserStatus.Active) return { kind: 'invalid' };
      const sessionEnd = current.createdAt.getTime() + input.absoluteMs;
      if (current.expiresAt <= now || sessionEnd <= now.getTime()) {
        this.refresh.delete(current.id);
        return { kind: 'invalid' };
      }
      const evicted = [...current.ancestors.values()].at(-input.retainedAncestors);
      const retryAfterMs = evicted
        ? evicted.getTime() + input.ancestorMinimumAgeMs - now.getTime()
        : 0;
      if (retryAfterMs > 0) return { kind: 'throttled', retryAfterMs };
      this.trim(user.id, input.maximumSessions - 1, current.id);
      current.ancestors.set(input.hash, now);
      for (const hash of [...current.ancestors.keys()].slice(0, -input.retainedAncestors)) {
        current.ancestors.delete(hash);
      }
      current.previousHash = input.hash;
      current.previousRequestIdHash = input.requestIdHash;
      current.rotatedAt = now;
      current.hash = input.successorHash(current.id);
      current.expiresAt = new Date(Math.min(now.getTime() + input.idleMs, sessionEnd));
      return {
        kind: 'rotated',
        user,
        sessionId: current.id,
        expiresInMs: current.expiresAt.getTime() - now.getTime(),
      };
    });
  }

  private async resolveRetired(
    input: RefreshRotationInput,
    now: Date,
  ): Promise<RefreshRotationResult> {
    const retired = [...this.refresh.values()].find(
      (row) => row.ancestors.has(input.hash) && !row.revoked,
    );
    if (!retired) return { kind: 'invalid' };
    if (retired.previousHash === input.hash) {
      if (retired.previousRequestIdHash === input.requestIdHash) {
        const user = this.users.get(retired.userId);
        if (!user || user.status !== UserStatus.Active || retired.expiresAt <= now
          || retired.hash !== input.successorHash(retired.id)) return { kind: 'invalid' };
        return {
          kind: 'recovered',
          user,
          sessionId: retired.id,
          expiresInMs: retired.expiresAt.getTime() - now.getTime(),
        };
      }
      if (retired.rotatedAt && now.getTime() - retired.rotatedAt.getTime() < input.reuseGraceMs) {
        return { kind: 'superseded' };
      }
    }
    this.refresh.delete(retired.id);
    const reuse = { userId: retired.userId, sessionId: retired.id };
    await input.onReuse?.(undefined as never, reuse);
    return { kind: 'reused', ...reuse };
  }

  deleteRefreshSessionByCurrentOrRetiredHash(hash: string): Promise<RefreshSessionRef | null> {
    return this.serialized(async () => {
      const row = [...this.refresh.values()].find(
        (item) => item.hash === hash || item.ancestors.has(hash),
      );
      if (!row) return null;
      this.refresh.delete(row.id);
      return { userId: row.userId, sessionId: row.id };
    });
  }

  async findLiveRefreshSession(userId: string, sessionId: string): Promise<LiveRefreshSession | null> {
    const row = this.refresh.get(sessionId);
    if (!row || row.userId !== userId || row.revoked || row.expiresAt <= this.now()) return null;
    return { expiresAt: row.expiresAt, createdAt: row.createdAt };
  }

  async revokeBrowserSessions(
    _transaction: Transaction<NyabaseDatabase>,
    userId: string,
  ): Promise<void> {
    for (const row of this.refresh.values()) {
      if (row.userId === userId) this.refresh.delete(row.id);
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
