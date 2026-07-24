import type { UserDto } from '@nyabase/common';
import { clearPrincipalQueryState, resetCurrentPrincipalAccessQueries } from './query-client.js';
import { useAuthStore, type AuthStatus } from '../store/auth.js';
import {
  isPersistedAuthCredentials,
  isRuntimeAuthError,
  isRuntimeAuthStatus,
  isRuntimeUserDto,
} from './auth-state-validation.js';

const CHANNEL_NAME = 'nyabase-auth-session';
const SYNC_STORAGE_KEY = 'nyabase-auth-session-sync';
const ACCESS_SYNC_STORAGE_KEY = 'nyabase-auth-access-sync';
const REFRESH_LOCK_KEY = 'nyabase-auth-refresh-lock';
const REFRESH_LOCK_NAME = 'nyabase-auth-refresh';
const LOGIN_STORAGE_PROBE_PREFIX = 'nyabase-auth-login-preflight';
const REFRESH_LEASE_DURATION_MS = 30_000;
const REFRESH_LEASE_HEARTBEAT_MS = 5_000;
const MAX_COORDINATION_REVISION = Number.MAX_SAFE_INTEGER - 1;

type SessionRevision = { clock: number; source: string };
type SessionTransition = 'login' | 'refresh' | 'pending-user' | 'current-user';

type SessionMessage = {
  id: string;
  source: string;
  type: 'session';
  sessionId: string;
  principalId: string;
  sessionRevision: SessionRevision;
  revision: SessionRevision;
  transition: SessionTransition;
  accessRevision: number;
  accessToken: string;
  refreshToken: string;
  refreshRequestId: string;
  user: UserDto;
  status: AuthStatus;
  authError: string | null;
} | {
  id: string;
  source: string;
  type: 'logout';
  sessionId: string;
  principalId: string;
  sessionRevision: SessionRevision;
  revision: SessionRevision;
} | {
  id: string;
  source: string;
  type: 'access';
  sessionId: string;
  principalId: string;
  sessionRevision: SessionRevision;
  revision: SessionRevision;
  accessRevision: number;
};

type RefreshLease = { owner: string; expiresAt: number };

const sourceId = randomId();
const seenMessageIds = new Set<string>();
let channel: BroadcastChannel | null = null;
let initialized = false;
let logicalClock = 0;
const groupMembershipOverrides = new Map<string, boolean>();
let activeSession: {
  sessionId: string;
  principalId: string;
  sessionRevision: SessionRevision;
  revision: SessionRevision;
  accessRevision: number;
} | null = null;

export class AuthSessionCoordinationError extends Error {
  constructor() {
    super('浏览器无法安全生成或持久化会话协调信息，请允许站点存储后重试');
    this.name = 'AuthSessionCoordinationError';
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRefreshRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function createRefreshRequestId(): string {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
    throw new AuthSessionCoordinationError();
  }
  try {
    const bytes = webCrypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    throw new AuthSessionCoordinationError();
  }
}

/**
 * Prove that this browser can durably round-trip coordination state before a
 * login request creates a server-side refresh session.
 */
export function prepareLoginSession(): string {
  const refreshRequestId = createRefreshRequestId();
  if (typeof window === 'undefined') throw new AuthSessionCoordinationError();
  const key = `${LOGIN_STORAGE_PROBE_PREFIX}:${sourceId}:${randomId()}`;
  const value = `${refreshRequestId}:${randomId()}`;
  try {
    window.localStorage.setItem(key, value);
    if (window.localStorage.getItem(key) !== value) throw new AuthSessionCoordinationError();
    window.localStorage.removeItem(key);
    if (window.localStorage.getItem(key) !== null) throw new AuthSessionCoordinationError();
  } catch (error) {
    try { window.localStorage.removeItem(key); } catch { /* unavailable storage is already fail-closed */ }
    if (error instanceof AuthSessionCoordinationError) throw error;
    throw new AuthSessionCoordinationError();
  }
  return refreshRequestId;
}

function compareRevision(a: SessionRevision, b: SessionRevision): number {
  if (a.clock !== b.clock) return a.clock - b.clock;
  return a.source.localeCompare(b.source);
}

function observeRevision(revision: SessionRevision): void {
  logicalClock = Math.max(logicalClock, revision.clock);
}

function nextRevision(persisted?: SessionMessage | null): SessionRevision {
  if (persisted) observeRevision(persisted.revision);
  const nextClock = Math.max(Date.now(), logicalClock + 1);
  if (!Number.isSafeInteger(nextClock) || nextClock > MAX_COORDINATION_REVISION) {
    throw new AuthSessionCoordinationError();
  }
  logicalClock = nextClock;
  return { clock: logicalClock, source: sourceId };
}

function nextFamilyRevision(persisted?: SessionMessage | null): SessionRevision {
  const immutableBaseline = Math.max(
    activeSession?.sessionRevision.clock ?? 0,
    persisted?.sessionRevision.clock ?? 0,
  );
  const nextClock = Math.max(Date.now(), immutableBaseline + 1);
  if (!Number.isSafeInteger(nextClock) || nextClock > MAX_COORDINATION_REVISION) {
    throw new AuthSessionCoordinationError();
  }
  logicalClock = nextClock;
  return { clock: nextClock, source: sourceId };
}

function userAuthorizationFingerprint(user: UserDto | null): string {
  if (!user) return '';
  const capabilities = [...user.capabilities].sort();
  const groups = [...user.groups]
    .map((group) => `${group.id}:${group.name}:${group.priority}:${group.isSystem}`)
    .sort();
  return JSON.stringify([user.id, user.status, capabilities, groups]);
}

function shouldClearPrincipalState(previous: UserDto | null, next: UserDto | null): boolean {
  return userAuthorizationFingerprint(previous) !== userAuthorizationFingerprint(next);
}

function rememberMessage(id: string): boolean {
  if (seenMessageIds.has(id)) return false;
  seenMessageIds.add(id);
  if (seenMessageIds.size > 128) {
    const oldest = seenMessageIds.values().next().value as string | undefined;
    if (oldest) seenMessageIds.delete(oldest);
  }
  return true;
}

function handleMessage(message: SessionMessage): void {
  // Storage writes are synchronous and globally ordered for this origin. A
  // BroadcastChannel/storage event can arrive late, so prefer the newest
  // persisted record over the event payload instead of reviving stale state.
  const persistedRead = message.type === 'access'
    ? readPersistedAccessMessage()
    : readPersistedSessionMessage();
  const persisted = persistedRead.ok ? persistedRead.message : null;
  const latest = persisted ? chooseAuthoritativeMessage(message, persisted) : message;
  let latestIsPersisted = persisted?.id === latest.id;
  if (latest === message && persisted?.id !== message.id && typeof window !== 'undefined') {
    const storageKey = message.type === 'access' ? ACCESS_SYNC_STORAGE_KEY : SYNC_STORAGE_KEY;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(message));
      latestIsPersisted = true;
    } catch { /* channel still applies without persisted-snapshot authority */ }
  }
  if (!rememberMessage(latest.id)) return;
  applyMessage(latest, latestIsPersisted);
}

