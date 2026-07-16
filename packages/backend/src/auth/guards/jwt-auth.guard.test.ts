import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from './jwt-auth.guard.js';

describe('JwtAuthGuard query token handling', () => {
  it('does not map query tokens into Authorization headers', async () => {
    const baseCanActivate = vi
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true);
    const request = makeRequest({ queryToken: 'jwt-token' });
    const guard = makeGuard();

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(request.headers.authorization).toBeUndefined();
    expect(baseCanActivate).toHaveBeenCalled();
    baseCanActivate.mockRestore();
  });

  it('still accepts normal API tokens in Authorization headers', async () => {
    const baseCanActivate = vi
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true);
    const rawToken = 'a'.repeat(64);
    const request = makeRequest({ authHeader: `Bearer ${rawToken}` });
    const authService = {
      validateApiToken: vi.fn().mockResolvedValue({ id: 'user-a' }),
    };
    const guard = makeGuard(authService);

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    expect(authService.validateApiToken).toHaveBeenCalledWith(rawToken);
    expect(request.user).toEqual({ id: 'user-a' });
    expect(baseCanActivate).not.toHaveBeenCalled();
    baseCanActivate.mockRestore();
  });
});

function makeGuard(
  authService: {
    validateApiToken?: ReturnType<typeof vi.fn>;
  } = {},
): JwtAuthGuard {
  return new JwtAuthGuard({
    validateApiToken: vi.fn(),
    ...authService,
  } as never);
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
