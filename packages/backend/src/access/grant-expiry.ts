import { GRANT_EXPIRY_GRACE_DAYS, type GrantExpiryPhase } from '@nyabase/common';

export const GRANT_EXPIRY_GRACE_MS = GRANT_EXPIRY_GRACE_DAYS * 24 * 60 * 60 * 1000;

export type { GrantExpiryPhase };

/** Classify a grant's expires_at relative to `now`. Dead grants are past the grace window. */
export function classifyGrantExpiry(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): GrantExpiryPhase {
  if (expiresAt == null) return 'live';
  const expiresMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return 'live';
  const nowMs = now.getTime();
  if (nowMs < expiresMs) return 'live';
  if (nowMs < expiresMs + GRANT_EXPIRY_GRACE_MS) return 'grace';
  return 'lost';
}

export function grantPurgeAt(
  expiresAt: Date | string | null | undefined,
): Date | null {
  if (expiresAt == null) return null;
  const expiresMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return null;
  return new Date(expiresMs + GRANT_EXPIRY_GRACE_MS);
}

/** Sort key for "latest expires_at wins"; null (never) sorts as +Infinity. */
export function expiresAtSortKey(expiresAt: Date | string | null | undefined): number {
  if (expiresAt == null) return Number.POSITIVE_INFINITY;
  const expiresMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  return Number.isFinite(expiresMs) ? expiresMs : Number.POSITIVE_INFINITY;
}

/** Fields needed to pick a live winner (shared + server mutate paths). */
export interface GrantWinnerCandidate {
  /** 0 = direct user grant, 1 = inherited group grant */
  scopeRank: number;
  /** Group priority; unused for direct grants */
  priority: number;
  /** Group id (or grant id) for stable tie-break */
  tieBreaker: string;
  expiresAt: Date | string | null;
}

export interface GrantExpiryCandidate extends GrantWinnerCandidate {
  cpu_millis: number | null;
  mem_bytes: string | number | null;
  disk_bytes: string | number | null;
  extension_grants?: unknown;
}

export function liveExpiry(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  return classifyGrantExpiry(expiresAt, now) === 'live';
}

/**
 * Live before grace; direct before group; among groups later expires_at
 * (null = never) then priority DESC then tieBreaker DESC. Direct grants skip
 * expires/priority and fall through to tieBreaker. Does not include grace in
 * the live-only winner — filter with liveExpiry / selectLiveGrantCandidate.
 */
export function compareGrantCandidates<T extends GrantWinnerCandidate>(
  left: T,
  right: T,
  now: Date = new Date(),
): number {
  const leftPhase = classifyGrantExpiry(left.expiresAt, now) === 'live' ? 0 : 1;
  const rightPhase = classifyGrantExpiry(right.expiresAt, now) === 'live' ? 0 : 1;
  if (leftPhase !== rightPhase) return leftPhase - rightPhase;
  if (left.scopeRank !== right.scopeRank) return left.scopeRank - right.scopeRank;
  if (left.scopeRank === 1) {
    const leftExpires = expiresAtSortKey(left.expiresAt);
    const rightExpires = expiresAtSortKey(right.expiresAt);
    if (leftExpires !== rightExpires) return rightExpires > leftExpires ? 1 : -1;
    if (left.priority !== right.priority) return right.priority - left.priority;
  }
  return right.tieBreaker.localeCompare(left.tieBreaker);
}

/** Live-only winner. Grace is ignored even if it would win under selectWinningGrantCandidate. */
export function selectLiveGrantCandidate<T extends GrantWinnerCandidate>(
  candidates: readonly T[],
  now: Date = new Date(),
): T | null {
  const live = candidates.filter((candidate) => liveExpiry(candidate.expiresAt, now));
  if (live.length === 0) return null;
  const sorted = [...live].sort((left, right) => compareGrantCandidates(left, right, now));
  return sorted[0] ?? null;
}

/**
 * Pick the winning non-dead covering grant.
 * Live beats grace; within a phase direct beats group; among groups (same
 * phase) latest expires_at wins (null = never), then priority DESC, then
 * tieBreaker DESC. Two never-expiring grants compare equal on expiresAt
 * (Infinity === Infinity) and fall through to priority.
 */
export function selectWinningGrantCandidate<T extends GrantExpiryCandidate>(
  candidates: readonly T[],
  now: Date = new Date(),
): { candidate: T; phase: 'live' | 'grace' } | null {
  const live: T[] = [];
  const grace: T[] = [];
  for (const candidate of candidates) {
    const phase = classifyGrantExpiry(candidate.expiresAt, now);
    if (phase === 'live') live.push(candidate);
    else if (phase === 'grace') grace.push(candidate);
  }
  const pool = live.length > 0 ? live : grace;
  if (pool.length === 0) return null;
  const phase = live.length > 0 ? 'live' : 'grace';
  const sorted = [...pool].sort((left, right) => {
    if (left.scopeRank !== right.scopeRank) return left.scopeRank - right.scopeRank;
    const leftExpires = expiresAtSortKey(left.expiresAt);
    const rightExpires = expiresAtSortKey(right.expiresAt);
    // Infinity === Infinity for two never-expiring grants; otherwise later wins.
    if (leftExpires !== rightExpires) return rightExpires > leftExpires ? 1 : -1;
    if (left.priority !== right.priority) return right.priority - left.priority;
    return right.tieBreaker.localeCompare(left.tieBreaker);
  });
  return { candidate: sorted[0]!, phase };
}
