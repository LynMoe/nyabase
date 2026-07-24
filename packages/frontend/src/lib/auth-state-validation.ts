import { Capability, UserStatus, type UserDto } from '@nyabase/common';

const USER_STATUSES = new Set<string>(Object.values(UserStatus));
const CAPABILITIES = new Set<string>(Object.values(Capability));
const AUTH_STATUSES = new Set(['checking', 'authenticated', 'anonymous', 'error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
}

export function isRuntimeUserDto(value: unknown): value is UserDto {
  if (!isRecord(value)
    || !isBoundedString(value.id, 128)
    || !isBoundedString(value.username, 64)
    || !isBoundedString(value.displayName, 128, true)
    || !isBoundedString(value.createdAt, 64)
    || typeof value.status !== 'string'
    || !USER_STATUSES.has(value.status)
    || !Array.isArray(value.capabilities)
    || value.capabilities.length > CAPABILITIES.size
    || value.capabilities.some((capability) => typeof capability !== 'string' || !CAPABILITIES.has(capability))
    || !Array.isArray(value.groups)
    || value.groups.length > 10_000) return false;
  return value.groups.every((group) => isRecord(group)
    && isBoundedString(group.id, 128)
    && isBoundedString(group.name, 128)
    && Number.isSafeInteger(group.priority)
    && typeof group.isSystem === 'boolean');
}

export function isRuntimeAuthStatus(value: unknown): value is 'checking' | 'authenticated' | 'anonymous' | 'error' {
  return typeof value === 'string' && AUTH_STATUSES.has(value);
}

export function isRuntimeAuthError(value: unknown): value is string | null {
  return value === null || isBoundedString(value, 4_096, true);
}

export type PersistedAuthCredentials = {
  accessToken: string | null;
  refreshToken: string | null;
  refreshRequestId: string | null;
  user: UserDto | null;
};

/** Persisted credentials are either wholly anonymous or a complete validated tuple. */
export function isPersistedAuthCredentials(value: unknown): value is PersistedAuthCredentials {
  if (!isRecord(value)) return false;
  const { accessToken, refreshToken, refreshRequestId, user } = value;
  if (accessToken === null && refreshToken === null && refreshRequestId === null && user === null) return true;
  return isBoundedString(accessToken, 16_384)
    && isBoundedString(refreshToken, 512)
    // Legacy persisted sessions predate refresh request ids. They remain a
    // complete credential tuple and are migrated synchronously before use.
    && (refreshRequestId === null
      || (typeof refreshRequestId === 'string' && /^[0-9a-f]{64}$/.test(refreshRequestId)))
    && isRuntimeUserDto(user);
}