function chooseAuthoritativeMessage(incoming: SessionMessage, persisted: SessionMessage): SessionMessage {
  if (!sameSessionFamily(incoming, persisted)) {
    return compareRevision(persisted.sessionRevision, incoming.sessionRevision) >= 0
      ? persisted
      : incoming;
  }
  if (incoming.type === 'access' || persisted.type === 'access') {
    return compareRevision(persisted.revision, incoming.revision) >= 0 ? persisted : incoming;
  }
  if (incoming.type === 'logout') return incoming;
  if (persisted.type === 'logout') return persisted;
  return compareRevision(persisted.revision, incoming.revision) >= 0 ? persisted : incoming;
}

function applyMessage(message: SessionMessage, allowPersistedNewFamily = false): void {
  const current = useAuthStore.getState();
  const activeSessionIdentityCollision = activeSession
    ? sessionFamilyIdentityCollision(activeSession, message)
    : false;
  if (activeSessionIdentityCollision) {
    if (allowPersistedNewFamily) {
      discardPersistedMessageIfExact(
        message.type === 'access' ? ACCESS_SYNC_STORAGE_KEY : SYNC_STORAGE_KEY,
        message.id,
      );
      forceAnonymousLocalSession();
    }
    return;
  }
  if (message.type === 'access') {
    if (activeSession?.sessionId === message.sessionId
      && compareRevision(activeSession.sessionRevision, message.sessionRevision) === 0
      && activeSession.principalId === message.principalId
      && current.user?.id === message.principalId
      && message.accessRevision > activeSession.accessRevision) {
      observeRevision(message.revision);
      activeSession = {
        ...activeSession,
        revision: compareRevision(message.revision, activeSession.revision) > 0
          ? message.revision
          : activeSession.revision,
        accessRevision: message.accessRevision,
      };
      resetCurrentPrincipalAccessQueries();
    }
    return;
  }
  if (message.type === 'logout') {
    const qualifiedCurrentSession = activeSession?.sessionId === message.sessionId
      && compareRevision(activeSession.sessionRevision, message.sessionRevision) === 0
      && activeSession.principalId === message.principalId
      && current.user?.id === message.principalId;
    const authoritativePersistedLogout = allowPersistedNewFamily && (
      !activeSession
      || activeSession.sessionId === message.sessionId
      || compareRevision(message.sessionRevision, activeSession.sessionRevision) > 0
    );
    if (!qualifiedCurrentSession && !authoritativePersistedLogout) return;
    observeRevision(message.revision);
    clearPrincipalQueryState();
    current.clearAuth();
    activeSession = null;
    groupMembershipOverrides.clear();
    return;
  }
  if (message.principalId !== message.user.id) return;
  if (message.transition !== 'login') {
    if (!activeSession) {
      if (!allowPersistedNewFamily) return;
    } else if (activeSession.sessionId === message.sessionId) {
      if (compareRevision(message.revision, activeSession.revision) <= 0) return;
    } else if (!allowPersistedNewFamily
      || compareRevision(message.sessionRevision, activeSession.sessionRevision) <= 0) {
      return;
    }
  } else if (activeSession) {
    if (activeSession.sessionId === message.sessionId) {
      if (compareRevision(message.revision, activeSession.revision) <= 0) return;
    } else if (compareRevision(message.sessionRevision, activeSession.sessionRevision) <= 0) {
      return;
    }
  }
  observeRevision(message.revision);
  if (shouldClearPrincipalState(current.user, message.user)) clearPrincipalQueryState();
  current.applyExternalAuth(
    message.accessToken,
    message.refreshToken,
    message.refreshRequestId,
    message.user,
    message.status,
    message.authError,
  );
  groupMembershipOverrides.clear();
  activeSession = {
    sessionId: message.sessionId,
    principalId: message.principalId,
    sessionRevision: message.sessionRevision,
    revision: message.revision,
    accessRevision: message.accessRevision,
  };
}

