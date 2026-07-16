import { AgentTaskKind } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import {
  DataDirOperationIncompleteError,
  type DataDirsManager,
} from '../../datadirs/data-dirs.js';
import { PhysicalReferenceGuardError } from '../../docker/physical-reference-guard.js';
import type { RemoteFsMounter } from '../../fs/remote-fs-mounter.js';
import type { XfsQuotaManager } from '../../quota/xfs-quota.js';
import type { AgentWsClient } from '../../ws/client.js';
import { IncompleteTaskError, ManagedTaskError } from '../task-handler.js';
import { DataDirTaskHandler } from './data-dir-task.handler.js';

const RESOURCE_ID = 'datadir-a';
const IDENTITY = 'local:xfs:uuid-a';
const PATH = `/data/.nyabase/dirs/${RESOURCE_ID}/data`;
const ensurePayload = {
  resourceId: RESOURCE_ID,
  generation: 1,
  diskId: 'disk-a',
  sourceIdentity: IDENTITY,
  quotaRequired: true,
  uid: 1001,
  numericUserId: 7,
  quotaGeneration: 3,
  diskBytes: 8192,
};
const absentPayload = {
  resourceId: RESOURCE_ID,
  generation: 2,
  diskId: 'disk-a',
  sourceIdentity: IDENTITY,
  numericUserId: 7,
};

