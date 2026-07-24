import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Capability } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { CapabilitiesGuard } from './capabilities.guard.js';

describe('CapabilitiesGuard', () => {
  it('allows authenticated non-admin routes without capability metadata', async () => {
    const guard = makeGuard(undefined);

    await expect(guard.canActivate(makeContext('/api/v2/containers'))).resolves.toBe(true);
  });

  it('denies admin routes when capability metadata is missing', async () => {
    const guard = makeGuard(undefined);

    await expect(guard.canActivate(makeContext('/api/admin/users'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires every declared capability', async () => {
    const guard = makeGuard({
      all: [Capability.ManageUsers, Capability.ManageGroups],
      userCaps: new Set([Capability.ManageUsers]),
    });

    await expect(guard.canActivate(makeContext('/api/admin/users'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts any one capability declared by RequireAnyCaps', async () => {
    const guard = makeGuard({
      any: [Capability.ManageServers, Capability.ManageSystemSettings],
      userCaps: new Set([Capability.ManageServers]),
    });

    await expect(guard.canActivate(makeContext('/api/admin/catalog'))).resolves.toBe(true);
  });

  it('denies when none of the RequireAnyCaps alternatives are present', async () => {
    const guard = makeGuard({
      any: [Capability.ManageServers, Capability.ManageSystemSettings],
      userCaps: new Set([Capability.ManageUsers]),
    });

    await expect(guard.canActivate(makeContext('/api/admin/catalog'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('enforces both AND and OR metadata when both are present', async () => {
    const guard = makeGuard({
      all: [Capability.ManageUsers],
      any: [Capability.ManageServers, Capability.ManageSystemSettings],
      userCaps: new Set([Capability.ManageServers]),
    });

    await expect(guard.canActivate(makeContext('/api/admin/catalog'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

function makeGuard(
  options?: {
    all?: Capability[];
    any?: Capability[];
    userCaps?: Set<Capability>;
  },
): CapabilitiesGuard {
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => key === 'required_capabilities' ? options?.all : options?.any),
  } as unknown as Reflector;
  const accessResolver = {
    userCapabilitiesCurrent: vi.fn().mockResolvedValue(options?.userCaps ?? new Set<Capability>()),
  };
  return new CapabilitiesGuard(reflector, accessResolver as never);
}

function makeContext(url: string) {
  const request = {
    originalUrl: url,
    headers: {},
    user: { id: 'user-a' },
  };
  return {
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as never;
}