function sameSessionFamily(
  left: Pick<SessionMessage, 'sessionId' | 'sessionRevision' | 'principalId'>,
  right: Pick<SessionMessage, 'sessionId' | 'sessionRevision' | 'principalId'>,
): boolean {
  return left.sessionId === right.sessionId
    && left.principalId === right.principalId
    && compareRevision(left.sessionRevision, right.sessionRevision) === 0;
}

function sessionFamilyIdentityCollision(
  left: Pick<SessionMessage, 'sessionId' | 'sessionRevision' | 'principalId'>,
  right: Pick<SessionMessage, 'sessionId' | 'sessionRevision' | 'principalId'>,
): boolean {
  return !sameSessionFamily(left, right) && (
    left.sessionId === right.sessionId
    || compareRevision(left.sessionRevision, right.sessionRevision) === 0
  );
}

function emit(message: SessionMessage): boolean {
  rememberMessage(message.id);
  let persisted = true;
  let shouldPost = true;
  if (typeof window !== 'undefined') {
    const existing = message.type === 'access'
      ? readPersistedAccessMessage()
      : readPersistedSessionMessage();
    if (!existing.ok) {
      persisted = false;
    } else if (existing.message
      && chooseAuthoritativeMessage(message, existing.message) === existing.message) {
      // Never let a late writer replace a newer session family/access revision.
      persisted = false;
      shouldPost = false;
    }
    try {
      if (persisted) {
        // Persist first so asynchronous channel/event delivery can reconcile
        // against the origin-wide last writer.
        const storageKey = message.type === 'access' ? ACCESS_SYNC_STORAGE_KEY : SYNC_STORAGE_KEY;
        window.localStorage.setItem(storageKey, JSON.stringify(message));
        const verified = message.type === 'access'
          ? readPersistedAccessMessage()
          : readPersistedSessionMessage();
        if (!verified.ok || verified.message?.id !== message.id) {
          persisted = false;
          if (verified.message
            && chooseAuthoritativeMessage(message, verified.message) === verified.message) {
            shouldPost = false;
          }
        }
      }
    } catch {
      persisted = false;
    }
  }
  if (shouldPost) {
    try { channel?.postMessage(message); } catch { /* durable storage events still synchronize */ }
  }
  return persisted;
}

export function initializeAuthSync(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  ensureActiveSessionMetadata();
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (isSessionMessage(event.data)) handleMessage(event.data);
    });
  }
  window.addEventListener('storage', (event) => {
    if ((event.key !== SYNC_STORAGE_KEY && event.key !== ACCESS_SYNC_STORAGE_KEY) || !event.newValue) return;
    try {
      const value: unknown = JSON.parse(event.newValue);
      if (isSessionMessage(value)) handleMessage(value);
    } catch {
      // Ignore malformed messages written by older or unrelated clients.
    }
  });
}

function isSessionMessage(value: unknown): value is SessionMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionMessage>;
  if (!isSessionMessageIdentity(candidate.id) || !isSessionMessageIdentity(candidate.source)
    || !isSessionMessageIdentity(candidate.sessionId) || !isSessionMessageIdentity(candidate.principalId)
    || !isSessionRevision(candidate.sessionRevision) || !isSessionRevision(candidate.revision)) return false;
  if (compareRevision(candidate.revision, candidate.sessionRevision) < 0) return false;
  if (candidate.source !== candidate.revision.source) return false;
  if (candidate.type === 'logout') return true;
  if (candidate.type === 'access') return isAccessRevision(candidate.accessRevision)
    && candidate.accessRevision <= candidate.revision.clock;
  return candidate.type === 'session'
    && (candidate.transition === 'login' || candidate.transition === 'refresh'
      || candidate.transition === 'pending-user' || candidate.transition === 'current-user')
    && isAccessRevision(candidate.accessRevision)
    && candidate.accessRevision <= candidate.revision.clock
    && isRefreshRequestId(candidate.refreshRequestId)
    && isRuntimeUserDto(candidate.user)
    && candidate.user.id === candidate.principalId
    && isPersistedAuthCredentials(candidate)
    && isRuntimeAuthStatus(candidate.status)
    && candidate.status !== 'anonymous'
    && isRuntimeAuthError(candidate.authError);
}

function isSessionMessageIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isAccessRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    && (value as number) <= MAX_COORDINATION_REVISION;
}

function isSessionRevision(value: unknown): value is SessionRevision {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionRevision>;
  return Number.isSafeInteger(candidate.clock) && (candidate.clock ?? -1) >= 0
    && (candidate.clock ?? Number.MAX_SAFE_INTEGER) <= MAX_COORDINATION_REVISION
    && isSessionMessageIdentity(candidate.source);
}

/**
 * Storage events may be delivered after a waiting tab acquires the refresh
 * lock. Read the transport record synchronously before using or revoking the
 * captured token so a valid successor always wins over stale R1 state.
 */
export function adoptPersistedSessionIfChanged(
  expectedRefreshToken: string,
  expectedRefreshRequestId = useAuthStore.getState().refreshRequestId,
): boolean {
  if (typeof window === 'undefined') return false;
  const persisted = readPersistedSessionMessage();
  if (!persisted.ok) throw new AuthSessionCoordinationError();
  const message = persisted.message;
  if (!message) return false;
  ensureActiveSessionMetadata();
  if (message.type === 'session' && message.refreshToken === expectedRefreshToken
    && message.refreshRequestId === expectedRefreshRequestId
    && activeSession?.sessionId === message.sessionId
    && compareRevision(message.revision, activeSession.revision) <= 0) return false;
  // Force adoption even if this message ID was observed earlier: the lock
  // check is comparing authoritative transport state, not event delivery.
  applyMessage(message, true);
  const current = useAuthStore.getState();
  return current.refreshToken !== expectedRefreshToken
    || current.refreshRequestId !== expectedRefreshRequestId;
}

function readPersistedSessionMessage(): { ok: boolean; message: SessionMessage | null } {
  if (typeof window === 'undefined') return { ok: true, message: null };
  try {
    const raw = window.localStorage.getItem(SYNC_STORAGE_KEY);
    if (!raw) return { ok: true, message: null };
    const value: unknown = JSON.parse(raw);
    return { ok: true, message: isSessionMessage(value) && value.type !== 'access' ? value : null };
  } catch {
    return { ok: false, message: null };
  }
}

function readPersistedAccessMessage(): { ok: boolean; message: SessionMessage | null } {
  if (typeof window === 'undefined') return { ok: true, message: null };
  try {
    const raw = window.localStorage.getItem(ACCESS_SYNC_STORAGE_KEY);
    if (!raw) return { ok: true, message: null };
    const value: unknown = JSON.parse(raw);
    return { ok: true, message: isSessionMessage(value) && value.type === 'access' ? value : null };
  } catch {
    return { ok: false, message: null };
  }
}

function discardPersistedMessageIfExact(storageKey: string, messageId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || (value as { id?: unknown }).id !== messageId) return;
    window.localStorage.removeItem(storageKey);
  } catch {
    // The caller remains locally fail-closed even when corrupt storage cannot
    // be repaired. A later login preflight will reject unavailable storage.
  }
}

function adoptPersistedSessionSupporting(
  message: Pick<SessionMessage, 'sessionId' | 'sessionRevision' | 'principalId'>,
): 'adopted' | 'unmatched' | 'unreadable' {
  const persisted = readPersistedSessionMessage();
  if (!persisted.ok) return 'unreadable';
  if (persisted.message?.type !== 'session' || !sameSessionFamily(persisted.message, message)) {
    return 'unmatched';
  }
  applyMessage(persisted.message, true);
  const current = useAuthStore.getState();
  return current.user && activeSession && sameSessionFamily(activeSession, message)
    ? 'adopted'
    : 'unmatched';
}

function ensureActiveSessionMetadata(): void {
  if (activeSession) return;
  const state = useAuthStore.getState();
  if (!state.user || !state.refreshToken) return;
  const persisted = readPersistedSessionMessage();
  if (persisted.ok && persisted.message?.type === 'session'
    && persisted.message.principalId === state.user.id
    && persisted.message.refreshToken === state.refreshToken) {
    activeSession = {
      sessionId: persisted.message.sessionId,
      principalId: persisted.message.principalId,
      sessionRevision: persisted.message.sessionRevision,
      revision: persisted.message.revision,
      accessRevision: persisted.message.accessRevision,
    };
  }
}