describe('DataDirTaskHandler', () => {
  it('verifies marker identity, recursive ownership, and pinned quota assignment', async () => {
    const inspectDir = vi.fn()
      .mockReturnValueOnce(observation(false))
      .mockReturnValue(observation(true));
    const addPathToProject = vi.fn().mockResolvedValue(undefined);
    const inspectPathAssignment = vi.fn().mockResolvedValue({ assigned: true });
    const { handler } = makeHandler({
      inspectDir,
      createDir: vi.fn().mockResolvedValue({ path: PATH, created: true }),
    }, { addPathToProject, inspectPathAssignment });

    const result = await handler.ensure(AgentTaskKind.DataDirEnsure, ensurePayload);
    await expect(handler.verify(AgentTaskKind.DataDirEnsure, ensurePayload, result)).resolves.toBeUndefined();
    expect(addPathToProject).toHaveBeenCalledWith(7, '/proc/pinned/data', PATH);
    expect(inspectPathAssignment).toHaveBeenCalledWith(7, '/proc/pinned/data', PATH);
  });

  it('self-heals the durable quota limit before creating the directory', async () => {
    const sequence: string[] = [];
    const createDir = vi.fn(async () => { sequence.push('create'); });
    const setLimit = vi.fn(async () => { sequence.push('quota'); });
    const { handler } = makeHandler({
      inspectDir: vi.fn().mockReturnValueOnce(observation(false)).mockReturnValue(observation(true)),
      createDir,
    }, { setLimit });

    await handler.ensure(AgentTaskKind.DataDirEnsure, ensurePayload);

    expect(sequence).toEqual(['quota', 'create']);
    expect(setLimit).toHaveBeenCalledWith(7, 8192);
  });

  it('does not create a directory when quota apply has a fresh mismatch', async () => {
    const createDir = vi.fn();
    const { handler } = makeHandler({
      createDir,
      inspectDir: vi.fn().mockReturnValue(observation(false)),
    }, {
      setLimit: vi.fn().mockRejectedValue(new Error('xfs limit failed')),
      getUsageForUser: vi.fn().mockResolvedValue({
        numericUserId: 7, projectId: 10007, usedBytes: 0, hardLimitBytes: 4096,
      }),
    });

    await expect(handler.ensure(AgentTaskKind.DataDirEnsure, ensurePayload)).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'data_dir_quota_mismatch' },
      observed: {
        exists: false,
        expectedResourceId: RESOURCE_ID,
        applied: false,
        quotaObservation: {
          expectedHardLimitBytes: 8192,
        },
      },
    });
    expect(createDir).not.toHaveBeenCalled();
  });

  it('reports a fully observed recursive ownership mismatch as managed failure', async () => {
    const { handler } = makeHandler({
      inspectDir: vi.fn().mockReturnValue(observation(true)),
      verifyOwnership: vi.fn().mockResolvedValue(`${PATH}/partial-child`),
    }, { inspectPathAssignment: vi.fn().mockResolvedValue({ assigned: true }) });

    await expect(handler.verify(AgentTaskKind.DataDirEnsure, ensurePayload, {
      ...observation(true), quotaAssigned: true,
    })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      observed: { ownershipMismatch: `${PATH}/partial-child`, expectedUid: 1001 },
    });
  });

  it('wraps final quota drift with a fresh complete DataDir observation', async () => {
    const inspectDir = vi.fn()
      .mockReturnValueOnce(observation(false))
      .mockReturnValue(observation(true));
    const { handler } = makeHandler({
      inspectDir,
      createDir: vi.fn().mockResolvedValue({ path: PATH, created: true }),
    }, {
      addPathToProject: vi.fn().mockResolvedValue(undefined),
      getUsageForUser: vi.fn().mockResolvedValue({
        numericUserId: 7,
        projectId: 10007,
        usedBytes: 0,
        hardLimitBytes: 4096,
      }),
    });

    const result = await handler.ensure(AgentTaskKind.DataDirEnsure, ensurePayload);
    await expect(handler.verify(
      AgentTaskKind.DataDirEnsure,
      ensurePayload,
      result,
    )).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'data_dir_quota_mismatch' },
      observed: {
        path: PATH,
        exists: true,
        isDirectory: true,
        uid: 1001,
        gid: 1001,
        resourceId: RESOURCE_ID,
        expectedResourceId: RESOURCE_ID,
        quotaObservation: {
          numericUserId: 7,
          expectedHardLimitBytes: 8192,
          observed: {
            numericUserId: 7,
            projectId: 10007,
            hardLimitBytes: 4096,
          },
        },
      },
    });
    expect(inspectDir).toHaveBeenCalledTimes(4);
  });

  it('keeps final quota drift incomplete when the fresh DataDir observation fails', async () => {
    let calls = 0;
    const inspectDir = vi.fn(() => {
      calls += 1;
      if (calls === 1) return observation(false);
      if (calls <= 3) return observation(true);
      throw new Error('fresh directory probe unavailable');
    });
    const { handler } = makeHandler({
      inspectDir,
      createDir: vi.fn().mockResolvedValue({ path: PATH, created: true }),
    }, {
      addPathToProject: vi.fn().mockResolvedValue(undefined),
      getUsageForUser: vi.fn().mockResolvedValue({
        numericUserId: 7, projectId: 10007, usedBytes: 0, hardLimitBytes: 4096,
      }),
    });

    const result = await handler.ensure(AgentTaskKind.DataDirEnsure, ensurePayload);
    await expect(handler.verify(
      AgentTaskKind.DataDirEnsure,
      ensurePayload,
      result,
    )).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: {
        code: 'data_dir_final_observation_unavailable',
        details: {
          expectedResourceId: RESOURCE_ID,
          quotaObservation: { expectedHardLimitBytes: 8192 },
        },
      },
    });
  });

  it('rolls forward marker cleanup when the data inode is already absent', async () => {
    const deleteDir = vi.fn();
    const removePathFromProject = vi.fn();
    const { handler } = makeHandler({ inspectDir: vi.fn().mockReturnValue(observation(false)), deleteDir }, {
      removePathFromProject,
      isPathRegisteredToProject: vi.fn().mockReturnValue(false),
    });

    const result = await handler.ensure(AgentTaskKind.DataDirAbsent, absentPayload);
    await expect(handler.verify(AgentTaskKind.DataDirAbsent, absentPayload, result)).resolves.toBeUndefined();
    expect(deleteDir).toHaveBeenCalledWith('disk-a', RESOURCE_ID, IDENTITY);
    expect(removePathFromProject).toHaveBeenCalledWith(7, PATH);
  });

  it('keeps deletion pending while either data or marker residue remains', async () => {
    const { handler } = makeHandler({
      inspectDir: vi.fn().mockReturnValue(observation(true)),
    });
    await expect(handler.verify(AgentTaskKind.DataDirAbsent, absentPayload, {
      ...observation(false), resourceId: null, quotaAssigned: true,
    })).rejects.toBeInstanceOf(IncompleteTaskError);
  });

  it('keeps a timed-out tombstone removal pending while physical residue remains', async () => {
    const inspectDir = vi.fn()
      .mockReturnValueOnce(observation(true))
      .mockReturnValue({ ...observation(false), resourceId: RESOURCE_ID });
    const { handler } = makeHandler({
      inspectDir,
      deleteDir: vi.fn().mockRejectedValue(new DataDirOperationIncompleteError(
        'remove-data timed out',
        'remove-data(datadir-a)',
      )),
    });

    await expect(handler.ensure(AgentTaskKind.DataDirAbsent, absentPayload)).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'data_dir_remove_incomplete' },
    });
  });

  it('does not mutate when the mounted source identity differs from the task', async () => {
    const deleteDir = vi.fn();
    const { handler } = makeHandler({
      inspectSource: vi.fn().mockReturnValue({
        sourceId: 'disk-a', kind: 'local', root: '/data', identity: 'local:xfs:other',
        configured: true, exists: true, isDirectory: true, mounted: true,
        fsType: 'xfs', ready: true, device: '1',
      }),
      deleteDir,
    });

    await expect(handler.ensure(AgentTaskKind.DataDirAbsent, absentPayload)).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'data_dir_source_unavailable' },
    });
    expect(deleteDir).not.toHaveBeenCalled();
  });

  it('does not delete a DataDir while a fresh running Docker bind references it', async () => {
    const deleteDir = vi.fn();
    const guard = {
      assertNoRunningBindReferences: vi.fn().mockRejectedValue(new PhysicalReferenceGuardError(
        'physical_path_referenced',
        'runtime retains DataDir',
        { targetPath: PATH, runtimeId: 'runtime-drift' },
      )),
    };
    const { handler } = makeHandler({
      inspectDir: vi.fn().mockReturnValue(observation(true)),
      deleteDir,
    }, {}, guard);

    await expect(handler.ensure(AgentTaskKind.DataDirAbsent, absentPayload)).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'physical_path_referenced' },
      observed: {
        applied: false,
        residualPresent: true,
        resourceId: RESOURCE_ID,
        runtimeId: 'runtime-drift',
      },
    });
    expect(guard.assertNoRunningBindReferences).toHaveBeenCalledWith(PATH);
    expect(deleteDir).not.toHaveBeenCalled();
  });

  it('keeps apply pending when the physical postcondition cannot be observed', async () => {
    const inspectDir = vi.fn()
      .mockReturnValueOnce(observation(false))
      .mockImplementationOnce(() => { throw new Error('source disappeared during probe'); });
    const { handler } = makeHandler({
      inspectDir,
      createDir: vi.fn().mockRejectedValue(new Error('create transport failed')),
    });

    await expect(handler.ensure(AgentTaskKind.DataDirEnsure, ensurePayload)).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'data_dir_apply_unconfirmed' },
    });
  });

  it('keeps apply pending when a bounded physical mutation times out', async () => {
    const inspectDir = vi.fn()
      .mockReturnValueOnce(observation(false))
      .mockReturnValue(observation(true));
    const { handler } = makeHandler({
      inspectDir,
      createDir: vi.fn().mockRejectedValue(new DataDirOperationIncompleteError(
        'chown timed out',
        'chown(datadir-a)',
      )),
    });

    await expect(handler.ensure(AgentTaskKind.DataDirEnsure, ensurePayload)).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'data_dir_apply_incomplete' },
    });
  });

  it('keeps verification pending when recursive ownership cannot be fully observed', async () => {
    const { handler } = makeHandler({
      inspectDir: vi.fn().mockReturnValue(observation(true)),
      verifyOwnership: vi.fn().mockRejectedValue(new DataDirOperationIncompleteError(
        'ownership entry cap exceeded',
        'ownership-observation',
      )),
    });

    await expect(handler.verify(AgentTaskKind.DataDirEnsure, ensurePayload, {
      ...observation(true), quotaAssigned: true,
    })).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'data_dir_ownership_unobservable' },
    });
  });
});

