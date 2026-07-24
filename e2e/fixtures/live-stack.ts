import { expect, test as base, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createCoverageRecorder, type CoverageRecorder } from '../support/coverage-runtime.js';
import { expectJson } from '../support/http.js';
import { readSeedState, type SeedState } from '../support/seed-state.js';
import { requireRuntimeEnv } from '../support/runtime-env.js';
import { resolveTopologyProvider } from '../support/topology-provider.js';
import type { AvailableTopologyProvider } from '../topology/provider.js';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; capabilities: string[] };
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface AdminSession {
  readonly accessToken: string;
  readonly user: LoginResponse['user'];
  ensureFresh(): Promise<void>;
}

interface LiveFixtures {
  coverageRecorder: CoverageRecorder;
  adminApi: APIRequestContext;
  anonymousApi: APIRequestContext;
  trackedApiFactory: (options?: {
    extraHTTPHeaders?: Record<string, string>;
  }) => Promise<APIRequestContext>;
  seedState: SeedState;
  topologyProvider: AvailableTopologyProvider;
}

interface LiveWorkerFixtures {
  // The refresh secret remains private to fixture teardown so a behavioral
  // logout case cannot invalidate the shared worker authentication session.
  adminSession: AdminSession;
}

export const test = base.extend<LiveFixtures, LiveWorkerFixtures>({
  coverageRecorder: [async ({}, use, testInfo) => {
    const recorder = createCoverageRecorder(testInfo);
    try {
      await use(recorder);
    } finally {
      recorder.finish();
    }
  }, { auto: true }],

  topologyProvider: async ({}, use) => {
    await use(resolveTopologyProvider());
  },

  adminSession: [async ({ playwright }, use) => {
    const username = requireRuntimeEnv('E2E_ADMIN_USERNAME');
    const password = requireRuntimeEnv('E2E_ADMIN_PASSWORD');
    const api = await playwright.request.newContext({
      baseURL: requireRuntimeEnv('E2E_BASE_URL'),
      ignoreHTTPSErrors: false,
      extraHTTPHeaders: {
        'x-nyabase-e2e-run': requireRuntimeEnv('E2E_RUN_ID'),
      },
    });
    let refreshToken: string | null = null;
    try {
      const response = await api.post('/api/auth/login', {
        data: { username, password },
      });
      const session = await expectJson<LoginResponse>(response);
      expect(session.accessToken).not.toBe('');
      expect(session.refreshToken).not.toBe('');
      expect(session.user.username).toBe(username);
      let accessToken = session.accessToken;
      refreshToken = session.refreshToken;
      let refreshSequence = 0;
      const adminSession: AdminSession = {
        get accessToken() {
          return accessToken;
        },
        user: session.user,
        async ensureFresh() {
          refreshSequence += 1;
          const rotated = await expectJson<TokenPair>(await api.post('/api/auth/refresh', {
            data: {
              refreshToken,
              requestId: createHash('sha256')
                .update(`${currentWorkerRunId()}:admin-session:${refreshSequence}`)
                .digest('hex'),
            },
          }));
          accessToken = rotated.accessToken;
          refreshToken = rotated.refreshToken;
        },
      };
      await use(adminSession);
    } finally {
      try {
        if (refreshToken) {
          const logout = await api.post('/api/auth/logout', {
            data: { refreshToken },
          });
          expect(logout.status()).toBe(204);
        }
      } finally {
        await api.dispose();
      }
    }
  }, { scope: 'worker' }],

  adminApi: async ({ playwright, adminSession, coverageRecorder }, use) => {
    await adminSession.ensureFresh();
    const api = await playwright.request.newContext({
      baseURL: requireRuntimeEnv('E2E_BASE_URL'),
      ignoreHTTPSErrors: false,
      extraHTTPHeaders: {
        authorization: `Bearer ${adminSession.accessToken}`,
        'x-nyabase-e2e-run': requireRuntimeEnv('E2E_RUN_ID'),
      },
    });
    await use(coverageRecorder.wrap(api));
    await api.dispose();
  },

  anonymousApi: async ({ playwright, coverageRecorder }, use) => {
    const api = await playwright.request.newContext({
      baseURL: requireRuntimeEnv('E2E_BASE_URL'),
      ignoreHTTPSErrors: false,
      extraHTTPHeaders: {
        'x-nyabase-e2e-run': requireRuntimeEnv('E2E_RUN_ID'),
      },
    });
    await use(coverageRecorder.wrap(api));
    await api.dispose();
  },

  trackedApiFactory: async ({ playwright, coverageRecorder }, use) => {
    const contexts: APIRequestContext[] = [];
    await use(async (options = {}) => {
      const api = await playwright.request.newContext({
        baseURL: requireRuntimeEnv('E2E_BASE_URL'),
        ignoreHTTPSErrors: false,
        extraHTTPHeaders: {
          'x-nyabase-e2e-run': requireRuntimeEnv('E2E_RUN_ID'),
          ...options.extraHTTPHeaders,
        },
      });
      contexts.push(api);
      return coverageRecorder.wrap(api);
    });
    await Promise.all(contexts.map((context) => context.dispose()));
  },

  seedState: async ({}, use) => {
    await use(readSeedState());
  },
});

export { expect };

function currentWorkerRunId(): string {
  return requireRuntimeEnv('E2E_RUN_ID');
}
