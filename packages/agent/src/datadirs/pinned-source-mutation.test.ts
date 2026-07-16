import * as fs from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DataDirsManager,
  spawnPinnedSourceMutation,
  type DataDirMutationDeadlineError,
  type DataSource,
} from './data-dirs.js';

describe('spawnPinnedSourceMutation', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('keeps a late child mutation on the original source after the parent fd number is reused', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'nyabase-pinned-child-'));
    tempDirs.push(fixtureRoot);
    const sourceA = join(fixtureRoot, 'source-a');
    const sourceB = join(fixtureRoot, 'source-b');
    fs.mkdirSync(sourceA);
    fs.mkdirSync(sourceB);

    const ready = join(fixtureRoot, 'ready');
    const release = join(fixtureRoot, 'release');
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    const parentSourceFd = fs.openSync(sourceA, flags);
    const script = [
      "const fs = require('fs');",
      "fs.writeFileSync(process.argv[1], 'ready');",
      'const timer = setInterval(() => {',
      '  if (!fs.existsSync(process.argv[2])) return;',
      '  clearInterval(timer);',
      "  fs.writeFileSync('/proc/self/fd/3/late-mutation', 'original-source');",
      '}, 1);',
    ].join('\n');
    const child = spawnPinnedSourceMutation(
      process.execPath,
      ['-e', script, ready, release],
      parentSourceFd,
      join(fixtureRoot, 'physical-mutation.lock'),
    );
    const childExit = waitForExit(child);

    let reusedFd: number | null = null;
    let parentFdOpen = true;
    try {
      await waitUntil(() => fs.existsSync(ready));
      fs.closeSync(parentSourceFd);
      parentFdOpen = false;

      // This is the original failure mode: another source immediately takes
      // the same numeric fd in the parent while the mutation child is late.
      reusedFd = fs.openSync(sourceB, flags);
      expect(reusedFd).toBe(parentSourceFd);

      fs.writeFileSync(release, 'go');
      await childExit;
      expect(fs.readFileSync(join(sourceA, 'late-mutation'), 'utf8')).toBe('original-source');
      expect(fs.existsSync(join(sourceB, 'late-mutation'))).toBe(false);
    } finally {
      if (reusedFd !== null) fs.closeSync(reusedFd);
      if (parentFdOpen) fs.closeSync(parentSourceFd);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('executes the real create, chown, delete-rename, and rm path successfully', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'nyabase-pinned-normal-'));
    tempDirs.push(sourceRoot);
    const source: DataSource = {
      kind: 'local',
      id: 'disk-a',
      root: sourceRoot,
      identity: 'local:xfs:test-source',
      quotaEnabled: true,
    };
    const fatalErrors: DataDirMutationDeadlineError[] = [];
    const manager = new DataDirsManager(undefined, undefined, (current) => {
      const stat = fs.lstatSync(current.root);
      return {
        sourceId: current.id,
        kind: current.kind,
        root: current.root,
        identity: current.identity,
        configured: true,
        exists: true,
        isDirectory: true,
        mounted: true,
        fsType: 'xfs',
        ready: true,
        device: String(stat.dev),
      };
    }, {
      mutationTimeoutMs: 2_000,
      physicalMutationLockPath: join(sourceRoot, '.host-physical-mutation.lock'),
      fatalHook: (error) => fatalErrors.push(error),
    });
    manager.addSource(source);

    const resourceId = 'datadir-normal';
    const durablePath = join(sourceRoot, '.nyabase', 'dirs', resourceId, 'data');
    await expect(manager.createDir(source.id, 0, resourceId, source.identity)).resolves.toEqual({
      path: durablePath,
      created: true,
    });
    expect(fs.existsSync(durablePath)).toBe(true);
    await expect(manager.deleteDir(source.id, resourceId, source.identity)).resolves.toBeUndefined();
    expect(fs.existsSync(durablePath)).toBe(false);
    expect(fatalErrors).toEqual([]);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for child readiness');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function waitForExit(child: ReturnType<typeof spawnPinnedSourceMutation>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for child exit')), 5_000);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`child exited ${signal ?? String(code)}`));
    });
  });
}
