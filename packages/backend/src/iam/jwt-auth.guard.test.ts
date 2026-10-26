import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './decorators.js';
import { JwtAuthGuard } from './guards.js';
import type { AuthService } from './auth.service.js';

describe('JwtAuthGuard', () => {
  it('lets @Public() routes through without authenticating', async () => {
    const authService = fakeAuthService();
    const reflector = { getAllAndOverride: vi.fn((key: string) => key === IS_PUBLIC_KEY) };
    const guard = new JwtAuthGuard(reflector as never, authService as never);

    await expect(guard.canActivate(makeContext(makeRequest({})))).resolves.toBe(true);

    expect(authService.validateAccessToken).not.toHaveBeenCalled();
  });

  it('does not read query tokens or map them into Authorization headers', async () => {
    const authService = fakeAuthService();
    const request = makeRequest({ queryToken: 'jwt-token' });

    await expect(makeGuard(authService).canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(request.headers.authorization).toBeUndefined();
    expect(authService.validateAccessToken).not.toHaveBeenCalled();
  });

  it('validates the bearer access token and records the user and its auth version', async () => {
    const authService = fakeAuthService();
    const token = 'a'.repeat(64);
    const request = makeRequest({ authHeader: `bearer  ${token}` });

    await expect(makeGuard(authService).canActivate(makeContext(request))).resolves.toBe(true);

    expect(authService.validateAccessToken).toHaveBeenCalledWith(token);
    expect(request.user).toEqual({ id: 'user-a', authVersion: 7 });
    expect(request.authContext).toEqual({ authVersion: 7 });
  });

  it.each(['Basic abc', 'Bearer', 'Bearer a b', `Token ${'a'.repeat(64)}`])(
    'rejects the Authorization header %j without validating it',
    async (header) => {
      const authService = fakeAuthService();
      const request = makeRequest({ authHeader: header });

      await expect(makeGuard(authService).canActivate(makeContext(request))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      expect(authService.validateAccessToken).not.toHaveBeenCalled();
    },
  );

  it('propagates a rejected token; there are no API tokens', async () => {
    const authService = fakeAuthService();
    authService.validateAccessToken.mockRejectedValue(new UnauthorizedException('Invalid access token'));
    const request = makeRequest({ authHeader: `Bearer ${'a'.repeat(64)}` });

    await expect(makeGuard(authService).canActivate(makeContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(request.user).toBeUndefined();
  });
});

function fakeAuthService() {
  return {
    validateAccessToken: vi.fn<AuthService['validateAccessToken']>().mockResolvedValue({
      user: { id: 'user-a', authVersion: 7 } as never,
      sessionId: 'session-a',
      expiresAt: new Date(),
    }),
  };
}

function makeGuard(authService: ReturnType<typeof fakeAuthService>): JwtAuthGuard {
  return new JwtAuthGuard(new Reflector(), authService as never);
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