/** Ensure a reload migrated from the old transport format has a safe record. */
export function ensureAuthoritativeSessionRecord(): void {
  if (!isPersistedAuthCredentials(useAuthStore.getState())) {
    forceAnonymousLocalSession();
    return;
  }
  ensureActiveSessionMetadata();
  let state = useAuthStore.getState();
  if (!state.user || !state.accessToken || !state.refreshToken) return;
  const persisted = readPersistedSessionMessage();
  if (!persisted.ok) throw new AuthSessionCoordinationError();
  if (persisted.message) {
    applyMessage(persisted.message, true);
    const adopted = useAuthStore.getState();
    if (adopted.refreshToken !== state.refreshToken) return;
    state = adopted;
  }
  if (!state.user || !state.accessToken || !state.refreshToken) return;
  if (!isRefreshRequestId(state.refreshRequestId)) {
    const persistedRequestId = persisted.message?.type === 'session'
      && persisted.message.refreshToken === state.refreshToken
      ? persisted.message.refreshRequestId
      : null;
    const refreshRequestId = persistedRequestId ?? createRefreshRequestId();
    if (!state.setRefreshRequestId(state.refreshToken, refreshRequestId)) {
      throw new AuthSessionCoordinationError();
    }
    state = useAuthStore.getState();
  }
  if (!state.user || !state.accessToken || !state.refreshToken
    || !isRefreshRequestId(state.refreshRequestId)) throw new AuthSessionCoordinationError();
  if (activeSession && persisted.message?.type === 'session'
    && persisted.message.sessionId === activeSession.sessionId
    && persisted.message.refreshToken === state.refreshToken
    && persisted.message.refreshRequestId === state.refreshRequestId) return;
  const sessionRevision = nextFamilyRevision(persisted.message);
  activeSession = {
    sessionId: randomId(),
    principalId: state.user.id,
    sessionRevision,
    revision: sessionRevision,
    accessRevision: 0,
  };
  if (!broadcastCurrentSession('login')) throw new AuthSessionCoordinationError();
}

function broadcastCurrentSession(transition: SessionTransition): boolean {
  const state = useAuthStore.getState();
  if (!state.accessToken || !state.refreshToken || !isRefreshRequestId(state.refreshRequestId)
    || !state.user || !activeSession) return false;
  const persisted = readPersistedSessionMessage();
  const persistedMessage = persisted.ok ? persisted.message : null;
  if (transition !== 'login' && persistedMessage) {
    const sameSession = persistedMessage.sessionId === activeSession.sessionId;
    const persistedSessionIsNewer = compareRevision(
      persistedMessage.sessionRevision,
      activeSession.sessionRevision,
    ) > 0;
    if (persistedMessage.type === 'logout' && sameSession) {
      applyMessage(persistedMessage, true);
      return false;
    }
    if (!sameSession && persistedSessionIsNewer) {
      applyMessage(persistedMessage, true);
      return false;
    }
  }
  const sameFamilyPersistedMessage = persistedMessage
    && sameSessionFamily(persistedMessage, activeSession)
    ? persistedMessage
    : null;
  let revision: SessionRevision;
  try {
    revision = nextRevision(sameFamilyPersistedMessage);
  } catch {
    return false;
  }
  const message: SessionMessage = {
    id: randomId(),
    source: sourceId,
    type: 'session',
    sessionId: activeSession.sessionId,
    principalId: state.user.id,
    sessionRevision: activeSession.sessionRevision,
    revision,
    transition,
    accessRevision: activeSession.accessRevision,
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    refreshRequestId: state.refreshRequestId,
    user: state.user,
    status: state.status,
    authError: state.authError,
  };
  if (!emit(message)) {
    const latest = readPersistedSessionMessage();
    if (latest.ok && latest.message
      && chooseAuthoritativeMessage(message, latest.message) === latest.message) {
      applyMessage(latest.message, true);
    }
    return false;
  }
  activeSession = { ...activeSession, principalId: state.user.id, revision };
  return true;
}

function forceAnonymousLocalSession(): void {
  try { clearPrincipalQueryState(); } catch { /* memory auth state still fails closed below */ }
  const epoch = useAuthStore.getState().epoch + 1;
  try {
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      refreshRequestId: null,
      user: null,
      epoch,
      status: 'anonymous',
      authError: null,
    });
  } catch {
    // Zustand updates memory before its persistence adapter runs.  A failing
    // adapter must not turn cleanup failure into an authenticated in-memory
    // session; the explicit state above is therefore still authoritative.
  }
  activeSession = null;
  groupMembershipOverrides.clear();
}

function failClosedAfterBroadcastFailure(
  attemptedRefreshToken: string,
  attemptedRefreshRequestId: string,
): never {
  let adoptedAnotherSession = false;
  try {
    adoptedAnotherSession = adoptPersistedSessionIfChanged(
      attemptedRefreshToken,
      attemptedRefreshRequestId,
    );
  } catch {
    // The failed persistence read is the reason to clear the attempted session.
  }
  const current = useAuthStore.getState();
  if (!adoptedAnotherSession
    || current.refreshToken === attemptedRefreshToken
    || current.refreshRequestId === attemptedRefreshRequestId) {
    forceAnonymousLocalSession();
  }
  throw new AuthSessionCoordinationError();
}

export function installLoginSession(
  accessToken: string,
  refreshToken: string,
  user: UserDto,
  refreshRequestId = createRefreshRequestId(),
): void {
  if (!isRefreshRequestId(refreshRequestId)) throw new AuthSessionCoordinationError();
  try {
    groupMembershipOverrides.clear();
    clearPrincipalQueryState();
    useAuthStore.getState().setAuth(accessToken, refreshToken, refreshRequestId, user);
    const persisted = readPersistedSessionMessage();
    if (!persisted.ok) throw new AuthSessionCoordinationError();
    const sessionRevision = nextFamilyRevision(persisted.message);
    activeSession = {
      sessionId: randomId(),
      principalId: user.id,
      sessionRevision,
      revision: sessionRevision,
      accessRevision: 0,
    };
    if (!broadcastCurrentSession('login')) {
      failClosedAfterBroadcastFailure(refreshToken, refreshRequestId);
    }
  } catch (error) {
    const current = useAuthStore.getState();
    if (current.refreshToken === refreshToken || current.refreshRequestId === refreshRequestId) {
      forceAnonymousLocalSession();
    }
    if (error instanceof AuthSessionCoordinationError) throw error;
    throw new AuthSessionCoordinationError();
  }
}

