import { mkdtemp, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { DataDirsManager } from './data-dirs.js';

describe('DataDirsManager', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('does not report Docker root internals as user data dirs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nyabase-data-dirs-'));
    tempDirs.push(root);
    await mkdir(join(root, 'overlay2'));
    await mkdir(join(root, 'containers'));
    await mkdir(join(root, 'project-a'));

    const manager = new DataDirsManager(undefined, root);
    manager.addSource({ kind: 'local', id: 'disk-a', root, quotaEnabled: true });

    await expect(manager.listAllDirs()).resolves.toEqual([
      {
        sourceKind: 'local',
        sourceId: 'disk-a',
        name: 'project-a',
        hostPath: join(root, 'project-a'),
      },
    ]);
  });
});