function observation(exists: boolean) {
  return {
    path: PATH,
    exists,
    isDirectory: exists,
    uid: exists ? 1001 : null,
    gid: exists ? 1001 : null,
    resourceId: exists ? RESOURCE_ID : null,
  };
}

function makeHandler(
  dataDirsOverrides: Record<string, unknown> = {},
  quotaOverrides: Record<string, unknown> = {},
  physicalReferenceGuard = {
    assertNoRunningBindReferences: vi.fn().mockResolvedValue(undefined),
  },
) {
  const dataDirs = {
    getSource: vi.fn().mockReturnValue({
      kind: 'local', id: 'disk-a', root: '/data', identity: IDENTITY, quotaEnabled: true,
    }),
    inspectSource: vi.fn().mockReturnValue({
      sourceId: 'disk-a', kind: 'local', root: '/data', identity: IDENTITY,
      configured: true, exists: true, isDirectory: true, mounted: true,
      fsType: 'xfs', ready: true, device: '1',
    }),
    inspectDir: vi.fn(),
    createDir: vi.fn(),
    deleteDir: vi.fn(),
    verifyOwnership: vi.fn().mockResolvedValue(null),
    withPinnedDir: vi.fn((_sourceId, _resourceId, _identity, callback) =>
      callback('/proc/pinned/data', PATH)),
    ...dataDirsOverrides,
  };
  const quota = {
    setLimit: vi.fn().mockResolvedValue(undefined),
    getUsageForUser: vi.fn().mockResolvedValue({
      numericUserId: 7, projectId: 10007, usedBytes: 0, hardLimitBytes: 8192,
    }),
    addPathToProject: vi.fn(),
    inspectPathAssignment: vi.fn(),
    removePathFromProject: vi.fn(),
    isPathRegisteredToProject: vi.fn().mockReturnValue(false),
    ...quotaOverrides,
  };
  const ws = { emit: vi.fn() };
  const remoteFsMounter = { getSpec: vi.fn(), verifyMounted: vi.fn() };
  return {
    handler: new DataDirTaskHandler(
      dataDirs as unknown as DataDirsManager,
      quota as unknown as XfsQuotaManager,
      remoteFsMounter as unknown as RemoteFsMounter,
      ws as unknown as AgentWsClient,
      physicalReferenceGuard,
    ),
  };
}
