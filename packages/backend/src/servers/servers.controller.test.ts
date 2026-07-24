import { GpuGrantMode } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { ServersController } from './servers.controller.js';

const gpus = [
  { index: 0, uuid: 'GPU-private-0', model: 'Test GPU 0', totalMemMiB: 8192 },
  { index: 1, uuid: 'GPU-private-1', model: 'Test GPU 1', totalMemMiB: 16_384 },
];

const disks = [
  {
    diskId: 'disk-a',
    mountPoint: '/srv/private/a',
    sourceIdentity: 'source-a',
    label: 'Shared A',
    totalBytes: 100,
    usedBytes: 10,
    pquotaEnabled: true,
  },
  {
    diskId: 'disk-b',
    mountPoint: '/srv/private/b',
    sourceIdentity: 'source-b',
    label: null,
    totalBytes: 200,
    usedBytes: 20,
    pquotaEnabled: false,
  },
];

describe('ServersController ordinary-user hardware projection', () => {
  it.each([
    [GpuGrantMode.None, [], []],
    [GpuGrantMode.Indices, [1], [1]],
    [GpuGrantMode.All, [], [0, 1]],
  ] as const)(
    'filters the GPU catalog for %s resolved access and omits physical UUIDs',
    async (gpuMode, gpuIndices, expectedIndices) => {
      const { controller } = makeController({ gpuMode, gpuIndices });

      const result = await controller.getGpus('server-a', { id: 'user-a' } as never);

      expect(result.map((gpu) => gpu.index)).toEqual(expectedIndices);
      expect(JSON.stringify(result)).not.toContain('GPU-private');
    },
  );

  it.each([
    [[], []],
    [['disk-b'], ['disk-b']],
    [['disk-a', 'disk-b'], ['disk-a', 'disk-b']],
  ])(
    'intersects the local disk catalog with exact current mount grants (%j)',
    async (grantedIds, expectedIds) => {
      const hasMountSourceAccessInTransaction = vi.fn(async (
        _manager: unknown,
        _userId: string,
        _serverId: string,
        source: { id: string },
        expectedSourceIdentity: string,
      ) => grantedIds.includes(source.id)
        && expectedSourceIdentity === `source-${source.id.slice(-1)}`);
      const { controller } = makeController(
        { gpuMode: GpuGrantMode.All, gpuIndices: [] },
        hasMountSourceAccessInTransaction,
      );

      const result = await controller.listDisks('server-a', { id: 'user-a' } as never);

      expect(result.map((disk) => disk.diskId)).toEqual(expectedIds);
      expect(JSON.stringify(result)).not.toMatch(/srv\/private|source-a|source-b/);
      expect(hasMountSourceAccessInTransaction).toHaveBeenCalledTimes(2);
    },
  );
});

function makeController(
  grant: { gpuMode: GpuGrantMode; gpuIndices: readonly number[] },
  hasMountSourceAccessInTransaction = vi.fn().mockResolvedValue(false),
) {
  const resolvedGrant = {
    cpuMillis: 0,
    memBytes: 0,
    diskBytes: 0,
    gpuMode: grant.gpuMode,
    gpuIndices: [...grant.gpuIndices],
  };
  const accessResolver = {
    runWithActiveServerAccess: vi.fn(async (
      _userId: string,
      _serverId: string,
      work: (manager: unknown) => Promise<unknown>,
    ) => work({})),
    resolveServerInTransaction: vi.fn().mockResolvedValue(resolvedGrant),
    hasMountSourceAccessInTransaction,
  };
  const agentGateway = {
    stateCache: {
      get: vi.fn().mockReturnValue({ gpus, disks }),
    },
  };
  return {
    controller: new ServersController(
      {} as never,
      accessResolver as never,
      agentGateway as never,
    ),
    accessResolver,
  };
}
