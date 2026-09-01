import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiClient, ApiRequestOptions, ApiResponse } from './api-client.js';
import { currentRunId, requireRuntimeEnv } from './runtime-env.js';
import { registerControlPlaneNamesFromJson } from './incus-control.js';
import { readSeedState } from './seed-state.js';

type ApiMethod = 'delete' | 'fetch' | 'get' | 'head' | 'patch' | 'post' | 'put';

interface LedgerCase {
  caseId: string;
  persona: string;
  httpSurfaces: string[];
}

interface SurfaceMatcher {
  method: string;
  surface: string;
  pattern: RegExp;
  staticSegments: number;
}

export interface CoverageTestInfo {
  file: string;
  annotations: Array<{ type: string; description: string }>;
}

export interface CoverageRecorder {
  wrap(api: ApiClient): ApiClient;
  finish(status: 'passed' | 'failed'): void;
}

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ledger = JSON.parse(readFileSync(
  join(e2eRoot, 'coverage', 'features.json'),
  'utf8',
)) as {
  surfaceAliases?: Record<string, string>;
  features: Array<{ cases: LedgerCase[]; httpSurfaces: string[] }>;
};
const caseById = new Map(
  ledger.features.flatMap((feature) => feature.cases)
    .map((entry) => [entry.caseId, entry]),
);
const surfaceAliases = ledger.surfaceAliases ?? {};
const listedSurfaces = ledger.features.flatMap((feature) => (
  (feature.cases ?? []).flatMap((entry) => entry.httpSurfaces ?? [])
)).map((surface) => surfaceAliases[surface] ?? surface);
const surfaceMatchers = Array.from(new Map(
  listedSurfaces.map((surface) => {
    const [method, path] = surface.split('|');
    const segments = path.split('/').filter(Boolean);
    return [surface, {
      method,
      surface,
      pattern: new RegExp(`^/${segments.map((segment) => (
        segment.startsWith(':') ? '[^/]+' : escapeRegExp(segment)
      )).join('/')}/?$`),
      staticSegments: segments.filter((segment) => !segment.startsWith(':')).length,
    } satisfies SurfaceMatcher] as const;
  }),
).values()).sort((left, right) => right.staticSegments - left.staticSegments);

export function createCoverageRecorder(testInfo: CoverageTestInfo): CoverageRecorder {
  const caseId = annotation(testInfo, 'nyabase.coverage.case');
  const specTestId = annotation(testInfo, 'nyabase.coverage.test-id');
  const coverageCase = caseById.get(caseId);
  if (!coverageCase) {
    throw new Error(`coverage runtime references unknown case ${caseId}`);
  }
  const runId = currentRunId();
  const profile = requireRuntimeEnv('E2E_PROFILE');
  const runtimeRoot = resolve(requireRuntimeEnv('E2E_RUNTIME_ROOT'));
  const coverageNonce = requireRuntimeEnv('E2E_COVERAGE_RUN_NONCE');
  const httpEventsPath = join(runtimeRoot, 'coverage-http-events.jsonl');
  const caseEventsPath = join(runtimeRoot, 'coverage-case-events.jsonl');
  const marker = readFileSync(join(runtimeRoot, 'coverage-run.marker'), 'utf8').trim();
  if (marker !== `${runId}:${coverageNonce}`) {
    throw new Error('coverage artifacts belong to a different run invocation');
  }
  const observedSurfaces = new Set<string>();

  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });

  const record = async (method: string, url: string, response: ApiResponse) => {
    const parsed = new URL(url, requireRuntimeEnv('E2E_BASE_URL'));
    if (!parsed.pathname.startsWith('/api/')) return;
    const matches = surfaceMatchers.filter((candidate) => (
      candidate.method === method && candidate.pattern.test(parsed.pathname)
    ));
    const mostSpecific = matches.length === 0
      ? []
      : matches.filter((candidate) => candidate.staticSegments === matches[0].staticSegments);
    if (mostSpecific.length !== 1) {
      throw new Error(
        `coverage runtime mapped ${method} ${parsed.pathname} to ${mostSpecific.length} surfaces`,
      );
    }
    const surface = mostSpecific[0].surface;
    const caseSurfaces = new Set(
      (coverageCase.httpSurfaces ?? []).map((entry) => surfaceAliases[entry] ?? entry),
    );
    const countsForCase = caseSurfaces.has(surface);
    if (countsForCase) observedSurfaces.add(surface);
    const status = response.status();
    assertNoSeedAdminGrantMutation(method, parsed.pathname, status);
    if (status >= 200 && status < 300) {
      const body = await response.json().catch(() => undefined);
      registerControlPlaneNamesFromJson(body);
    }
    appendJsonLine(httpEventsPath, {
      schemaVersion: 2,
      runId,
      coverageNonce,
      profile,
      caseId,
      specTestId,
      persona: coverageCase.persona,
      method,
      requestPath: parsed.pathname,
      normalizedSurface: surface,
      countsForCase,
      status,
      observedAt: new Date().toISOString(),
    });
  };

  return {
    wrap(api) {
      return new Proxy(api, {
        get(target, property, receiver) {
          if (typeof property === 'string' && isApiMethod(property)) {
            return async (url: string, options?: ApiRequestOptions & { method?: string }) => {
              const method = property === 'fetch'
                ? String(options?.method ?? 'GET').toUpperCase()
                : property.toUpperCase();
              const methodFn = (target as unknown as Record<string, (
                requestUrl: string,
                requestOptions?: ApiRequestOptions,
              ) => Promise<ApiResponse>>)[property];
              const response = await methodFn.call(target, url, options);
              await record(method, response.url(), response);
              return response;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    finish(status) {
      appendJsonLine(caseEventsPath, {
        schemaVersion: 2,
        runId,
        coverageNonce,
        profile,
        caseId,
        source: 'api-http',
        status,
        observedAt: new Date().toISOString(),
        specPath: slash(relative(e2eRoot, testInfo.file)),
        specTestId,
        persona: coverageCase.persona,
        observedHttpSurfaces: [...observedSurfaces].sort(),
      });
    },
  };
}

function annotation(testInfo: CoverageTestInfo, type: string): string {
  const value = testInfo.annotations.find((entry) => entry.type === type)?.description;
  if (!value) throw new Error(`live test lacks ${type} annotation`);
  return value;
}

function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function isApiMethod(value: string): value is ApiMethod {
  return ['delete', 'fetch', 'get', 'head', 'patch', 'post', 'put'].includes(value);
}

function assertNoSeedAdminGrantMutation(method: string, pathname: string, status: number): void {
  if (method !== 'PUT' && method !== 'DELETE') return;
  if (status < 200 || status >= 300) return;
  const adminUserId = readSeedState().adminUserId;
  const pattern = new RegExp(
    `^/api/admin/users/${escapeRegExp(adminUserId)}/(server-grants|storage-pool-grants|shared-backend-grants)/`,
  );
  if (pattern.test(pathname)) {
    throw new Error(
      `seed admin grant mutation is forbidden: ${method} ${pathname} returned ${status}`,
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slash(path: string): string {
  return path.split(sep).join('/');
}