export function commitRefreshedSession(
  expectedEpoch: number,
  expectedRefreshToken: string,
  expectedRefreshRequestId: string,
  accessToken: string,
  refreshToken: string,
  refreshRequestId: string,
  user: UserDto,
): boolean {
  adoptPersistedSessionIfChanged(expectedRefreshToken, expectedRefreshRequestId);
  const previous = useAuthStore.getState().user;
  if (shouldClearPrincipalState(previous, user)) clearPrincipalQueryState();
  const committed = useAuthStore.getState().commitRefresh(
    expectedEpoch,
    expectedRefreshToken,
    expectedRefreshRequestId,
    accessToken,
    refreshToken,
    refreshRequestId,
    user,
  );
  if (!committed) return false;
  groupMembershipOverrides.clear();
  if (!broadcastCurrentSession('refresh')) {
    failClosedAfterBroadcastFailure(refreshToken, refreshRequestId);
  }
  return true;
}

export function commitRefreshPendingUser(
  expectedEpoch: number,
  expectedRefreshToken: string,
  expectedRefreshRequestId: string,
  accessToken: string,
  refreshToken: string,
  refreshRequestId: string,
  message: string,
): boolean {
  adoptPersistedSessionIfChanged(expectedRefreshToken, expectedRefreshRequestId);
  const committed = useAuthStore.getState().commitRefreshPendingUser(
    expectedEpoch,
    expectedRefreshToken,
    expectedRefreshRequestId,
    accessToken,
    refreshToken,
    refreshRequestId,
    message,
  );
  if (!committed) return false;
  if (!broadcastCurrentSession('pending-user')) {
    failClosedAfterBroadcastFailure(refreshToken, refreshRequestId);
  }
  return true;
}

export function commitFreshCurrentUser(expectedEpoch: number, expectedAccessToken: string, user: UserDto): boolean {
  const expectedRefreshToken = useAuthStore.getState().refreshToken;
  if (expectedRefreshToken) adoptPersistedSessionIfChanged(expectedRefreshToken);
  const previous = useAuthStore.getState().user;
  if (shouldClearPrincipalState(previous, user)) clearPrincipalQueryState();
  const committed = useAuthStore.getState().commitCurrentUser(expectedEpoch, expectedAccessToken, user);
  if (!committed) return false;
  groupMembershipOverrides.clear();
  return broadcastCurrentSession('current-user');
}

export interface CapturedSession {
  accessToken: string | null;
  refreshToken: string | null;
}

export function clearLocalSession(broadcast = true): CapturedSession {
  const state = useAuthStore.getState();
  let captured = { accessToken: state.accessToken, refreshToken: state.refreshToken };
  try { ensureActiveSessionMetadata(); } catch { /* captured tokens remain revocable */ }
  let terminating = activeSession;
  if (broadcast && terminating) {
    const persisted = readPersistedSessionMessage();
    const identityConflict = Boolean(persisted.ok && persisted.message
      && sessionFamilyIdentityCollision(persisted.message, terminating));
    if (identityConflict && persisted.message) {
      try { applyMessage(persisted.message, true); } catch { /* local cleanup below remains authoritative */ }
    } else if (persisted.ok && persisted.message?.type === 'session'
      && persisted.message.sessionId !== terminating.sessionId
      && compareRevision(persisted.message.sessionRevision, terminating.sessionRevision) > 0) {
      try { applyMessage(persisted.message, true); } catch { /* retain the revocable captured predecessor */ }
      const adopted = useAuthStore.getState();
      if (activeSession?.sessionId === persisted.message.sessionId
        && adopted.refreshToken === persisted.message.refreshToken) return captured;
    }
    if (persisted.ok && persisted.message?.type === 'session'
      && persisted.message.sessionId === terminating.sessionId
      && compareRevision(persisted.message.revision, terminating.revision) > 0) {
      // A background tab may have rotated this same refresh family more than
      // once while this tab was suspended. Reconcile synchronously before
      // cleanup so server revocation uses the authoritative successor; a
      // different, newer login remains protected by the branch above.
      try { applyMessage(persisted.message, true); } catch { /* retain the revocable captured predecessor */ }
      const reconciled = useAuthStore.getState();
      if (activeSession?.sessionId === terminating.sessionId
        && reconciled.refreshToken === persisted.message.refreshToken) {
        captured = {
          accessToken: reconciled.accessToken,
          refreshToken: reconciled.refreshToken,
        };
        terminating = activeSession;
      }
    }
  }
  forceAnonymousLocalSession();
  if (broadcast && terminating) {
    const persisted = readPersistedSessionMessage();
    let message: SessionMessage | null = null;
    try {
      message = {
        id: randomId(),
        source: sourceId,
        type: 'logout',
        sessionId: terminating.sessionId,
        principalId: terminating.principalId,
        sessionRevision: terminating.sessionRevision,
        revision: nextRevision(
          persisted.message && sameSessionFamily(persisted.message, terminating)
            ? persisted.message
            : null,
        ),
      };
    } catch {
      // Local cleanup and server revocation still proceed. Preserve the last
      // valid persisted envelope rather than replacing it with an unsafe one.
    }
    if (!message) return captured;
    if (!emit(message)) {
      const latest = readPersistedSessionMessage();
      if (latest.ok && latest.message
        && chooseAuthoritativeMessage(message, latest.message) === latest.message) {
        try { applyMessage(latest.message, true); } catch { /* best-effort adoption after local cleanup */ }
      }
    }
  }
  return captured;
}

