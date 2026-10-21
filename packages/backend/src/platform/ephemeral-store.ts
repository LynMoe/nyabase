import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export const TRUST_TOKEN_TTL_MS = 10 * 60_000;
const TRUST_TOKEN_CLAIM_TTL_MS = 30_000;
const MAX_TTL_MS = 30 * 60_000;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_ENTRIES = 10_000;
const SWEEP_INTERVAL_MS = 30_000;

interface Entry {
  readonly value: string;
  readonly expiresAt: number;
}

/**
 * Process-local TTL store for short-lived secrets and sessions that must never
 * reach PostgreSQL: server trust tokens and console sessions. State is lost on
 * restart; callers treat a miss as an expired value and ask the user to retry.
 */
@Injectable()
export class EphemeralStore implements OnApplicationShutdown {
  private readonly entries = new Map<string, Entry>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.sweeper);
    this.entries.clear();
  }

  /** Returns false when the value is invalid, the key exists (with `onlyIfAbsent`), or the store is full. */
  set(key: string, value: string, ttlMs: number, onlyIfAbsent = false): boolean {
    if (
      !key
      || Buffer.byteLength(value) > MAX_VALUE_BYTES
      || !Number.isSafeInteger(ttlMs)
      || ttlMs < 1
      || ttlMs > MAX_TTL_MS
    ) return false;
    const existing = this.live(key);
    if (existing && onlyIfAbsent) return false;
    if (!existing && this.entries.size >= MAX_ENTRIES) {
      this.sweep();
      if (this.entries.size >= MAX_ENTRIES) return false;
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }

  get(key: string): string | null {
    return this.live(key)?.value ?? null;
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Stores a server trust token and returns the opaque reference persisted in the intent. */
  storeTrustToken(serverId: string, token: string): string {
    const reference = randomUUID();
    if (!this.set(trustTokenKey(serverId, reference), token, TRUST_TOKEN_TTL_MS, true)) {
      throw new Error('Server trust token could not be stored');
    }
    return reference;
  }

  /** Leases the token to one claimant; it stays stored until consumed or the short claim lease expires. */
  claimTrustToken(serverId: string, reference: string, claimId: string): string | null {
    const token = this.get(trustTokenKey(serverId, reference));
    if (token === null) return null;
    if (!this.set(trustTokenClaimKey(serverId, reference), claimId, TRUST_TOKEN_CLAIM_TTL_MS, true)) {
      return null;
    }
    return token;
  }

  consumeClaimedTrustToken(serverId: string, reference: string, claimId: string): boolean {
    if (this.get(trustTokenClaimKey(serverId, reference)) !== claimId) return false;
    this.entries.delete(trustTokenKey(serverId, reference));
    this.entries.delete(trustTokenClaimKey(serverId, reference));
    return true;
  }

  releaseClaimedTrustToken(serverId: string, reference: string, claimId: string): boolean {
    if (this.get(trustTokenClaimKey(serverId, reference)) !== claimId) return false;
    return this.entries.delete(trustTokenClaimKey(serverId, reference));
  }

  private live(key: string): Entry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

function trustTokenKey(serverId: string, reference: string): string {
  return `trust-token:${serverId}:${reference}`;
}

function trustTokenClaimKey(serverId: string, reference: string): string {
  return `trust-token-claim:${serverId}:${reference}`;
}
