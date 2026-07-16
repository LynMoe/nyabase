import { AgentTaskKind, RemoteFsType, type RemoteFsMountSpec } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import type { DataDirsManager } from '../../datadirs/data-dirs.js';
import { PhysicalReferenceGuardError } from '../../docker/physical-reference-guard.js';
import { FsCleanupIncompleteError } from '../../fs/fs-driver.js';
import type { RemoteFsMounter } from '../../fs/remote-fs-mounter.js';
import { IncompleteTaskError, ManagedTaskError } from '../task-handler.js';
import { RemoteFsTaskHandler } from './remote-fs-task.handler.js';

describe('RemoteFsTaskHandler managed outcomes', () => {
  it('reports a freshly observed mount failure as terminal managed evidence', async () => {
    const { handler, mounter, dataDirs } = makeHandler({
      applyMount: vi.fn().mockRejectedValue(new Error('NFS server unavailable')),
      verifyMounted: vi.fn().mockResolvedValue(false),
    });

    await expect(handler.ensure(AgentTaskKind.RemoteFsEnsure, remoteSpec()))
      .rejects.toMatchObject({
        name: ManagedTaskError.name,
        taskError: { code: 'remote_fs_mount_failed' },
        observed: { id: 'remote-a', mounted: false },
      });
    expect(mounter.verifyMounted).toHaveBeenCalledWith(remoteSpec());
    expect(dataDirs.addSource).not.toHaveBeenCalled();
  });

  it('reports a fail-closed unmount conflict with the residual mount identity', async () => {
    const { handler, dataDirs } = makeHandler({
      removeMount: vi.fn().mockRejectedValue(new Error('unexpected source mounted')),
      verifyUnmounted: vi.fn().mockResolvedValue(false),
    });

    await expect(handler.ensure(AgentTaskKind.RemoteFsAbsent, {
      ...remoteSpec(),
    })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'remote_fs_remove_failed' },
      observed: { id: 'remote-a', mounted: true },
    });
    expect(dataDirs.removeSource).not.toHaveBeenCalled();
  });

  it('keeps the task retryable when the post-failure probe is itself unavailable', async () => {
    const original = new Error('mount command transport lost');
    const { handler } = makeHandler({
      applyMount: vi.fn().mockRejectedValue(original),
      verifyMounted: vi.fn().mockRejectedValue(new Error('cannot read mount table')),
    });

    await expect(handler.ensure(AgentTaskKind.RemoteFsEnsure, remoteSpec()))
      .rejects.toBe(original);
  });

  it('does not report ensure success when secret cleanup is incomplete after the mount exists', async () => {
    const cleanupError = new FsCleanupIncompleteError(
      'CephFS attempt secret cleanup is incomplete',
      new Error('permission denied'),
    );
    const { handler, mounter, dataDirs } = makeHandler({
      applyMount: vi.fn().mockRejectedValue(cleanupError),
      verifyMounted: vi.fn().mockResolvedValue(true),
    });

    await expect(handler.ensure(AgentTaskKind.RemoteFsEnsure, remoteSpec()))
      .rejects.toMatchObject({
        name: IncompleteTaskError.name,
        taskError: {
          code: 'remote_fs_cleanup_incomplete',
          details: { operation: 'ensure', id: 'remote-a', cause: 'permission denied' },
        },
      });
    expect(mounter.verifyMounted).not.toHaveBeenCalled();
    expect(dataDirs.addSource).not.toHaveBeenCalled();
  });

  it('does not report absent success when stale secret cleanup remains incomplete', async () => {
    const cleanupError = new FsCleanupIncompleteError(
      'CephFS stale secret cleanup is incomplete',
      new Error('cleanup helper timed out'),
    );
    const { handler, mounter, dataDirs } = makeHandler({
      removeMount: vi.fn().mockRejectedValue(cleanupError),
      verifyUnmounted: vi.fn().mockResolvedValue(true),
    });

    await expect(handler.ensure(AgentTaskKind.RemoteFsAbsent, remoteSpec()))
      .rejects.toMatchObject({
        name: IncompleteTaskError.name,
        taskError: {
          code: 'remote_fs_cleanup_incomplete',
          details: { operation: 'absent', id: 'remote-a', cause: 'cleanup helper timed out' },
        },
      });
    expect(mounter.verifyUnmounted).not.toHaveBeenCalled();
    expect(dataDirs.removeSource).not.toHaveBeenCalled();
  });

  it('returns a terminal no-effect failure when a running Docker bind definitely blocks replacement', async () => {
    const blocked = new PhysicalReferenceGuardError(
      'physical_path_referenced',
      'running runtime retains mount',
      { targetPath: remoteSpec().hostMountPoint, runtimeId: 'runtime-drift' },
    );
    const { handler, mounter } = makeHandler({
      applyMount: vi.fn().mockRejectedValue(blocked),
    });

    await expect(handler.ensure(AgentTaskKind.RemoteFsEnsure, remoteSpec()))
      .rejects.toMatchObject({
        name: ManagedTaskError.name,
        taskError: { code: 'physical_path_referenced' },
        observed: {
          applied: false,
          residualPresent: true,
          id: 'remote-a',
          runtimeId: 'runtime-drift',
        },
      });
    expect(mounter.verifyMounted).not.toHaveBeenCalled();
  });

  it('keeps Absent non-terminal when Docker observation cannot prove safety', async () => {
    const blocked = new PhysicalReferenceGuardError(
      'physical_reference_observation_failed',
      'dockerd inspect unavailable',
      { targetPath: remoteSpec().hostMountPoint, phase: 'inspect' },
    );
    const { handler, mounter } = makeHandler({
      removeMount: vi.fn().mockRejectedValue(blocked),
    });

    await expect(handler.ensure(AgentTaskKind.RemoteFsAbsent, remoteSpec()))
      .rejects.toMatchObject({
        name: IncompleteTaskError.name,
        taskError: { code: 'physical_reference_observation_failed' },
      });
    expect(mounter.verifyUnmounted).not.toHaveBeenCalled();
  });
});

function makeHandler(overrides: Record<string, unknown> = {}) {
  const mounter = {
    applyMount: vi.fn().mockResolvedValue(remoteSpec()),
    removeMount: vi.fn().mockResolvedValue(undefined),
    verifyMounted: vi.fn().mockResolvedValue(true),
    verifyUnmounted: vi.fn().mockResolvedValue(true),
    getSpec: vi.fn().mockReturnValue(remoteSpec()),
    ...overrides,
  };
  const dataDirs = {
    addSource: vi.fn(),
    removeSource: vi.fn(),
  };
  return {
    handler: new RemoteFsTaskHandler(
      mounter as unknown as RemoteFsMounter,
      dataDirs as unknown as DataDirsManager,
    ),
    mounter,
    dataDirs,
  };
}

function remoteSpec(): RemoteFsMountSpec {
  return {
    id: 'remote-a',
    hostMountPoint: '/mnt/remote-fs/remote-a',
    options: '',
    params: {
      type: RemoteFsType.Nfs,
      nfsServer: '10.0.0.10',
      exportPath: '/exports/project',
      version: '4.2',
    },
  };
}
