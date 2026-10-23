import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { Public, RequireRole } from './decorators.js';
import { RolesGuard } from './guards.js';

class PlainController {
  open() {}

  @RequireRole(Role.Operator)
  operatorOnly() {}

  @RequireRole(Role.Admin)
  adminOnly() {}

  @Public()
  publicRoute() {}
}

@RequireRole(Role.Operator)
class OperatorController {
  inherited() {}

  @RequireRole(Role.User)
  openToUsers() {}
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('skips routes marked @Public()', () => {
    const context = makeContext(PlainController, 'publicRoute', '/api/admin/users', undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows authenticated routes without role metadata', () => {
    expect(guard.canActivate(makeContext(PlainController, 'open', '/api/containers', Role.User))).toBe(true);
  });

  it('builds the actor from the user row that authentication already loaded', () => {
    const context = makeContext(PlainController, 'open', '/api/containers', Role.Operator);
    const request = context.switchToHttp().getRequest();
    request.authContext = { authVersion: 7 };

    expect(guard.canActivate(context)).toBe(true);
    expect(request.actor).toEqual({
      userId: 'user-a',
      role: Role.Operator,
      authKind: 'jwt',
      authVersion: 7,
    });
  });

  it('refuses a /admin route without a declared role', () => {
    expect(() => guard.canActivate(makeContext(PlainController, 'open', '/api/admin/users', Role.Admin)))
      .toThrow(ForbiddenException);
    expect(() => guard.canActivate(makeContext(PlainController, 'open', '/admin/users', Role.Admin)))
      .toThrow(ForbiddenException);
    // Express matches routes case-insensitively.
    expect(() => guard.canActivate(makeContext(PlainController, 'open', '/api/Admin/users', Role.Admin)))
      .toThrow(ForbiddenException);
  });

  it('enforces the minimum role, with roles strictly nested', () => {
    const operatorRoute = (role: Role) => makeContext(PlainController, 'operatorOnly', '/api/admin/x', role);
    const adminRoute = (role: Role) => makeContext(PlainController, 'adminOnly', '/api/admin/x', role);

    expect(() => guard.canActivate(operatorRoute(Role.User))).toThrow(ForbiddenException);
    expect(guard.canActivate(operatorRoute(Role.Operator))).toBe(true);
    expect(guard.canActivate(operatorRoute(Role.Admin))).toBe(true);
    expect(() => guard.canActivate(adminRoute(Role.User))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(adminRoute(Role.Operator))).toThrow(ForbiddenException);
    expect(guard.canActivate(adminRoute(Role.Admin))).toBe(true);
  });

  it('lets a method-level role override the class-level one', () => {
    expect(() => guard.canActivate(makeContext(OperatorController, 'inherited', '/api/admin/x', Role.User)))
      .toThrow(ForbiddenException);
    expect(guard.canActivate(makeContext(OperatorController, 'inherited', '/api/admin/x', Role.Operator)))
      .toBe(true);
    expect(guard.canActivate(makeContext(OperatorController, 'openToUsers', '/api/admin/x', Role.User)))
      .toBe(true);
  });

  it('refuses a request without an authenticated user', () => {
    const context = makeContext(PlainController, 'open', '/api/containers', undefined);
    context.switchToHttp().getRequest().user = undefined;
    expect(guard.canActivate(context)).toBe(false);
  });
});

function makeContext(
  controller: new () => object,
  method: string,
  url: string,
  role: Role | undefined,
) {
  const request: Record<string, unknown> = {
    originalUrl: url,
    headers: {},
    user: { id: 'user-a', authVersion: 3, role },
  };
  return {
    getHandler: () => (controller.prototype as Record<string, () => void>)[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
