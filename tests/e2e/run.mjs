#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  requireProfileTopologyCapabilities,
  resolveTopologyProvider,
} from './support/topology-provider.ts';

const e2eRoot = dirname(fileURLToPath(import.meta.url));
const profileName = process.env.E2E_PROFILE ?? 'smoke';
const profilePath = join(e2eRoot, 'profiles', `${profileName}.json`);
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));

if (profile.name !== profileName || profile.runtime !== 'incus') {
  throw new Error(`Invalid Incus E2E profile: ${profilePath}`);
}

const topologyProvider = resolveTopologyProvider();
requireProfileTopologyCapabilities(
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

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const specFiles = profile.groups.flatMap((group) => (
  walk(join(e2eRoot, 'specs', group)).filter((file) => file.endsWith('.spec.ts'))
)).sort();

for (const file of specFiles) {
  await import(pathToFileURL(file).href);
}

const { registeredTests, runLiveTest, closeAdminSession } = await import('./fixtures/live-stack.ts');
const profileTag = `@nyabase-profile-${profileName}`;
const extraGrep = process.env.E2E_GREP?.trim();
const extraPattern = extraGrep ? new RegExp(extraGrep) : undefined;

const selected = registeredTests().filter((entry) => {
  if (!entry.tags.includes(profileTag)) return false;
  if (!extraPattern) return true;
  const haystack = `${entry.title} ${entry.tags.join(' ')}`;
  return extraPattern.test(haystack);
});

if (selected.length === 0) {
  throw new Error(`no API tests selected for profile ${profileName}`);
}

const timeoutMs = Number(profile.timeoutMs) || 90_000;
const runId = process.env.E2E_RUN_ID ?? 'unconfigured';
const runtimeRoot = resolve(process.env.E2E_RUNTIME_ROOT ?? join(e2eRoot, '.runtime', runId));
mkdirSync(join(runtimeRoot, 'reports'), { recursive: true, mode: 0o700 });

console.log(`API run started: tests=${selected.length} profile=${profileName}`);
const results = [];
let failed = 0;
for (const entry of selected) {
  const started = Date.now();
  const label = `${relative(e2eRoot, entry.file)} › ${entry.title}`;
  try {
    await Promise.race([
      runLiveTest(entry),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    results.push({ title: entry.title, file: entry.file, status: 'passed', durationMs: Date.now() - started });
    console.log(`pass ${label}`);
  } catch (error) {
    failed += 1;
    results.push({
      title: entry.title,
      file: entry.file,
      status: 'failed',
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`fail ${label}`);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    break;
  }
}
await closeAdminSession();
writeFileSync(
  join(runtimeRoot, 'reports', 'api-tests.json'),
  `${JSON.stringify({ profile: profileName, runId, results }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`API run completed: status=${failed === 0 ? 'passed' : 'failed'} passed=${results.length - failed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
