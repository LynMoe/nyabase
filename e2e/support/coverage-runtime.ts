import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext, APIResponse, TestInfo } from '@playwright/test';
import { currentRunId, requireRuntimeEnv } from './runtime-env.js';

type ApiMethod = 'delete' | 'fetch' | 'get' | 'head' | 'patch' | 'post' | 'put';

interface LedgerCase {
  caseId: string;
  kind: 'behavioral' | 'evidence' | 'fixture';
  persona: string;
  httpSurfaces: string[];
}

interface SurfaceMatcher {
  method: string;
  surface: string;
  pattern: RegExp;
  staticSegments: number;
}

export interface CoverageRecorder {
  wrap(api: APIRequestContext): APIRequestContext;
  finish(): void;
}

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ledger = JSON.parse(readFileSync(join(e2eRoot, 'coverage', 'features.yaml'), 'utf8')) as {
  features: Array<{ cases: LedgerCase[]; httpSurfaces: string[] }>;
};
const caseById = new Map(
  ledger.features.flatMap((feature) => feature.cases).map((entry) => [entry.caseId, entry]),
);
const surfaceMatchers = ledger.features.flatMap((feature) => feature.httpSurfaces.map((surface) => {
  const [, method, path] = surface.split('|');
  const segments = path.split('/').filter(Boolean);
  const pattern = new RegExp(`^/${segments.map((segment) => (
    segment.startsWith(':') ? '[^/]+' : escapeRegExp(segment)
  )).join('/')}/?$`);
  return {
    method,
    surface,
    pattern,
    staticSegments: segments.filter((segment) => !segment.startsWith(':')).length,
  } satisfies SurfaceMatcher;
})).sort((left, right) => right.staticSegments - left.staticSegments);

export function createCoverageRecorder(testInfo: TestInfo): CoverageRecorder {
  const caseId = annotation(testInfo, 'nyabase.coverage.case');
  const specTestId = annotation(testInfo, 'nyabase.coverage.test-id');
  const coverageCase = caseById.get(caseId);
  if (!coverageCase) throw new Error(`coverage runtime references unknown case ${caseId}`);
  const runId = currentRunId();
  const profile = requireRuntimeEnv('E2E_PROFILE');
  const runtimeRoot = resolve(requireRuntimeEnv('E2E_RUNTIME_ROOT'));
  const httpEventsPath = join(runtimeRoot, 'coverage-http-events.jsonl');
  const caseEventsPath = join(runtimeRoot, 'coverage-case-events.jsonl');
  const observedSurfaces = new Set<string>();

  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });

  const record = (method: string, url: string, response: APIResponse) => {
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
        `coverage runtime mapped ${method} ${parsed.pathname} to ${mostSpecific.length} most-specific surfaces`,
      );
    }
    const surface = mostSpecific[0].surface;
    const countsForCase = coverageCase.httpSurfaces.includes(surface);
    if (countsForCase) observedSurfaces.add(surface);
    appendJsonLine(httpEventsPath, {
      schemaVersion: 1,
      runId,
      profile,
      caseId,
      specTestId,
      persona: coverageCase.persona,
      method,
      requestPath: parsed.pathname,
      normalizedSurface: surface,
      countsForCase,
      status: response.status(),
      observedAt: new Date().toISOString(),
    });
  };

  return {
    wrap(api) {
      return new Proxy(api, {
        get(target, property, receiver) {
          if (typeof property === 'string' && isApiMethod(property)) {
            return async (url: string, options?: Record<string, unknown>) => {
              const method = property === 'fetch'
                ? String(options?.method ?? 'GET').toUpperCase()
                : property.toUpperCase();
              const response = await (target[property] as (
                requestUrl: string,
                requestOptions?: Record<string, unknown>,
              ) => Promise<APIResponse>).call(target, url, options);
              record(method, response.url(), response);
              return response;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    finish() {
      appendJsonLine(caseEventsPath, {
        schemaVersion: 1,
        runId,
        profile,
        caseId,
        kind: coverageCase.kind,
        source: 'playwright',
        status: testInfo.status === 'passed' ? 'passed' : 'failed',
        observedAt: new Date().toISOString(),
        specPath: slash(relative(e2eRoot, testInfo.file)),
        specTestId,
        persona: coverageCase.persona,
        observedHttpSurfaces: [...observedSurfaces].sort(),
      });
    },
  };
}

function annotation(testInfo: TestInfo, type: string): string {
  const value = testInfo.annotations.find((entry) => entry.type === type)?.description;
  if (!value) throw new Error(`live test ${testInfo.title} lacks ${type} annotation`);
  return value;
}

function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function isApiMethod(value: string): value is ApiMethod {
  return ['delete', 'fetch', 'get', 'head', 'patch', 'post', 'put'].includes(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slash(path: string): string {
  return path.split(sep).join('/');
}
