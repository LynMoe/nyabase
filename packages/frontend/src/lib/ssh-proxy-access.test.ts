import { describe, expect, it } from 'vitest';
import { Capability } from '@nyabase/common';
import {
  SSH_PROXY_STATUS_CAPABILITIES,
  canViewSshProxyStatus,
} from './ssh-proxy-access.js';

describe('SSH proxy page access', () => {
  it.each([
    Capability.ViewMetricsAll,
    Capability.ViewAudit,
    Capability.ManageSystemSettings,
  ])('matches the backend status capability %s', (capability) => {
    expect(canViewSshProxyStatus([capability])).toBe(true);
    expect(SSH_PROXY_STATUS_CAPABILITIES).toContain(capability);
  });

  it('does not grant unrelated administration capabilities', () => {
    expect(canViewSshProxyStatus([])).toBe(false);
    expect(canViewSshProxyStatus([Capability.ManageServers])).toBe(false);
  });
});
