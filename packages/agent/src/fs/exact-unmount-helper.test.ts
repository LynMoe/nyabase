import { execFile } from 'child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import { EXACT_UNMOUNT_HELPER_SCRIPT } from './exact-unmount-helper.js';

const execFileAsync = promisify(execFile);

describe('exact unmount last-mile helper', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(lines: string[]) {
    const root = await mkdtemp(join(tmpdir(), 'nyabase-exact-umount-'));
    roots.push(root);
    const mountInfo = join(root, 'mountinfo');
    const calls = join(root, 'calls');
    const umount = join(root, 'umount');
    await writeFile(mountInfo, `${lines.join('\n')}\n`);
    await writeFile(umount, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(calls)}\n`);
    await chmod(umount, 0o755);
    return { mountInfo, calls, umount };
  }

  const expected = {
    mountId: 42,
    parentMountId: 1,
    deviceId: '0:42',
    fsRoot: '/',
    mountPoint: '/mnt/remote-fs/remote-a',
    fsType: 'nfs',
    src: '10.0.0.10:/exports/project',
    opts: 'rw,relatime,vers=4.2',
  };
  const line = '42 1 0:42 / /mnt/remote-fs/remote-a rw,relatime - nfs 10.0.0.10:/exports/project rw,vers=4.2';

  async function run(current: ReturnType<typeof fixture> extends Promise<infer T> ? T : never, value = expected) {
    return execFileAsync(process.execPath, [
      '-e', EXACT_UNMOUNT_HELPER_SCRIPT, JSON.stringify(value), current.mountInfo, current.umount,
    ]);
  }

  it('executes umount only after one exact mount-id match', async () => {
    const current = await fixture([line]);
    await run(current);
    expect(await readFile(current.calls, 'utf8')).toBe('--\n/mnt/remote-fs/remote-a\n');
  });

  it('rejects a last-mile identity swap and a stacked mount without an effect', async () => {
    const swapped = await fixture([line.replace(/^42 /, '43 ')]);
    await expect(run(swapped)).rejects.toThrow();
    await expect(access(swapped.calls)).rejects.toThrow();

    const stacked = await fixture([line, line.replace(/^42 /, '43 ')]);
    await expect(run(stacked)).rejects.toThrow();
    await expect(access(stacked.calls)).rejects.toThrow();
  });
});
