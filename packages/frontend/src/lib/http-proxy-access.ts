import { Capability } from '@nyabase/common';

/** Same capability set as SSH proxy status: metrics, audit, or system settings. */
export const HTTP_PROXY_STATUS_CAPABILITIES = [
  Capability.ViewMetricsAll,
  Capability.ViewAudit,
  Capability.ManageSystemSettings,
] as const satisfies readonly Capability[];

export function canViewHttpProxyStatus(capabilities: readonly Capability[]): boolean {
  return HTTP_PROXY_STATUS_CAPABILITIES.some((capability) => capabilities.includes(capability));
}

export function canManageHttpProxyPools(capabilities: readonly Capability[]): boolean {
  return capabilities.includes(Capability.ManageSystemSettings);
}
