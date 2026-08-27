import { expect, test as base, type APIRequestContext } from '@playwright/test';
import { createCoverageRecorder, type CoverageRecorder } from '../support/coverage-runtime.js';
import { expectJson } from '../support/http.js';
import { readSeedState, type SeedState } from '../support/seed-state.js';
import { requireRuntimeEnv } from '../support/runtime-env.js';
import { resolveTopologyProvider } from '../support/topology-provider.js';
import type { AvailableTopologyProvider } from '../topology/provider.js';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    username: string;
    capabilities: string[];
  };
}

interface AdminSession {
  readonly accessToken: string;
  readonly user: LoginResponse['user'];
}

interface LiveFixtures {
  coverageRecorder: CoverageRecorder;
  adminApi: APIRequestContext;
  anonymousApi: APIRequestContext;
  trackedApiFactory: (options?: {
    extraHTTPHeaders?: Record<string, string>;
  }) => Promise<APIRequestContext>;
  /**
   * Build a coverage-tracked API context authenticated as an arbitrary bearer token.
   * Used for second-persona / attacker lanes created inside specs.
   */
  authedApiFactory: (accessToken: string) => Promise<APIRequestContext>;
  seedState: SeedState;
  topologyProvider: AvailableTopologyProvider;
}

interface LiveWorkerFixtures {
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
        data: {
          username: requireRuntimeEnv('E2E_ADMIN_USERNAME'),
          password: requireRuntimeEnv('E2E_ADMIN_PASSWORD'),
        },
      });
      const session = await expectJson<LoginResponse>(response);
      expect(session.accessToken).not.toBe('');
      expect(session.refreshToken).not.toBe('');
      refreshToken = session.refreshToken;
      await use({
        accessToken: session.accessToken,
        user: session.user,
      });
    } finally {
      if (refreshToken) {
        await api.post('/api/auth/logout', { data: { refreshToken } });
      }
      await api.dispose();
    }
  }, { scope: 'worker' }],

  adminApi: async ({ playwright, adminSession, coverageRecorder }, use) => {
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

  authedApiFactory: async ({ trackedApiFactory }, use) => {
    await use(async (accessToken: string) => trackedApiFactory({
      extraHTTPHeaders: {
        authorization: `Bearer ${accessToken}`,
      },
    }));
  },

  seedState: async ({}, use) => {
    await use(readSeedState());
  },
});

export { expect };
