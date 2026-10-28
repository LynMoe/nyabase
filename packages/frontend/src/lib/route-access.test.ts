import { describe, expect, it } from 'vitest';
import { Role } from '@nyabase/common';
import { ACCESS, canAccess } from './route-access.js';

describe('role-based route access', () => {
  it('nests roles: admin sees everything a user admin sees', () => {
    for (const rule of Object.values(ACCESS)) {
      if (canAccess(Role.UserAdmin, rule)) expect(canAccess(Role.Admin, rule)).toBe(true);
    }
  });

  it('never opens an admin surface to a plain user', () => {
    for (const rule of Object.values(ACCESS)) expect(canAccess(Role.User, rule)).toBe(false);
    for (const rule of Object.values(ACCESS)) expect(canAccess(undefined, rule)).toBe(false);
  });

  it('gives user admins people and their resources', () => {
    for (const rule of [ACCESS.users, ACCESS.grantBundles, ACCESS.manageContainers, ACCESS.manageVolumes,
      ACCESS.ops, ACCESS.adminUsage, ACCESS.audit, ACCESS.sshProxy]) {
      expect(canAccess(Role.UserAdmin, rule)).toBe(true);
    }
  });

  it('keeps infrastructure and system settings admin-only', () => {
    for (const rule of [ACCESS.servers, ACCESS.network, ACCESS.sharedBackends, ACCESS.images,
      ACCESS.httpProxyOps, ACCESS.sshProxyOps, ACCESS.systemSettings]) {
      expect(canAccess(Role.UserAdmin, rule)).toBe(false);
      expect(canAccess(Role.Admin, rule)).toBe(true);
    }
  });
});
