import { describe, expect, it, vi } from 'vitest';
import {
  FailureCode,
  IntentKind,
  IntentResourceType,
  StoragePoolResizeFamily,
} from '@nyabase/common';
import { checkVolumeResize, effectiveUsageForShrinkFloor, VolumesService } from './volumes.service.js';

const base = {
  volumeId: '11111111-1111-4111-8111-111111111111',
  poolId: '22222222-2222-4222-8222-222222222222',
  currentSizeBytes: 100,
  requestedSizeBytes: 80,
  usedBytes: 20,
  resizeFamily: StoragePoolResizeFamily.QuotaOnline,
  blockFilesystem: null,
  attachments: [],
} as const;

describe('custom volume resize policy', () => {
  it('rejects a shrink below observed usage with exact details', () => {
    expect(checkVolumeResize({ ...base, requestedSizeBytes: 10 })).toEqual({
      code: FailureCode.VolumeShrinkBelowUsage,
      message: 'Volume cannot shrink below observed usage',
      details: {
        volumeId: base.volumeId,
        requestedBytes: 10,
        usedBytes: 20,
      },
    });
  });

  it('requires all consumers to detach from block-backed volumes', () => {
    const attachment = {
      attachmentId: '33333333-3333-4333-8333-333333333333',
      containerId: '44444444-4444-4444-8444-444444444444',
      containerPath: '/data',
    };
    expect(checkVolumeResize({
      ...base,
      resizeFamily: StoragePoolResizeFamily.BlockBacked,
      attachments: [attachment],
    })).toMatchObject({
      code: FailureCode.VolumeShrinkRequiresDetach,
      details: { volumeId: base.volumeId, attachments: [attachment] },
    });
  });

  it('never shrinks XFS, but permits online growth', () => {
    expect(checkVolumeResize({
      ...base,
      blockFilesystem: 'xfs',
    })).toMatchObject({
      code: FailureCode.VolumeShrinkUnsupported,
      details: {
        poolId: base.poolId,
        reason: 'xfs_cannot_shrink',
      },
    });
    expect(checkVolumeResize({
      ...base,
      requestedSizeBytes: 120,
      blockFilesystem: 'xfs',
    })).toBeNull();
  });

  it('uses observed quota-online usedBytes as the shrink floor, including used===size', () => {
    expect(effectiveUsageForShrinkFloor({
      usedBytes: 100,
      currentSizeBytes: 100,
      resizeFamily: StoragePoolResizeFamily.QuotaOnline,
    })).toBe(100);
    expect(checkVolumeResize({
      ...base,
      usedBytes: 100,
      currentSizeBytes: 100,
      requestedSizeBytes: 50,
      resizeFamily: StoragePoolResizeFamily.QuotaOnline,
    })).toEqual({
      code: FailureCode.VolumeShrinkBelowUsage,
      message: 'Volume cannot shrink below observed usage',
      details: {
        volumeId: base.volumeId,
        requestedBytes: 50,
        usedBytes: 100,
      },
    });
  });
});

const volumeId = '11111111-1111-4111-8111-111111111111';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const homeServer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const peerServer = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const poolId = '22222222-2222-4222-8222-222222222222';

function volumeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: volumeId,
    owner_id: actorId,
    pool_id: poolId,
    server_id: homeServer,
    shared_backend_id: null,
    name: 'data',
    generation: 1,
    lifecycle_phase: 'active',
    ...overrides,
  };
}

