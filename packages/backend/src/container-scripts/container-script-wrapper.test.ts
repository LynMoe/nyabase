import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES } from '@nyabase/common';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWrapper,
  GUEST_INSTALL_FAILED_EXIT,
  guestRunDirectory,
  shellQuote,
  type WrapperInput,
} from './container-script-wrapper.js';

const run = promisify(execFile);
const roots: string[] = [];
const RUN_ID = '6172518f-5edb-402b-ac2a-c0a899f53b0e';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const hasCommand = (name: string): boolean => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;
const shellReady = hasCommand('timeout') && hasCommand('install') && hasCommand('tail');

type TestFile = { name: string; content: string; destination: WrapperInput['files'][number]['destination'] };

/** Lay out a run directory as the runner does, execute the wrapper, and read the results. */
async function execute(
  script: string,
  options: Partial<Omit<WrapperInput, 'files'>> & { files?: TestFile[] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'nyabase-wrapper-'));
  roots.push(root);
  const runs = join(root, 'script-runs');
  const dir = guestRunDirectory(RUN_ID, runs);
  await mkdir(join(dir, 'files'), { recursive: true });
  await writeFile(join(dir, 'script'), script, { mode: 0o700 });
  for (const file of options.files ?? []) await writeFile(join(dir, 'files', file.name), file.content);
  const wrapper = buildWrapper({
    runId: RUN_ID,
    timeoutSeconds: options.timeoutSeconds ?? 10,
    files: (options.files ?? []).map((file) => ({ name: file.name, destination: file.destination })),
    environment: options.environment ?? { NYABASE_LOGIN_USER: userInfo().username },
    runsDirectory: runs,
  });
  await writeFile(join(dir, 'wrapper'), wrapper, { mode: 0o700 });
  await run('sh', [join(dir, 'wrapper')], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  const exists = async (name: string) => stat(join(dir, name)).then(() => true, () => false);
  return {
    root,
    rc: Number((await readFile(join(dir, 'rc'), 'utf8')).trim()),
    output: await readFile(join(dir, 'output'), 'utf8'),
    timedOut: await exists('timed_out'),
    leftovers: (await Promise.all(['rc.tmp', 'rc.final', 'output.tmp'].map(exists))).some(Boolean),
  };
}

describe('shellQuote', () => {
  it('quotes any text as one word', async () => {
    const value = `it's "a" $HOME \`x\` \\ 服务器 1\nline`;
    const { stdout } = await run('sh', ['-c', `printf %s ${shellQuote(value)}`]);
    expect(stdout).toBe(value);
    expect(() => shellQuote('a\u0000b')).toThrow();
  });
});

describe('buildWrapper', () => {
  it('rejects a run id or environment name that could break out of the script', () => {
    expect(() => buildWrapper({ runId: '../x', timeoutSeconds: 10, files: [], environment: {} })).toThrow();
    expect(() => buildWrapper({ runId: RUN_ID, timeoutSeconds: 10, files: [], environment: { 'X;rm': 'y' } })).toThrow();
  });

  it('is valid sh', async () => {
    const wrapper = buildWrapper({
      runId: RUN_ID,
      timeoutSeconds: 600,
      files: [{ name: 'a.conf', destination: { path: "/etc/it's here.conf", mode: '0644', owner: 'login_user' } }],
      environment: { NYABASE_SERVER_NAME: "h200 '1'" },
    });
    await expect(run('sh', ['-n', '-c', wrapper])).resolves.toBeDefined();
  });
});

describe.skipIf(!shellReady)('the wrapper in a shell', () => {
  it('runs the script with the environment and records its exit code and output', async () => {
    const result = await execute('#!/bin/sh\necho "on $NYABASE_SERVER_NAME"; echo oops >&2; exit 3\n', {
      environment: { NYABASE_SERVER_NAME: "h200 '1' 服务器", NYABASE_LOGIN_USER: userInfo().username },
    });
    expect(result.rc).toBe(3);
    expect(result.output).toBe("on h200 '1' 服务器\noops\n");
    expect(result.timedOut).toBe(false);
    expect(result.leftovers).toBe(false);
  });

  it('installs files atomically before the script runs, with mode and owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nyabase-install-'));
    roots.push(root);
    const target = join(root, 'etc', 'deep', 'x.conf');
    const result = await execute(`#!/bin/sh\ncat ${shellQuote(target)}\n`, {
      files: [{ name: 'x.conf', content: 'hello\n', destination: { path: target, mode: '0640', owner: 'login_user' } }],
    });
    expect(result.rc).toBe(0);
    expect(result.output).toBe('hello\n');
    const info = await stat(target);
    expect(info.mode & 0o7777).toBe(0o640);
    expect(info.uid).toBe(userInfo().uid);
    await expect(stat(`${target}.nyabase-tmp`)).rejects.toThrow();
  });

  it('fails the run without starting the script when a file cannot be installed', async () => {
    const result = await execute('#!/bin/sh\necho started\n', {
      files: [{ name: 'x.conf', content: 'x', destination: { path: '/proc/nyabase-cannot/x.conf', mode: '0644', owner: 'login_user' } }],
    });
    expect(result.rc).toBe(GUEST_INSTALL_FAILED_EXIT);
    expect(result.output).toContain('nyabase: could not install /proc/nyabase-cannot/x.conf');
    expect(result.output).not.toContain('started');
  });

  it('keeps only the end of a long output', async () => {
    const result = await execute('#!/bin/sh\nhead -c 200000 /dev/zero | tr "\\0" a; echo END\n');
    expect(result.rc).toBe(0);
    expect(Buffer.byteLength(result.output)).toBe(CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES);
    expect(result.output.endsWith('aEND\n')).toBe(true);
  });

  it('kills a script that outlives its timeout and marks the run timed out', async () => {
    const started = Date.now();
    const result = await execute('#!/bin/sh\necho before; sleep 30; echo after\n', { timeoutSeconds: 1 });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.rc).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.output).toBe('before\n');
  });

  it('does not call an own exit code of 124 a timeout', async () => {
    const result = await execute('#!/bin/sh\nexit 124\n', { timeoutSeconds: 30 });
    expect(result.rc).toBe(124);
    expect(result.timedOut).toBe(false);
  });
});
