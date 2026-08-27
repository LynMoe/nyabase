import { describe, expect, it } from 'vitest';
import { Capability } from '@nyabase/common';
import {
  HTTP_PROXY_STATUS_CAPABILITIES,
  canManageHttpProxyPools,
  canViewHttpProxyStatus,
} from './http-proxy-access.js';

describe('HTTP proxy page access', () => {
  it.each([
    Capability.ViewMetricsAll,
    Capability.ViewAudit,
    Capability.ManageSystemSettings,
  ])('matches the backend status capability %s', (capability) => {
    expect(canViewHttpProxyStatus([capability])).toBe(true);
    expect(HTTP_PROXY_STATUS_CAPABILITIES).toContain(capability);
  });

  it('does not grant unrelated administration capabilities', () => {
    expect(canViewHttpProxyStatus([])).toBe(false);
    expect(canViewHttpProxyStatus([Capability.ManageServers])).toBe(false);
    expect(canManageHttpProxyPools([Capability.ViewMetricsAll])).toBe(false);
    expect(canManageHttpProxyPools([Capability.ManageSystemSettings])).toBe(true);
  });
});
