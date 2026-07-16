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
    const guard = makeGuard([Capability.ManageUsers, Capability.ManageGroups], new Set([Capability.ManageUsers]));

    await expect(guard.canActivate(makeContext('/api/admin/users'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

function makeGuard(requiredCaps: Capability[] | undefined, userCaps = new Set<Capability>()): CapabilitiesGuard {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(requiredCaps),
  } as unknown as Reflector;
  const accessResolver = {
    userCapabilities: vi.fn().mockResolvedValue(userCaps),
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
