import { execFile } from 'child_process';
import {
  chmod,
  chown,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  mutateProjectsFile,
  PROJECTS_FILE_HELPER_SCRIPT,
  assertAtomicFileExchangeCapability,
  readProjectsFileSnapshot,
} from './projects-file-helper.js';

const execFileAsync = promisify(execFile);

describe('exact /etc/projects helper', () => {
  const roots: string[] = [];
  let helperRoot = '';
  let helperPath = '';
  const previousTestHelper = process.env.NYABASE_TEST_ATOMIC_FILE_EXCHANGE_HELPER;

  beforeAll(async () => {
    helperRoot = await mkdtemp(join(tmpdir(), 'nyabase-atomic-exchange-'));
    helperPath = join(helperRoot, 'nyabase-atomic-file-exchange');
    await execFileAsync('cc', [
      '-O2', '-Wall', '-Wextra', '-Werror',
      '-o', helperPath,
      join(process.cwd(), '../../tools/atomic-file-exchange/atomic-file-exchange.c'),
    ]);
    process.env.NYABASE_TEST_ATOMIC_FILE_EXCHANGE_HELPER = helperPath;
  });

  afterAll(async () => {
    if (previousTestHelper === undefined) {
      delete process.env.NYABASE_TEST_ATOMIC_FILE_EXCHANGE_HELPER;
    } else {
      process.env.NYABASE_TEST_ATOMIC_FILE_EXCHANGE_HELPER = previousTestHelper;
    }
    await rm(helperRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(contents: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'nyabase-projects-helper-'));
    roots.push(root);
    const file = join(root, 'projects');
    await writeFile(file, contents, { mode: 0o644 });
    return file;
  }

  async function run(operation: 'ensure' | 'remove', project: string, path: string, file: string) {
    return execFileAsync(process.execPath, [
      '-e', PROJECTS_FILE_HELPER_SCRIPT, operation, project, path, file,
    ]);
  }

  it('pins a safe repo-built helper and proves the real mount exchange capability', async () => {
    expect(() => assertAtomicFileExchangeCapability(tmpdir(), helperPath)).not.toThrow();
    await chmod(helperPath, 0o777);
    expect(() => assertAtomicFileExchangeCapability(tmpdir(), helperPath))
      .toThrow('unsafe atomic exchange helper');
    await chmod(helperPath, 0o755);
  });

  it('atomically creates one exact owner and is idempotent for that owner', async () => {
    const file = await fixture('10008:/data/sibling\n');
    await run('ensure', '10007', '/data/target', file);
    await run('ensure', '10007', '/data/target', file);
    expect(await readFile(file, 'utf8')).toBe(
      '10008:/data/sibling\n10007:/data/target\n',
    );
  });

  it('rejects another owner and duplicate rows without modifying the file', async () => {
    const conflict = await fixture('10008:/data/target\n');
    await expect(run('ensure', '10007', '/data/target', conflict)).rejects.toThrow();
    expect(await readFile(conflict, 'utf8')).toBe('10008:/data/target\n');

    const duplicate = await fixture('10007:/data/target\n10007:/data/target\n');
    await expect(run('remove', '*', '/data/target', duplicate)).rejects.toThrow();
    expect(await readFile(duplicate, 'utf8')).toBe(
      '10007:/data/target\n10007:/data/target\n',
    );
  });

  it('removes only one unambiguous exact registration', async () => {
    const file = await fixture('10007:/data/target\n10008:/data/sibling\n');
    await run('remove', '*', '/data/target', file);
    expect(await readFile(file, 'utf8')).toBe('10008:/data/sibling\n');
  });

  it('refuses a symlink or writable projects file before rewriting it', async () => {
    const target = await fixture('10008:/data/sibling\n');
    const link = `${target}-link`;
    await symlink(target, link);
    await expect(run('ensure', '10007', '/data/target', link)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('10008:/data/sibling\n');

    await chmod(target, 0o666);
    await expect(run('ensure', '10007', '/data/target', target)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('10008:/data/sibling\n');
  });

  it('aborts an inode replacement immediately before publish and preserves the replacement', async () => {
    const file = await fixture('10008:/data/sibling\n');
    const replacement = `${file}.replacement`;
    await writeFile(replacement, '10009:/data/concurrent\n', { mode: 0o644 });

    expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file, {
      beforePublish: () => {
        require('fs').renameSync(replacement, file);
      },
    })).toThrow('changed before publish');

    expect(await readFile(file, 'utf8')).toBe('10009:/data/concurrent\n');
    expect((await readdir(join(file, '..'))).some((name) => name.includes('.nyabase-'))).toBe(false);
  });

  it('aborts an in-place content change immediately before publish', async () => {
    const file = await fixture('10008:/data/sibling\n');

    expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file, {
      beforePublish: () => {
        require('fs').writeFileSync(file, '10009:/data/concurrent\n', { mode: 0o644 });
      },
    })).toThrow('changed before publish');

    expect(await readFile(file, 'utf8')).toBe('10009:/data/concurrent\n');
  });

  it('uses atomic no-replace publication when the file was initially absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nyabase-projects-helper-'));
    roots.push(root);
    const file = join(root, 'projects');

    expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file, {
      beforePublish: () => {
        require('fs').writeFileSync(file, '10009:/data/concurrent\n', { mode: 0o644 });
      },
    })).toThrow('appeared before publish');

    expect(await readFile(file, 'utf8')).toBe('10009:/data/concurrent\n');
  });

  it('atomically captures and restores an in-place writer after the final safe read', async () => {
    const file = await fixture('10008:/data/sibling\n');

    expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file, {
      beforeExchange: () => {
        require('fs').writeFileSync(file, '10009:/data/concurrent\n', { mode: 0o644 });
      },
    })).toThrow('changed during atomic publish');

    expect(await readFile(file, 'utf8')).toBe('10009:/data/concurrent\n');
    expect((await readdir(join(file, '..'))).some((name) => name.includes('.nyabase-')))
      .toBe(false);
  });

  it('atomically captures and restores a replacement inode after the final safe read', async () => {
    const file = await fixture('10008:/data/sibling\n');
    const replacement = `${file}.replacement`;
    await writeFile(replacement, '10009:/data/concurrent\n', { mode: 0o644 });

    expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file, {
      beforeExchange: () => {
        require('fs').renameSync(replacement, file);
      },
    })).toThrow('changed during atomic publish');

    expect(await readFile(file, 'utf8')).toBe('10009:/data/concurrent\n');
    expect((await readdir(join(file, '..'))).some((name) => name.includes('.nyabase-')))
      .toBe(false);
  });

  it('does not recreate a target deleted after the final safe read', async () => {
    const file = await fixture('10008:/data/sibling\n');

    expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file, {
      beforeExchange: () => {
        require('fs').unlinkSync(file);
      },
    })).toThrow();

    expect(readProjectsFileSnapshot(file)).toMatchObject({ exists: false });
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(join(file, '..'))).some((name) => name.includes('.nyabase-')))
      .toBe(false);
  });

  for (const crashPoint of [
    'afterJournal',
    'afterExchange',
    'afterVerify',
    'afterCleanup',
  ] as const) {
    it(`durably reconciles a simulated crash ${crashPoint}`, async () => {
      const original = '10008:/data/sibling\n';
      const candidate = `${original}10007:/data/target\n`;
      const file = await fixture(original);

      expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file, {
        [crashPoint]: () => {
          throw new Error(`simulated crash ${crashPoint}`);
        },
      })).toThrow(`simulated crash ${crashPoint}`);

      // The ordinary reader owns recovery under the same physical flock. A
      // pre-exchange crash keeps the original; every later durable state
      // completes the already-published candidate.
      const recovered = readProjectsFileSnapshot(file);
      expect(recovered.contents).toBe(crashPoint === 'afterJournal' ? original : candidate);
      expect(await readFile(file, 'utf8')).toBe(recovered.contents);
      expect((await readdir(join(file, '..'))).some((name) => name.includes('.nyabase-')))
        .toBe(false);
    });
  }

  it('makes a reader reconcile an exchanged transaction before returning bytes', async () => {
    const file = await fixture('10008:/data/sibling\n');
    expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file, {
      afterExchange: () => {
        throw new Error('reader recovery fixture');
      },
    })).toThrow('reader recovery fixture');

    const snapshot = readProjectsFileSnapshot(file);
    expect(snapshot.contents).toBe('10008:/data/sibling\n10007:/data/target\n');
    expect((await readdir(join(file, '..'))).some((name) => name.includes('.nyabase-')))
      .toBe(false);
  });

  it('preserves both sides and fail-stops on an unprovable third recovery state', async () => {
    const file = await fixture('10008:/data/sibling\n');
    expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file, {
      afterJournal: () => {
        throw new Error('third-state fixture');
      },
    })).toThrow('third-state fixture');
    await writeFile(file, '10009:/data/external-winner\n', { mode: 0o644 });

    expect(() => readProjectsFileSnapshot(file)).toThrow('ambiguous recovery state');
    expect(await readFile(file, 'utf8')).toBe('10009:/data/external-winner\n');
    const recoveryNames = (await readdir(join(file, '..')))
      .filter((name) => name.includes('.nyabase-'));
    expect(recoveryNames.some((name) => name.endsWith('.tmp'))).toBe(true);
    expect(recoveryNames.some((name) => name.endsWith('transaction.json'))).toBe(true);
  });

  it('shares nofollow, link-count, ownership, and mode checks between readers and writers', async () => {
    const file = await fixture('10008:/data/sibling\n');
    const alias = `${file}.hardlink`;
    await link(file, alias);
    expect(() => readProjectsFileSnapshot(file)).toThrow('unsafe projects file');
    expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file))
      .toThrow('unsafe projects file');

    await rm(alias);
    const dangling = `${file}.dangling`;
    await symlink(`${file}.missing`, dangling);
    expect(() => readProjectsFileSnapshot(dangling)).toThrow('unsafe projects file');
    expect(() => mutateProjectsFile('ensure', '10007', '/data/target', dangling))
      .toThrow('unsafe projects file');

    await chmod(file, 0o664);
    expect(() => readProjectsFileSnapshot(file)).toThrow('unsafe projects file');
    expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file))
      .toThrow('unsafe projects file');
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() !== 0)(
    'rejects a projects file whose group is not root',
    async () => {
      const file = await fixture('10008:/data/sibling\n');
      await chown(file, 0, 1);
      expect(() => readProjectsFileSnapshot(file)).toThrow('unsafe projects file');
      expect(() => mutateProjectsFile('ensure', '10007', '/data/target', file))
        .toThrow('unsafe projects file');
    },
  );
});
