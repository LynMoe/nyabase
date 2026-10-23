import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './decorators.js';
import { JwtAuthGuard } from './guards.js';

describe('JwtAuthGuard query token handling', () => {
  it('lets @Public() routes through without authenticating', async () => {
    const baseCanActivate = vi
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(false);
    const reflector = { getAllAndOverride: vi.fn((key: string) => key === IS_PUBLIC_KEY) };
    const guard = new JwtAuthGuard(reflector as never);

    await expect(guard.canActivate(makeContext(makeRequest({})))).resolves.toBe(true);

    expect(baseCanActivate).not.toHaveBeenCalled();
    baseCanActivate.mockRestore();
  });

  it('does not map query tokens into Authorization headers', async () => {
    const baseCanActivate = vi
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true);
    const request = makeRequest({ queryToken: 'jwt-token' });
    request.user = { id: 'user-a', authVersion: 7 };
    const guard = makeGuard();

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.headers.authorization).toBeUndefined();
    expect(request.authContext).toEqual({ authVersion: 7 });
    expect(baseCanActivate).toHaveBeenCalled();
    baseCanActivate.mockRestore();
  });

  it('hands every bearer token to the JWT strategy; there are no API tokens', async () => {
    const baseCanActivate = vi
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockResolvedValue(false);
    const request = makeRequest({ authHeader: `Bearer ${'a'.repeat(64)}` });

    await expect(makeGuard().canActivate(makeContext(request))).resolves.toBe(false);

    expect(baseCanActivate).toHaveBeenCalled();
    expect(request.user).toBeUndefined();
    baseCanActivate.mockRestore();
  });
});

function makeGuard(): JwtAuthGuard {
  return new JwtAuthGuard(new Reflector());
}

function makeRequest(input: {
  queryToken?: string;
  authHeader?: string;
  params?: Record<string, string>;
}) {
  return {
    headers: input.authHeader ? { authorization: input.authHeader } : {} as Record<string, string | undefined>,
    query: {
      ...(input.queryToken ? { token: input.queryToken } : {}),
    },
    params: input.params ?? {},
    user: undefined as unknown,
    authContext: undefined as unknown,
  };
}

function makeContext(request: ReturnType<typeof makeRequest>) {
  return {
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as never;
}