/** Notify this browser profile only when a mutation affects its own grants. */
export function notifyCurrentPrincipalAccessChanged(): void {
  ensureActiveSessionMetadata();
  const initialState = useAuthStore.getState();
  const notifyingFamily = activeSession;
  if (!initialState.user || !notifyingFamily) return;
  const persisted = readPersistedSessionMessage();
  const persistedAccess = readPersistedAccessMessage();
  if (!persisted.ok || !persistedAccess.ok) {
    forceAnonymousLocalSession();
    return;
  }
  const persistedMessage = persisted.ok ? persisted.message : null;
  const persistedAccessMessage = persistedAccess.ok ? persistedAccess.message : null;
  const persistedSessionCollision = Boolean(persistedMessage
    && sessionFamilyIdentityCollision(persistedMessage, notifyingFamily));
  if (persistedSessionCollision && persistedMessage && persistedAccessMessage
    && sameSessionFamily(persistedAccessMessage, persistedMessage)) {
    discardPersistedMessageIfExact(ACCESS_SYNC_STORAGE_KEY, persistedAccessMessage.id);
  }
  if (persistedMessage) applyMessage(persistedMessage, true);
  const state = useAuthStore.getState();
  if (!state.user || !activeSession
    || state.user.id !== initialState.user.id
    || !sameSessionFamily(activeSession, notifyingFamily)) return;
  resetCurrentPrincipalAccessQueries();
  if (persistedAccessMessage && !sameSessionFamily(persistedAccessMessage, activeSession)
    && (persistedAccessMessage.sessionId === activeSession.sessionId
      || compareRevision(persistedAccessMessage.sessionRevision, activeSession.sessionRevision) >= 0)) {
    const collision = sessionFamilyIdentityCollision(persistedAccessMessage, activeSession);
    if (collision) {
      discardPersistedMessageIfExact(ACCESS_SYNC_STORAGE_KEY, persistedAccessMessage.id);
      forceAnonymousLocalSession();
      return;
    }
    const support = adoptPersistedSessionSupporting(persistedAccessMessage);
    if (support === 'adopted') {
      applyMessage(persistedAccessMessage, true);
      return;
    }
    if (support === 'unmatched') {
      discardPersistedMessageIfExact(ACCESS_SYNC_STORAGE_KEY, persistedAccessMessage.id);
    }
    forceAnonymousLocalSession();
    return;
  }
  const authoritativeSessionMessage = persistedMessage
    && sameSessionFamily(persistedMessage, activeSession)
    ? persistedMessage
    : null;
  const authoritativeAccessMessage = persistedAccessMessage
    && sameSessionFamily(persistedAccessMessage, activeSession)
    ? persistedAccessMessage
    : null;
  const latestObserved = authoritativeAccessMessage
    && (!authoritativeSessionMessage
      || compareRevision(authoritativeAccessMessage.revision, authoritativeSessionMessage.revision) > 0)
    ? authoritativeAccessMessage
    : authoritativeSessionMessage;
  let revision: SessionRevision;
  try {
    revision = nextRevision(latestObserved);
  } catch {
    forceAnonymousLocalSession();
    return;
  }
  const sameSessionAccessRevision = authoritativeAccessMessage?.type === 'access'
    ? authoritativeAccessMessage.accessRevision
    : 0;
  const accessRevision = Math.max(
    activeSession.accessRevision + 1,
    sameSessionAccessRevision + 1,
    revision.clock,
  );
  if (!isAccessRevision(accessRevision)) {
    forceAnonymousLocalSession();
    return;
  }
  const message: SessionMessage = {
    id: randomId(),
    source: sourceId,
    type: 'access',
    sessionId: activeSession.sessionId,
    principalId: state.user.id,
    sessionRevision: activeSession.sessionRevision,
    revision,
    accessRevision,
  };
  if (!emit(message)) {
    const latest = readPersistedAccessMessage();
    if (latest.ok && latest.message
      && sameSessionFamily(latest.message, activeSession)
      && chooseAuthoritativeMessage(message, latest.message) === latest.message) {
      applyMessage(latest.message, true);
    } else {
      if (latest.ok && latest.message) {
        const collision = sessionFamilyIdentityCollision(latest.message, activeSession);
        if (collision) {
          discardPersistedMessageIfExact(ACCESS_SYNC_STORAGE_KEY, latest.message.id);
        } else {
          const support = adoptPersistedSessionSupporting(latest.message);
          if (support === 'adopted') {
            applyMessage(latest.message, true);
            return;
          }
          if (support === 'unmatched') {
            discardPersistedMessageIfExact(ACCESS_SYNC_STORAGE_KEY, latest.message.id);
          }
        }
      }
      forceAnonymousLocalSession();
    }
    return;
  }
  activeSession = { ...activeSession, revision, accessRevision };
}

