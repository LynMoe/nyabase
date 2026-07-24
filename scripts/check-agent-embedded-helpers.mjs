import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helperModule = require('../packages/agent/dist/quota/projects-file-helper.js');
const scripts = [
  ['mutation', helperModule.PROJECTS_FILE_HELPER_SCRIPT],
  ['reader', helperModule.PROJECTS_FILE_READER_SCRIPT],
];

for (const [label, script] of scripts) {
  if (typeof script !== 'string' || script.includes('exports.')) {
    throw new Error(`Compiled ${label} helper contains an unresolved CommonJS export binding`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'nyabase-compiled-projects-helper-'));
try {
  const exchangeHelper = join(root, 'nyabase-atomic-file-exchange');
  const compile = spawnSync('cc', [
    '-O2', '-Wall', '-Wextra', '-Werror',
    '-o', exchangeHelper,
    resolve('tools/atomic-file-exchange/atomic-file-exchange.c'),
  ], { encoding: 'utf8' });
  if (compile.status !== 0) {
    throw new Error(`Could not compile atomic exchange helper: ${compile.stderr}`);
  }
  chmodSync(exchangeHelper, 0o755);

  const projectsPath = join(root, 'projects');
  writeFileSync(projectsPath, '10008:/data/sibling\n', { mode: 0o644 });
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    NYABASE_TEST_ATOMIC_FILE_EXCHANGE_HELPER: exchangeHelper,
  };
  const mutation = spawnSync(process.execPath, [
    '-e', helperModule.PROJECTS_FILE_HELPER_SCRIPT,
    'ensure', '10007', '/data/target', projectsPath,
  ], { encoding: 'utf8', env: environment });
  if (mutation.status !== 0 || mutation.stderr !== '') {
    throw new Error(`Compiled mutation helper failed: status=${mutation.status} stderr=${mutation.stderr}`);
  }
  if (readFileSync(projectsPath, 'utf8') !== '10008:/data/sibling\n10007:/data/target\n') {
    throw new Error('Compiled mutation helper did not publish the exact registration');
  }

  const reader = spawnSync(process.execPath, [
    '-e', helperModule.PROJECTS_FILE_READER_SCRIPT, projectsPath,
  ], { encoding: 'utf8', env: environment });
  if (reader.status !== 0 || reader.stderr !== '') {
    throw new Error(`Compiled reader helper failed: status=${reader.status} stderr=${reader.stderr}`);
  }
  const snapshot = JSON.parse(reader.stdout);
  if (snapshot.contents !== '10008:/data/sibling\n10007:/data/target\n') {
    throw new Error('Compiled reader helper returned the wrong registration snapshot');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('Compiled Agent embedded helper check passed.');
