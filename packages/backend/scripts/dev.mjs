#!/usr/bin/env node
// Dev runner: `tsc -b --watch` (emits decorator metadata, which Nest DI needs;
// esbuild-based runners such as tsx drop it) + `node --watch dist/main.js`.
import { spawn } from 'node:child_process';
import { cpSync, rmSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsSrc = join(root, 'src/platform/persistence-pg/migrations');
const migrationsDst = join(root, 'dist/platform/persistence-pg/migrations');
const tscBin = createRequire(import.meta.url).resolve('typescript/bin/tsc');

function syncMigrations() {
  rmSync(migrationsDst, { recursive: true, force: true });
  cpSync(migrationsSrc, migrationsDst, { recursive: true });
}

let app = null;
let appStarted = false;
let stopping = false;

function startApp() {
  syncMigrations();
  appStarted = true;
  // node --watch restarts on any change to files dist/main.js imports.
  app = spawn(process.execPath, ['--watch', '--enable-source-maps', 'dist/main.js'], {
    cwd: root,
    stdio: 'inherit',
    // runtime.nodeEnv defaults to production; local dev opts into the
    // development fallbacks explicitly (an exported NODE_ENV still wins).
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
  });
  app.on('exit', (code) => {
    if (!stopping) shutdown(code ?? 1);
  });
}

const tsc = spawn(process.execPath, [tscBin, '-b', '--watch', '--preserveWatchOutput'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
});
tsc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  // Start once the first build finished; type errors still emit JS.
  if (!appStarted && /Found \d+ errors?\. Watching for file changes/.test(text)) startApp();
});
tsc.on('exit', (code) => {
  if (!stopping) shutdown(code ?? 1);
});

watch(migrationsSrc, { recursive: true }, () => {
  if (appStarted) syncMigrations();
});

function shutdown(code) {
  stopping = true;
  tsc.kill('SIGTERM');
  app?.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
