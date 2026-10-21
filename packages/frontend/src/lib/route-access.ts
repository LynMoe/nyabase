import { ADMIN_INTENT_CAPABILITIES, Capability } from '@nyabase/common';
import { HTTP_PROXY_STATUS_CAPABILITIES, SSH_PROXY_STATUS_CAPABILITIES } from './proxy-access.js';

/**
 * Who may open each admin surface: any one of the listed capabilities.
 *
 * This is the single source for both the sidebar and the route guards, so a
 * page is never reachable but hidden (or listed but denied).
 */
export type AccessRule = readonly Capability[];

export const ACCESS = {
  servers: [Capability.ManageServers],
  ipPools: [Capability.ManageIpPools],
  sharedBackends: [Capability.ManageSharedBackends],
  images: [Capability.ManageImages],
  manageContainers: [Capability.ManageContainersAny],
  ops: ADMIN_INTENT_CAPABILITIES,
  sshProxy: SSH_PROXY_STATUS_CAPABILITIES,
  httpProxyOps: HTTP_PROXY_STATUS_CAPABILITIES,
  adminUsage: [Capability.ViewMetricsAll],
  users: [Capability.ManageUsers, Capability.ManageGrants],
  groups: [Capability.ManageGroups, Capability.ManageGrants],
  audit: [Capability.ViewAudit],
  systemSettings: [Capability.ManageSystemSettings],
} as const satisfies Record<string, AccessRule>;

export function canAccess(
  capabilities: readonly string[] | ReadonlySet<string> | undefined,
  rule: AccessRule,
): boolean {
  if (!capabilities) return false;
  const has = (capability: Capability) => (
    'has' in capabilities ? capabilities.has(capability) : capabilities.includes(capability)
  );
  return rule.some(has);
}
