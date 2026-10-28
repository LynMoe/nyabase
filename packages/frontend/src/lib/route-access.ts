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
  servers: Role.Admin,
  network: Role.Admin,
  sharedBackends: Role.Admin,
  images: Role.Admin,
  manageContainers: Role.UserAdmin,
  manageVolumes: Role.UserAdmin,
  ops: Role.UserAdmin,
  /** The page and its connection history; live status, host keys and refusals need `sshProxyOps`. */
  sshProxy: Role.UserAdmin,
  sshProxyOps: Role.Admin,
  httpProxyOps: Role.Admin,
  adminUsage: Role.UserAdmin,
  users: Role.UserAdmin,
  grantBundles: Role.UserAdmin,
  audit: Role.UserAdmin,
  systemSettings: Role.Admin,
} as const satisfies Record<string, AccessRule>;

export function canAccess(role: Role | undefined, rule: AccessRule): boolean {
  return role !== undefined && roleAtLeast(role, rule);
}
