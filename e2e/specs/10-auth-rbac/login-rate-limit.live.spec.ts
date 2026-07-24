import type { APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { aggregateErrorWithDiagnostics } from '../../support/error-diagnostics.mjs';
import { currentRunId, requireRuntimeEnv } from '../../support/runtime-env.js';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: { username: string };
}

test.describe('10 live login abuse boundary', () => {
  test(
    'api.auth.login.failed-attempt-limit-uses-actual-tls-edge-peer',
    coverageCase(
      'auth.identity-rbac.valid-and-invalid-login',
      'api.auth.login.failed-attempt-limit-uses-actual-tls-edge-peer',
    ),
    async ({ playwright, coverageRecorder }) => {
      test.setTimeout(180_000);
      const rawApi = await playwright.request.newContext({
        baseURL: requireRuntimeEnv('E2E_RATE_LIMIT_BASE_URL'),
        ignoreHTTPSErrors: false,
        extraHTTPHeaders: {
          'x-nyabase-e2e-run': currentRunId(),
        },
      });
      const api = coverageRecorder.wrap(rawApi);
      let refreshToken: string | null = null;
      let primaryFailure: { error: unknown } | null = null;

      try {
        for (let index = 0; index < 49; index += 1) {
          await expectStatus(
            await wrongLogin(api, index),
            401,
            `failed login reservation ${index + 1}`,
          );
        }

        const success = await expectJson<LoginResponse>(
          await api.post('/api/auth/login', {
            data: {
              username: requireRuntimeEnv('E2E_ADMIN_USERNAME'),
              password: requireRuntimeEnv('E2E_ADMIN_PASSWORD'),
            },
            headers: spoofedForwardingHeaders(49),
          }),
        );
        refreshToken = success.refreshToken;
        expect(success.accessToken).not.toBe('');
        expect(success.refreshToken).not.toBe('');
        expect(success.user.username).toBe(requireRuntimeEnv('E2E_ADMIN_USERNAME'));

        await expectStatus(
          await wrongLogin(api, 50),
          401,
          'fiftieth retained failed login reservation',
        );
        const blocked = await wrongLogin(api, 51);
        await expectStatus(blocked, 429, 'failed login beyond the actual-peer budget');
        expect(await blocked.json()).toEqual({
          code: 'AUTH_RATE_LIMITED',
          message: 'Too many login attempts',
        });
      } catch (error) {
        primaryFailure = { error };
      }

      const cleanupErrors: unknown[] = [];
      if (refreshToken) {
        try {
          await expectStatus(
            await api.post('/api/auth/logout', { data: { refreshToken } }),
            204,
            'isolated rate-limit session logout',
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await rawApi.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (primaryFailure !== null && cleanupErrors.length > 0) {
        throw aggregateErrorWithDiagnostics(
          'login abuse proof and cleanup both failed',
          [primaryFailure.error, ...cleanupErrors],
        );
      }
      if (primaryFailure !== null) throw primaryFailure.error;
      if (cleanupErrors.length > 0) {
        throw aggregateErrorWithDiagnostics(
          'login abuse proof cleanup failed',
          cleanupErrors,
        );
      }
    },
  );
});

async function wrongLogin(api: APIRequestContext, index: number): Promise<APIResponse> {
  return api.post('/api/auth/login', {
    data: {
      username: `${currentRunId().replaceAll('-', '_')}_rate_missing_${index}`.slice(0, 64),
      password: `E2e-rate-limit-wrong-${index}-Cpu!`,
    },
    // The run-owned Nginx edge appends these untrusted values, but Backend must
    // continue to key the limiter from the edge's actual socket peer.
    headers: spoofedForwardingHeaders(index),
  });
}

function spoofedForwardingHeaders(index: number): Record<string, string> {
  const octet = (index % 250) + 1;
  return {
    'x-forwarded-for': `198.51.100.${octet}`,
    'x-real-ip': `203.0.113.${octet}`,
  };
}

async function expectStatus(
  response: APIResponse,
  expected: number,
  label: string,
): Promise<void> {
  expect(
    response.status(),
    `${label}: ${response.url()} returned ${response.status()}, expected ${expected}; response body withheld`,
  ).toBe(expected);
}