function makeVolumesService(overrides: {
  repository?: Record<string, unknown>;
  intents?: Record<string, unknown>;
  transaction?: Record<string, unknown>;
  pools?: Record<string, unknown>;
}) {
  const transaction = overrides.transaction ?? {};
  const intents = {
    createPending: vi.fn().mockResolvedValue({
      id: 'intent-1',
      kind: IntentKind.VolumeEnsure,
      resourceType: IntentResourceType.Volume,
      resourceId: volumeId,
      serverId: homeServer,
      targetGeneration: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    settleOne: vi.fn().mockResolvedValue(true),
    ensurePending: vi.fn().mockResolvedValue({
      id: 'ensure-1',
      status: 'pending',
    }),
    ...overrides.intents,
  };
  const repository = {
    findById: vi.fn().mockResolvedValue(volumeRow()),
    hasAttachments: vi.fn().mockResolvedValue(false),
    listPlacements: vi.fn().mockResolvedValue([]),
    deleteVolumeRow: vi.fn(),
    findDetachDrain: vi.fn().mockResolvedValue(undefined),
    clearExpiredDetachDrain: vi.fn(),
    insertAttachment: vi.fn().mockResolvedValue({ id: 'att-1' }),
    upsertPlacement: vi.fn(),
    setDetachDrain: vi.fn(),
    deleteAttachment: vi.fn(),
    liveAttachmentServerIds: vi.fn().mockResolvedValue([]),
    setDesiredPresent: vi.fn(),
    findAttachment: vi.fn(),
    ...overrides.repository,
  };
  const service = new VolumesService(
    repository as never,
    { lockCapacityScope: vi.fn(), ...overrides.pools } as never,
    { run: vi.fn(async (work: (value: unknown) => Promise<unknown>) => work(transaction)) } as never,
    intents as never,
    { wake: vi.fn() } as never,
    {} as never,
    { append: vi.fn() } as never,
  );
  return { service, repository, intents, transaction };
}

describe('volume API placement paths', () => {
  it('rejects user create with ownerId', async () => {
    const { service } = makeVolumesService({});
    await expect(service.createForUser(actorId, {
      ownerId: actorId,
      name: 'data',
      sizeBytes: 100,
      scope: { kind: 'local', serverId: homeServer, poolId },
    })).rejects.toMatchObject({
      response: { code: FailureCode.InvalidInput },
    });
  });

  it('deletes the volume row immediately when there are zero placements', async () => {
    const transaction = {
      selectFrom: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ server_id: homeServer }),
      })),
    };
    const { service, repository, intents } = makeVolumesService({ transaction });
    const accepted = await service.deleteForUser(actorId, volumeId);
    expect(repository.deleteVolumeRow).toHaveBeenCalledWith(volumeId, transaction);
    expect(intents.createPending).toHaveBeenCalledWith(expect.objectContaining({
      kind: IntentKind.VolumeEnsure,
      resourceId: volumeId,
      serverId: homeServer,
      request: { operation: 'delete', idempotencyKey: 'delete' },
    }), transaction);
    expect(intents.settleOne).toHaveBeenCalledWith('intent-1', { outcome: 'succeeded' }, transaction);
    expect(accepted).toMatchObject({ intentId: 'intent-1', resourceId: volumeId, status: 'pending' });
  });

  it('does not reuse a succeeded ensure when attaching a shared volume', async () => {
    const containerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const backendId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const query = {
      selectAll: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      forUpdate: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn(),
      execute: vi.fn(),
    };
    query.executeTakeFirst
      .mockResolvedValueOnce({
        id: containerId,
        owner_id: actorId,
        server_id: peerServer,
        generation: 1,
      })
      .mockResolvedValueOnce({
        id: volumeId,
        owner_id: actorId,
        server_id: null,
        shared_backend_id: backendId,
        lifecycle_phase: 'active',
        generation: 4,
        pool_id: poolId,
      });
    query.execute.mockResolvedValue([{ id: poolId }]);
    const transaction = {
      selectFrom: vi.fn(() => query),
      updateTable: vi.fn(() => ({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ id: containerId }),
      })),
    };
    const { service, intents } = makeVolumesService({
      transaction,
      intents: {
        ensurePending: vi.fn().mockResolvedValue({ id: 'ensure-1', status: 'pending' }),
        createPending: vi.fn().mockResolvedValue({
          id: 'update-1',
          kind: IntentKind.ContainerUpdate,
          resourceType: IntentResourceType.Container,
          resourceId: containerId,
          serverId: peerServer,
          targetGeneration: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    await service.attachForUser(actorId, containerId, {
      volumeId,
      containerPath: '/data',
      readOnly: false,
    });
    expect(intents.ensurePending).toHaveBeenCalledWith(expect.objectContaining({
      reuseSettled: false,
      request: expect.objectContaining({ idempotencyKey: 'ensure_attachment' }),
    }), transaction);
  });

  it('keeps a non-home placement row with desired_present=false after last detach', async () => {
    const containerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const attachmentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const query = {
      selectAll: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      forUpdate: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn(),
      executeTakeFirstOrThrow: vi.fn().mockResolvedValue({
        id: volumeId,
        pool_id: poolId,
        server_id: null,
        shared_backend_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        lifecycle_phase: 'active',
      }),
    };
    query.executeTakeFirst
      .mockResolvedValueOnce({
        id: containerId,
        owner_id: actorId,
        server_id: peerServer,
        generation: 1,
      })
      .mockResolvedValueOnce({
        id: attachmentId,
        volume_id: volumeId,
        container_id: containerId,
      });
    const transaction = {
      selectFrom: vi.fn((table: string) => {
        if (table === 'infra.storage_pools') {
          return {
            select: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ server_id: homeServer }),
          };
        }
        return query;
      }),
      updateTable: vi.fn(() => ({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue({ id: containerId }),
      })),
    };
    const { service, repository, intents } = makeVolumesService({
      transaction,
      repository: {
        findAttachment: vi.fn().mockResolvedValue({
          id: attachmentId,
          container_id: containerId,
          volume_id: volumeId,
        }),
        liveAttachmentServerIds: vi.fn().mockResolvedValue([]),
      },
      intents: {
        createPending: vi.fn().mockResolvedValue({
          id: 'detach-1',
          kind: IntentKind.ContainerUpdate,
          resourceType: IntentResourceType.Container,
          resourceId: containerId,
          serverId: peerServer,
          targetGeneration: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    await service.detachForUser(actorId, attachmentId, containerId);
    expect(repository.setDesiredPresent).toHaveBeenCalledWith(
      volumeId,
      peerServer,
      false,
      transaction,
    );
    expect(repository.deleteAttachment).toHaveBeenCalled();
    expect(intents.createPending).toHaveBeenCalledWith(expect.objectContaining({
      request: { operation: 'detach_volume', attachmentId },
    }), transaction);
  });
});
