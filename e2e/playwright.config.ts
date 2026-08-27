import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  requireProfileTopologyCapabilities,
  resolveTopologyProvider,
} from './support/topology-provider.js';

interface E2eProfile {
  name: string;
  runtime: 'incus';
  groups: string[];
  requiredEnv: string[];
  requiredCapabilities: unknown;
  workers: number;
  timeoutMs: number;
}

const e2eRoot = dirname(fileURLToPath(import.meta.url));
const profileName = process.env.E2E_PROFILE ?? 'smoke';
const profilePath = join(e2eRoot, 'profiles', `${profileName}.yaml`);
const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as E2eProfile;

if (profile.name !== profileName || profile.runtime !== 'incus') {
  throw new Error(`Invalid Incus E2E profile: ${profilePath}`);
}

const topologyProvider = resolveTopologyProvider();
const requiredCapabilities = requireProfileTopologyCapabilities(
  topologyProvider,
  profileName,
  profile.requiredCapabilities,
);

const missingEnv = profile.requiredEnv.filter((name) => !process.env[name]);
if (process.env.E2E_ALLOW_MISSING_RUNTIME !== '1' && missingEnv.length > 0) {
  throw new Error(
    `E2E profile ${profileName} is BLOCKED: missing runtime inputs ${missingEnv.join(', ')}`,
  );
}

const runId = process.env.E2E_RUN_ID ?? 'unconfigured';
const edgeSpki = process.env.E2E_EDGE_SPKI;
const runtimeRoot = resolve(process.env.E2E_RUNTIME_ROOT ?? join(e2eRoot, '.runtime', runId));

export default defineConfig({
  testDir: join(e2eRoot, 'specs'),
  testMatch: profile.groups.map((group) => `${group}/**/*.spec.ts`),
  grep: new RegExp(`@nyabase-profile-${profileName}(?:\\s|$)`),
  outputDir: join(runtimeRoot, 'test-results'),
  timeout: profile.timeoutMs,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: process.env.CI ? 1 : profile.workers,
  retries: 0,
  maxFailures: 1,
  forbidOnly: true,
  preserveOutput: 'failures-only',
  reporter: [
    ['./support/secret-safe-reporter.ts'],
    ['json', { outputFile: join(runtimeRoot, 'reports', 'playwright.json') }],
    ['junit', { outputFile: join(runtimeRoot, 'reports', 'junit.xml') }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    ignoreHTTPSErrors: false,
    extraHTTPHeaders: {
      'x-nyabase-e2e-run': runId,
    },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: edgeSpki
      ? { args: [`--ignore-certificate-errors-spki-list=${edgeSpki}`] }
      : undefined,
  },
  metadata: {
    profile: profileName,
    runId,
    runtime: 'incus',
    topologyProvider: topologyProvider.id,
    topologyEvidenceBoundary: topologyProvider.evidenceBoundary,
    requiredTopologyCapabilities: requiredCapabilities.join(','),
  },
});
