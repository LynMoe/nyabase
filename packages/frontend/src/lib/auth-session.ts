import { Role, type UserDto, UserStatus } from '@nyabase/common';
import { clearPrincipalQueryState } from './query-client.js';
import { useAuthStore } from '../store/auth.js';
import { api } from './api.js';
import { ApiError } from './api-error.js';

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
  return JSON.stringify([user.id, user.status, user.role]);
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

export async function runSessionTermination(
  clear: () => CapturedSession,
  revoke: (session: CapturedSession) => Promise<void>,
): Promise<void> {
  const captured = clear();
  try {
    await revoke(captured);
  } catch {
    // Local fail-closed termination is authoritative; revocation is best effort.
  }
}

/** Capture the old family, fail closed locally, then revoke only that family. */
export function terminateBrowserSession(): Promise<void> {
  return runSessionTermination(() => clearLocalSession(), api.logout);
}

export type PendingLoginReason = 'password-changed' | 'account-changed' | 'session-expired';

const STORAGE_KEY = 'nyabase.pendingLoginReason';

function isPendingLoginReason(value: string | null): value is PendingLoginReason {
  return value === 'password-changed'
    || value === 'account-changed'
    || value === 'session-expired';
}

export function setPendingLoginReason(reason: PendingLoginReason): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, reason);
  } catch {
    // sessionStorage may be unavailable; login banner is best-effort.
  }
}

export function peekPendingLoginReason(): PendingLoginReason | undefined {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    return isPendingLoginReason(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function clearPendingLoginReason(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Read and clear the pending login reason in one step. */
export function takePendingLoginReason(): PendingLoginReason | undefined {
  const reason = peekPendingLoginReason();
  clearPendingLoginReason();
  return reason;
}

const USER_STATUSES = new Set<string>(Object.values(UserStatus));
const ROLES = new Set<string>(Object.values(Role));

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
}

export function isRuntimeUserDto(value: unknown): value is UserDto {
  return isRecord(value)
    && isBoundedString(value.id, 128)
    && isBoundedString(value.username, 64)
    && isBoundedString(value.displayName, 128, true)
    && isBoundedString(value.createdAt, 64)
    && typeof value.status === 'string'
    && USER_STATUSES.has(value.status)
    && typeof value.role === 'string'
    && ROLES.has(value.role);
}

const DISABLED_ACCOUNT_RE = /disabled|user_disabled|account_disabled|停用/i;

export function loginFailureMessage(error: unknown): string {
  if (error instanceof ApiError && (error.code === 'NETWORK_ERROR' || error.status === 0)) {
    return '无法连接服务器，请检查网络后重试。';
  }
  if (error instanceof ApiError && error.status === 401) {
    return '用户名或密码错误';
  }
  if (error instanceof ApiError && error.status === 403) {
    return isDisabledAccountError(error) ? '账号已停用' : '账号不可用';
  }
  return error instanceof Error ? error.message : '登录失败，请稍后重试。';
}

function isDisabledAccountError(error: ApiError): boolean {
  return DISABLED_ACCOUNT_RE.test(`${error.code} ${error.message}`);
}

const INTERNAL_ORIGIN = 'https://nyabase.invalid';

/** Accept only same-origin absolute paths; never pass attacker-controlled URLs to navigation. */
export function sanitizeInternalRedirect(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return fallback;
  if (/\p{Cc}/u.test(candidate)) return fallback;
  try {
    let decoded = candidate;
    for (let index = 0; index < 2; index += 1) decoded = decodeURIComponent(decoded);
    if (decoded.startsWith('//') || decoded.includes('\\')) return fallback;
    const parsed = new URL(candidate, INTERNAL_ORIGIN);
    // Dot segments can collapse `/.//host` into the protocol-relative `//host`.
    if (parsed.origin !== INTERNAL_ORIGIN || parsed.pathname.startsWith('//')) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
