import { Capability } from '@nyabase/common';

export const SSH_PROXY_STATUS_CAPABILITIES = [
  Capability.ViewMetricsAll,
  Capability.ViewAudit,
  Capability.ManageSystemSettings,
] as const satisfies readonly Capability[];

export function canViewSshProxyStatus(capabilities: readonly Capability[]): boolean {
  return SSH_PROXY_STATUS_CAPABILITIES.some((capability) => capabilities.includes(capability));
}
