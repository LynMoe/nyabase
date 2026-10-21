import type { UserDto } from '@nyabase/common';
import { clearPrincipalQueryState } from './query-client.js';
import { useAuthStore } from '../store/auth.js';

/**
 * Cross-tab session coordination.
 *
 * The refresh secret is an HttpOnly cookie shared by every tab of this
 * origin, and each tab keeps only its own in-memory access token. Tabs
 * therefore never exchange credentials; they only:
 *  - serialize refresh rotation (one rotation of the shared cookie at a time),
 *  - share the pending rotation request id so a lost response is recovered
 *    idempotently instead of spending the cookie, and
 *  - announce login/logout so other tabs re-derive or drop their state.
 */

const CHANNEL_NAME = 'nyabase-auth-session';
const REFRESH_LOCK_NAME = 'nyabase-auth-refresh';
const PENDING_REFRESH_REQUEST_KEY = 'nyabase-auth-refresh-request';

type SessionMessage = { type: 'login' | 'logout'; source: string };

export interface AuthSyncHandlers {
  /** Another tab installed a (possibly different) principal in the shared cookie. */
  onPeerLogin: () => void;
}

const sourceId = randomId();
let channel: BroadcastChannel | null = null;
let initialized = false;
let memoryPendingRequestId: string | null = null;

export class AuthSessionCoordinationError extends Error {
  constructor() {
    super('浏览器无法安全生成会话刷新标识，请更换浏览器或允许站点存储后重试');
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
 * The id for the next rotation of the shared cookie. It is reused until a
 * definitive server answer so that a retry after a lost response recovers the
 * same successor. It is an idempotency key, not a credential.
 */
export function pendingRefreshRequestId(): string {
  try {
    const stored = window.localStorage.getItem(PENDING_REFRESH_REQUEST_KEY);
    if (isRefreshRequestId(stored)) return stored;
    const created = createRefreshRequestId();
    window.localStorage.setItem(PENDING_REFRESH_REQUEST_KEY, created);
    return created;
  } catch (error) {
    if (error instanceof AuthSessionCoordinationError) throw error;
    // Without storage, recovery is limited to this tab.
    memoryPendingRequestId ??= createRefreshRequestId();
    return memoryPendingRequestId;
  }
}

/** The server has definitively answered for `requestId`; start a new one. */
export function settleRefreshRequestId(requestId: string): void {
  if (memoryPendingRequestId === requestId) memoryPendingRequestId = null;
  try {
    if (window.localStorage.getItem(PENDING_REFRESH_REQUEST_KEY) === requestId) {
      window.localStorage.removeItem(PENDING_REFRESH_REQUEST_KEY);
    }
  } catch {
    // Unavailable storage already falls back to the in-memory id above.
  }
}

/** A new login replaced the cookie, so any pending rotation id is moot. */
export function discardPendingRefreshRequestId(): void {
  memoryPendingRequestId = null;
  try { window.localStorage.removeItem(PENDING_REFRESH_REQUEST_KEY); } catch { /* nothing to discard */ }
}

export function initializeAuthSync(handlers: AuthSyncHandlers): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  if (typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data as Partial<SessionMessage> | null;
    if (!message || message.source === sourceId) return;
    if (message.type === 'logout') clearLocalSession(false);
    else if (message.type === 'login') handlers.onPeerLogin();
  });
}

function announce(type: SessionMessage['type']): void {
  try { channel?.postMessage({ type, source: sourceId } satisfies SessionMessage); } catch { /* best effort */ }
}

export function announceLogin(): void {
  announce('login');
}

function userAuthorizationFingerprint(user: UserDto | null): string {
  if (!user) return '';
  const capabilities = [...user.capabilities].sort();
  const groups = [...user.groups]
    .map((group) => `${group.id}:${group.name}:${group.isSystem}`)
    .sort();
  return JSON.stringify([user.id, user.status, capabilities, groups]);
}

export function shouldClearPrincipalState(previous: UserDto | null, next: UserDto | null): boolean {
  return userAuthorizationFingerprint(previous) !== userAuthorizationFingerprint(next);
}

export interface CapturedSession {
  accessToken: string | null;
}

/** Drop this tab's session; by default tell the other tabs to drop theirs. */
export function clearLocalSession(broadcast = true): CapturedSession {
  const captured = { accessToken: useAuthStore.getState().accessToken };
  try { clearPrincipalQueryState(); } catch { /* auth state below still fails closed */ }
  useAuthStore.getState().clearAuth();
  if (broadcast) announce('logout');
  return captured;
}

/** Serialize rotations of the shared refresh cookie across tabs. */
export async function withCrossTabRefreshLock<T>(callback: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(REFRESH_LOCK_NAME, callback);
  }
  // Every supported browser has Web Locks; without it concurrent tabs may
  // race one rotation, and the loser re-authenticates.
  return callback();
}
