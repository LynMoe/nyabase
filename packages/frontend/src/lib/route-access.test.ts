import { describe, expect, it } from 'vitest';
import { Role } from '@nyabase/common';
import { ACCESS, canAccess } from './route-access.js';

describe('role-based route access', () => {
  it('nests roles: admin sees everything an operator sees', () => {
    for (const rule of Object.values(ACCESS)) {
      if (canAccess(Role.Operator, rule)) expect(canAccess(Role.Admin, rule)).toBe(true);
    }
  });

  it('never opens an admin surface to a plain user', () => {
    for (const rule of Object.values(ACCESS)) expect(canAccess(Role.User, rule)).toBe(false);
    for (const rule of Object.values(ACCESS)) expect(canAccess(undefined, rule)).toBe(false);
  });

  it('lets operators view and manage the SSH and HTTP proxy pages, not plain users', () => {
    for (const rule of [ACCESS.sshProxy, ACCESS.httpProxyOps]) {
      expect(canAccess(Role.Operator, rule)).toBe(true);
      expect(canAccess(Role.Admin, rule)).toBe(true);
      expect(canAccess(Role.User, rule)).toBe(false);
    }
  });

  it('keeps platform-wide resources admin-only and operations operator-level', () => {
    expect(canAccess(Role.Operator, ACCESS.ipPools)).toBe(false);
    expect(canAccess(Role.Operator, ACCESS.sharedBackends)).toBe(false);
    expect(canAccess(Role.Admin, ACCESS.ipPools)).toBe(true);
    for (const rule of [ACCESS.servers, ACCESS.images, ACCESS.manageContainers, ACCESS.audit,
      ACCESS.systemSettings, ACCESS.users, ACCESS.groups, ACCESS.ops, ACCESS.adminUsage]) {
      expect(canAccess(Role.Operator, rule)).toBe(true);
    }
  });
});