export type AccessMutationSubject = { type: 'user' | 'group'; id: string };

export function notifyAccessChangedForSubject(subject: AccessMutationSubject): boolean {
  const current = useAuthStore.getState().user;
  const affected = Boolean(current && (
    (subject.type === 'user' && subject.id === current.id)
    || (subject.type === 'group'
      && (groupMembershipOverrides.get(subject.id)
        ?? current.groups.some((group) => group.id === subject.id)))
  ));
  if (affected) notifyCurrentPrincipalAccessChanged();
  return affected;
}

export function notifyGroupMembershipChangedForUser(
  userId: string,
  groupId: string,
  isMember: boolean,
): boolean {
  const current = useAuthStore.getState().user;
  if (!current || current.id !== userId) return false;
  groupMembershipOverrides.set(groupId, isMember);
  notifyCurrentPrincipalAccessChanged();
  return true;
}

export async function withCrossTabRefreshLock<T>(callback: (ownsLock: () => boolean) => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(REFRESH_LOCK_NAME, () => callback(() => true));
  }
  if (typeof window === 'undefined') return callback(() => true);
  return withStorageRefreshLease(callback);
}

async function withStorageRefreshLease<T>(callback: (ownsLock: () => boolean) => Promise<T>): Promise<T> {
  const owner = `${sourceId}:${randomId()}`;
  for (;;) {
    const now = Date.now();
    const existingRead = readRefreshLease();
    if (!existingRead.ok) throw new AuthSessionCoordinationError();
    const existing = existingRead.lease;
    if (!existing || existing.expiresAt <= now) {
      const lease = createRefreshLease(owner, now);
      try {
        window.localStorage.setItem(REFRESH_LOCK_KEY, JSON.stringify(lease));
      } catch {
        throw new AuthSessionCoordinationError();
      }
      const acquired = readRefreshLease();
      if (!acquired.ok) throw new AuthSessionCoordinationError();
      if (acquired.lease?.owner === owner) {
        let ownershipLost = false;
        const ownsLock = () => {
          const current = readRefreshLease();
          return !ownershipLost && current.ok && current.lease?.owner === owner
            && current.lease.expiresAt > Date.now();
        };
        const heartbeat = window.setInterval(() => {
          if (!ownsLock()) {
            ownershipLost = true;
            window.clearInterval(heartbeat);
            return;
          }
          try {
            window.localStorage.setItem(REFRESH_LOCK_KEY, JSON.stringify(createRefreshLease(owner, Date.now())));
          } catch {
            ownershipLost = true;
            window.clearInterval(heartbeat);
          }
        }, REFRESH_LEASE_HEARTBEAT_MS);
        try {
          return await callback(ownsLock);
        } finally {
          window.clearInterval(heartbeat);
          const current = readRefreshLease();
          if (current.ok && current.lease?.owner === owner) {
            try { window.localStorage.removeItem(REFRESH_LOCK_KEY); } catch { /* already fail-closed */ }
          }
        }
      }
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 75));
  }
}

function createRefreshLease(owner: string, now: number): RefreshLease {
  return { owner, expiresAt: now + REFRESH_LEASE_DURATION_MS };
}

function readRefreshLease(): { ok: boolean; lease: RefreshLease | null } {
  try {
    const raw = window.localStorage.getItem(REFRESH_LOCK_KEY);
    if (!raw) return { ok: true, lease: null };
    const parsed = JSON.parse(raw) as Partial<RefreshLease>;
    return { ok: true, lease: typeof parsed.owner === 'string' && typeof parsed.expiresAt === 'number'
      ? { owner: parsed.owner, expiresAt: parsed.expiresAt }
      : null };
  } catch {
    return { ok: false, lease: null };
  }
}

export const authSessionTestables = {
  userAuthorizationFingerprint,
  shouldClearPrincipalState,
  createRefreshRequestId,
  isRefreshRequestId,
  createRefreshLease,
  refreshLeaseDurationMs: REFRESH_LEASE_DURATION_MS,
  refreshLeaseHeartbeatMs: REFRESH_LEASE_HEARTBEAT_MS,
  syncStorageKey: SYNC_STORAGE_KEY,
  accessSyncStorageKey: ACCESS_SYNC_STORAGE_KEY,
  refreshLockKey: REFRESH_LOCK_KEY,
  receiveMessage: handleMessage,
  isSessionMessage,
  compareRevision,
  chooseAuthoritativeMessage,
  resetForTests: () => {
    activeSession = null;
    logicalClock = 0;
    groupMembershipOverrides.clear();
  },
};
