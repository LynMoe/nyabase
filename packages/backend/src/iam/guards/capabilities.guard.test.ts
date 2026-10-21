import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Capability } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { CapabilitiesGuard } from './capabilities.guard.js';

describe('CapabilitiesGuard', () => {
  it('skips routes marked @Public()', async () => {
    const guard = makeGuard({ public: true });
    const request = { originalUrl: '/api/admin/users', headers: {} };

    await expect(guard.canActivate({
      getHandler: () => function handler() {},
      getClass: () => class TestController {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as never)).resolves.toBe(true);
  });

  it('allows authenticated non-admin routes without capability metadata', async () => {
    const guard = makeGuard(undefined);

    await expect(guard.canActivate(makeContext('/api/containers'))).resolves.toBe(true);
  });

  it('resolves capabilities once and stashes them as the request actor', async () => {
    const userCaps = new Set([Capability.ManageContainersAny]);
    const { guard, accessResolver } = makeGuardWithResolver({
      all: [Capability.ManageContainersAny],
      userCaps,
    });
    const context = makeContext('/api/containers');
    const request = context.switchToHttp().getRequest();
    request.authContext = { kind: 'jwt', authVersion: 7 };

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(accessResolver.userCapabilitiesCurrent).toHaveBeenCalledTimes(1);
    expect(request.actor).toEqual({
      userId: 'user-a',
      capabilities: userCaps,
      authKind: 'jwt',
      authVersion: 7,
    });
  });

  it('builds the actor for routes with no capability metadata and for API tokens', async () => {
    const { guard, accessResolver } = makeGuardWithResolver({ userCaps: new Set([Capability.ViewAudit]) });
    const context = makeContext('/api/containers');
    const request = context.switchToHttp().getRequest();
    request.authContext = { kind: 'api-token' };

    await guard.canActivate(context);

    expect(accessResolver.userCapabilitiesCurrent).toHaveBeenCalledTimes(1);
    expect(request.actor).toMatchObject({
      userId: 'user-a',
      authKind: 'api-token',
      capabilities: new Set([Capability.ViewAudit]),
    });
  });

  it('refuses an /admin route without capability metadata before resolving anything', async () => {
    const { guard, accessResolver } = makeGuardWithResolver({});
    await expect(guard.canActivate(makeContext('/api/admin/users'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(accessResolver.userCapabilitiesCurrent).not.toHaveBeenCalled();
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

  it('treats method-level empty RequireCaps as an override so anyCaps can authorize', async () => {
    const guard = makeGuard({
      all: [],
      any: [Capability.ManageUsers, Capability.ManageGrants],
      userCaps: new Set([Capability.ManageGrants]),
    });

    await expect(guard.canActivate(makeContext('/api/admin/users'))).resolves.toBe(true);
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
    public?: boolean;
    userCaps?: Set<Capability>;
  },
): CapabilitiesGuard {
  return makeGuardWithResolver(options).guard;
}

function makeGuardWithResolver(
  options?: {
    all?: Capability[];
    any?: Capability[];
    public?: boolean;
    userCaps?: Set<Capability>;
  },
): { guard: CapabilitiesGuard; accessResolver: { userCapabilitiesCurrent: ReturnType<typeof vi.fn> } } {
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) return options?.public;
      return key === 'required_capabilities' ? options?.all : options?.any;
    }),
  } as unknown as Reflector;
  const accessResolver = {
    userCapabilitiesCurrent: vi.fn().mockResolvedValue(options?.userCaps ?? new Set<Capability>()),
  };
  return { guard: new CapabilitiesGuard(reflector, accessResolver as never), accessResolver };
}

function makeContext(url: string) {
  const request = {
    originalUrl: url,
    headers: {},
    user: { id: 'user-a', authVersion: 3 },
  };
  return {
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}
