import { Role, roleAtLeast } from '@nyabase/common';

/**
 * Who may open each admin surface: the lowest role that may (roles are nested,
 * so every higher role may too).
 *
 * This is the single source for both the sidebar and the route guards, so a
 * page is never reachable but hidden (or listed but denied).
 */
export type AccessRule = Role;

export const ACCESS = {
  servers: Role.Operator,
  ipPools: Role.Admin,
  sharedBackends: Role.Admin,
  images: Role.Operator,
  manageContainers: Role.Operator,
  ops: Role.Operator,
  sshProxy: Role.Operator,
  httpProxyOps: Role.Operator,
  adminUsage: Role.Operator,
  users: Role.Operator,
  groups: Role.Operator,
  audit: Role.Operator,
  systemSettings: Role.Operator,
} as const satisfies Record<string, AccessRule>;

export function canAccess(role: Role | undefined, rule: AccessRule): boolean {
  return role !== undefined && roleAtLeast(role, rule);
}
