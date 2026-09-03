import { fileURLToPath } from 'node:url';
import { createApiClient, type ApiClient } from '../support/api-client.js';
import { createCoverageRecorder, type CoverageRecorder } from '../support/coverage-runtime.js';
import { expect } from '../support/expect.js';
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

export interface LiveFixtures {
  adminApi: ApiClient;
  anonymousApi: ApiClient;
  trackedApiFactory: (options?: {
    extraHTTPHeaders?: Record<string, string>;
  }) => Promise<ApiClient>;
  authedApiFactory: (accessToken: string) => Promise<ApiClient>;
  seedState: SeedState;
  topologyProvider: AvailableTopologyProvider;
}

export interface RegisteredTest {
  title: string;
  file: string;
  tags: string[];
  annotations: Array<{ type: string; description: string }>;
  fn: (fixtures: LiveFixtures) => Promise<void>;
}

const registryKey = '__nyabaseE2eTests';
const registry: RegisteredTest[] = (() => {
  const globalRegistry = globalThis as unknown as Record<string, RegisteredTest[]>;
  if (!globalRegistry[registryKey]) globalRegistry[registryKey] = [];
  return globalRegistry[registryKey];
})();

export function registeredTests(): readonly RegisteredTest[] {
  return registry;
}

function callerFile(): string {
  const stack = new Error().stack?.split('\n') ?? [];
  for (const line of stack) {
    const match = line.match(/(file:\/\/\/.*\.spec\.ts)/)
      ?? line.match(/(\/.*\.spec\.ts):\d+/);
    if (match?.[1]) {
      return match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1];
    }
  }
  return 'unknown.spec.ts';
}

interface TestFn {
  (
    title: string,
    details: {
      tag?: string[];
      annotation?: Array<{ type: string; description: string }>;
    },
    fn: (fixtures: LiveFixtures) => Promise<void>,
  ): void;
  setTimeout(ms: number): void;
}

export const test: TestFn = Object.assign(
  (
    title: string,
    details: {
      tag?: string[];
      annotation?: Array<{ type: string; description: string }>;
    },
    fn: (fixtures: LiveFixtures) => Promise<void>,
  ) => {
    registry.push({
      title,
      file: callerFile(),
      tags: details.tag ?? [],
      annotations: details.annotation ?? [],
      fn,
    });
  },
  {
    setTimeout(_ms: number) {},
  },
);

let adminSession: { accessToken: string; refreshToken: string; user: LoginResponse['user'] } | undefined;
let adminLoginClient: ApiClient | undefined;
let adminSessionIssuedAt = 0;
const ADMIN_SESSION_REFRESH_MS = 8 * 60_000;

async function ensureAdminSession(): Promise<{ accessToken: string; user: LoginResponse['user'] }> {
  if (adminSession && Date.now() - adminSessionIssuedAt < ADMIN_SESSION_REFRESH_MS) {
    return adminSession;
  }
  if (adminSession && adminLoginClient) {
    await adminLoginClient.post('/api/auth/logout', {
      data: { refreshToken: adminSession.refreshToken },
    }).catch(() => undefined);
    adminSession = undefined;
  }
  adminLoginClient = createApiClient({
    baseURL: requireRuntimeEnv('E2E_BASE_URL'),
    extraHTTPHeaders: {
      'x-nyabase-e2e-run': requireRuntimeEnv('E2E_RUN_ID'),
    },
  });
  const response = await adminLoginClient.post('/api/auth/login', {
    data: {
      username: requireRuntimeEnv('E2E_ADMIN_USERNAME'),
      password: requireRuntimeEnv('E2E_ADMIN_PASSWORD'),
    },
  });
  const session = await expectJson<LoginResponse>(response);
  expect(session.accessToken).not.toBe('');
  expect(session.refreshToken).not.toBe('');
  adminSession = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    user: session.user,
  };
  adminSessionIssuedAt = Date.now();
  return adminSession;
}

export async function closeAdminSession(): Promise<void> {
  if (adminSession && adminLoginClient) {
    await adminLoginClient.post('/api/auth/logout', {
      data: { refreshToken: adminSession.refreshToken },
    }).catch(() => undefined);
  }
  adminSession = undefined;
  adminLoginClient = undefined;
  adminSessionIssuedAt = 0;
}

export async function runLiveTest(entry: RegisteredTest): Promise<void> {
  const session = await ensureAdminSession();
  const recorder = createCoverageRecorder({
    file: entry.file.startsWith('file:') ? fileURLToPath(entry.file) : entry.file,
    annotations: entry.annotations,
  });
  const clients: ApiClient[] = [];
  const makeClient = (headers: Record<string, string> = {}) => {
    const api = recorder.wrap(createApiClient({
      baseURL: requireRuntimeEnv('E2E_BASE_URL'),
      extraHTTPHeaders: {
        'x-nyabase-e2e-run': requireRuntimeEnv('E2E_RUN_ID'),
        ...headers,
      },
    }));
    clients.push(api);
    return api;
  };
  const trackedApiFactory = async (options: { extraHTTPHeaders?: Record<string, string> } = {}) => (
    makeClient(options.extraHTTPHeaders ?? {})
  );
  try {
    await entry.fn({
      adminApi: makeClient({ authorization: `Bearer ${session.accessToken}` }),
      anonymousApi: makeClient(),
      trackedApiFactory,
      authedApiFactory: async (accessToken: string) => trackedApiFactory({
        extraHTTPHeaders: { authorization: `Bearer ${accessToken}` },
      }),
      seedState: readSeedState(),
      topologyProvider: resolveTopologyProvider(),
    });
    recorder.finish('passed');
  } catch (error) {
    recorder.finish('failed');
    throw error;
  } finally {
    await Promise.all(clients.map((client) => client.dispose()));
  }
}

export { expect };
