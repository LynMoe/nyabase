import { Capability, UserStatus, type UserDto } from '@nyabase/common';

const USER_STATUSES = new Set<string>(Object.values(UserStatus));
const CAPABILITIES = new Set<string>(Object.values(Capability));

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
    && typeof group.isSystem === 'boolean');
}
