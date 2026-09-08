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

  it('rejects quota-online shrink when usage has not been observed', () => {
    expect(checkVolumeResize({
      ...base,
      usedBytes: null,
      requestedSizeBytes: 80,
    })).toEqual({
      code: FailureCode.VolumeUsageUnknown,
      message: 'Volume usage is unknown; shrink is not allowed until usage is observed',
      details: {
        volumeId: base.volumeId,
        requestedBytes: 80,
        usedBytes: null,
      },
    });
    expect(checkVolumeResize({
      ...base,
      usedBytes: null,
      requestedSizeBytes: 120,
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
    dir_ensured: false,
    ...overrides,
  };
}

function makeVolumesService(overrides: {
  repository?: Record<string, unknown>;
  intents?: Record<string, unknown>;
  transaction?: Record<string, unknown>;
  pools?: Record<string, unknown>;
}) {
  const transaction = overrides.transaction ?? {
    selectFrom: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
    })),
  };
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
    updateDesired: vi.fn().mockResolvedValue(volumeRow({ lifecycle_phase: 'deleting', generation: 2 })),
    deleteVolumeRow: vi.fn(),
    insertAttachment: vi.fn().mockResolvedValue({ id: 'att-1' }),
    upsertPlacement: vi.fn(),
    setAttachmentBindState: vi.fn(),
    deleteAttachment: vi.fn(),
    findAttachment: vi.fn(),
    ...overrides.repository,
  };
  const pools = {
    lockCapacityScope: vi.fn(),
    lockSharedBackends: vi.fn(),
    findById: vi.fn(),
    ...overrides.pools,
  };
  const service = new VolumesService(
    repository as never,
    pools as never,
    { run: vi.fn(async (work: (value: unknown) => Promise<unknown>) => work(transaction)) } as never,
    intents as never,
    { wake: vi.fn() } as never,
    {} as never,
    { append: vi.fn() } as never,
  );
  return { service, repository, intents, transaction, pools };
}

describe('volume API placement paths', () => {
  it('rejects shared create on the local volume API', async () => {
    const { service } = makeVolumesService({});
    await expect(service.createForUser(actorId, {
      name: 'data',
      sizeBytes: 100,
      scope: { kind: 'shared', sharedBackendId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } as never,
    })).rejects.toMatchObject({
      response: { code: FailureCode.InvalidInput },
    });
  });

  it('deletes the volume row immediately when there are zero placements', async () => {
    const transaction = {
      selectFrom: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([]),
        executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ server_id: homeServer }),
      })),
    };
    const { service, repository, intents } = makeVolumesService({ transaction });
    const accepted = await service.deleteForUser(actorId, volumeId);
    expect(repository.deleteVolumeRow).toHaveBeenCalledWith(volumeId, transaction);
    expect(intents.createPending).toHaveBeenCalledWith(expect.objectContaining({
      kind: IntentKind.VolumeDestroy,
      resourceId: volumeId,
      request: expect.objectContaining({ operation: 'destroy', idempotencyKey: 'destroy' }),
    }), transaction);
    expect(intents.settleOne).toHaveBeenCalledWith('intent-1', { outcome: 'succeeded' }, transaction);
    expect(accepted).toMatchObject({ intentId: 'intent-1', resourceId: volumeId, status: 'pending' });
  });

  it('attaches a shared volume without volume.ensure or blocked_by', async () => {
    const containerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const backendId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const query = {
      selectAll: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
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
        pool_id: null,
      });
    query.execute
      .mockResolvedValueOnce([{
        limit_bytes: 0,
        expires_at: null,
        user_id: actorId,
        group_id: null,
        group_priority: null,
        id: 'grant-1',
      }])
      .mockResolvedValueOnce([{ id: poolId }]);
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
        ensurePending: vi.fn(),
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
    }, 'shared');
    expect(intents.ensurePending).not.toHaveBeenCalled();
    expect(intents.createPending).toHaveBeenCalledWith(expect.objectContaining({
      kind: IntentKind.ContainerUpdate,
      blockedByIntentId: null,
      request: expect.objectContaining({ operation: 'attach_volume' }),
    }), transaction);
  });

  it('marks attachments detaching and always enqueues a container update', async () => {
    const containerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const attachmentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const query = {
      selectAll: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
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
        id: attachmentId,
        volume_id: volumeId,
        container_id: containerId,
        bind_state: 'attaching',
        shared_backend_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      })
      .mockResolvedValueOnce({
        id: containerId,
        owner_id: actorId,
        server_id: peerServer,
        generation: 1,
        power_intent: 'running',
      })
      .mockResolvedValueOnce({ instance_status: 'Running' });
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
        findPlacement: vi.fn().mockResolvedValue({ catalog_state: 'ensuring' }),
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
    await service.detachForUser(actorId, attachmentId, containerId, 'shared');
    expect(repository.setAttachmentBindState).toHaveBeenCalledWith(
      attachmentId,
      'detaching',
      transaction,
    );
    expect(repository.deleteAttachment).not.toHaveBeenCalled();
    expect(intents.createPending).toHaveBeenCalledWith(expect.objectContaining({
      request: { operation: 'detach_volume', attachmentId },
    }), transaction);
  });

  it('rejects delete while any attachment remains', async () => {
    const { service, repository, intents } = makeVolumesService({
      repository: { hasAttachments: vi.fn().mockResolvedValue(true) },
    });
    await expect(service.deleteForUser(actorId, volumeId)).rejects.toMatchObject({
      response: { code: FailureCode.VolumeRequiresUnbind },
    });
    expect(repository.deleteVolumeRow).not.toHaveBeenCalled();
    expect(intents.createPending).not.toHaveBeenCalled();
  });

  it('rejects local delete when the volume server is unreachable', async () => {
    const transaction = {
      selectFrom: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue({
          id: homeServer,
          name: 'home',
          status: 'unreachable',
        }),
        execute: vi.fn().mockResolvedValue([]),
      })),
    };
    const { service, repository, intents } = makeVolumesService({
      transaction,
      repository: {
        listPlacements: vi.fn().mockResolvedValue([{ server_id: homeServer }]),
      },
    });
    await expect(service.deleteForUser(actorId, volumeId)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: FailureCode.ServerUnreachable,
        details: { serverId: homeServer, serverName: 'home' },
      }),
    });
    expect(repository.deleteVolumeRow).not.toHaveBeenCalled();
    expect(intents.createPending).not.toHaveBeenCalled();
  });

  it('does not treat an unadopted same-backend server as a catalog gate', async () => {
    const transaction = {
      selectFrom: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([
          {
            server_id: peerServer,
            server_name: 'peer',
            pool_id: poolId,
            pool_name: 'cephfs',
          },
        ]),
        executeTakeFirst: vi.fn(),
      })),
    };
    const { service, repository, intents } = makeVolumesService({
      transaction,
      repository: {
        findById: vi.fn().mockResolvedValue(volumeRow({
          server_id: null,
          shared_backend_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        })),
        listPlacements: vi.fn().mockResolvedValue([{ server_id: homeServer }]),
      },
    });
    await expect(service.deleteSharedForUser(actorId, volumeId)).resolves.toMatchObject({
      intentId: 'intent-1',
      status: 'pending',
    });
    expect(repository.deleteVolumeRow).not.toHaveBeenCalled();
    expect(intents.createPending).toHaveBeenCalledWith(expect.objectContaining({
      kind: IntentKind.VolumeDestroy,
      request: expect.objectContaining({ idempotencyKey: 'destroy' }),
    }), transaction);
  });

  it('locks shared-backend quota and settles leftover intents on empty tracking', async () => {
    const backendId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const leftover = { id: 'ensure-leftover' };
    const transaction = {
      selectFrom: vi.fn((table: string) => ({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue(table === 'control.intents' ? [leftover] : []),
      })),
    };
    const { service, repository, intents, pools } = makeVolumesService({
      transaction,
      repository: {
        findById: vi.fn().mockResolvedValue(volumeRow({
          server_id: null,
          shared_backend_id: backendId,
          pool_id: null,
          dir_ensured: false,
        })),
      },
    });
    await service.deleteSharedForUser(actorId, volumeId);
    expect(pools.lockSharedBackends).toHaveBeenCalledWith([backendId], transaction);
    expect(pools.lockCapacityScope).not.toHaveBeenCalled();
    expect(intents.settleOne).toHaveBeenCalledWith(leftover.id, { outcome: 'succeeded' }, transaction);
    expect(repository.deleteVolumeRow).toHaveBeenCalledWith(volumeId, transaction);
  });

  it('rejects attached detach unless observed stopped and power_intent is stopped', async () => {
    const containerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const attachmentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const query = {
      selectAll: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      forUpdate: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn(),
    };
    query.executeTakeFirst
      .mockResolvedValueOnce({
        id: attachmentId,
        volume_id: volumeId,
        container_id: containerId,
        bind_state: 'attached',
        shared_backend_id: null,
      })
      .mockResolvedValueOnce({
        id: containerId,
        owner_id: actorId,
        server_id: homeServer,
        generation: 4,
        power_intent: 'running',
      })
      .mockResolvedValueOnce({ instance_status: 'Running' });
    const transaction = {
      selectFrom: vi.fn(() => query),
      updateTable: vi.fn(),
    };
    const { service, repository, intents } = makeVolumesService({
      transaction,
      repository: {
        findPlacement: vi.fn().mockResolvedValue({ catalog_state: 'present' }),
        setAttachmentBindState: vi.fn(),
      },
    });
    await expect(service.detachForUser(actorId, attachmentId, containerId, 'local'))
      .rejects.toMatchObject({
        response: { code: FailureCode.VolumeDetachRequiresStop },
      });
    expect(repository.setAttachmentBindState).not.toHaveBeenCalled();
    expect(intents.createPending).not.toHaveBeenCalled();
    expect(transaction.updateTable).not.toHaveBeenCalled();
  });

  it('rejects shared delete when dir_ensured and no eligible executor exists', async () => {
    const backendId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const transaction = {
      selectFrom: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([]),
      })),
    };
    const { service, repository, intents } = makeVolumesService({
      transaction,
      repository: {
        findById: vi.fn().mockResolvedValue(volumeRow({
          server_id: null,
          shared_backend_id: backendId,
          pool_id: null,
          dir_ensured: true,
        })),
        listPlacements: vi.fn().mockResolvedValue([{ server_id: homeServer }]),
      },
    });
    await expect(service.deleteSharedForUser(actorId, volumeId)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: FailureCode.VolumeDeleteBackendUnreachable,
        details: { sharedBackendId: backendId },
      }),
    });
    expect(repository.deleteVolumeRow).not.toHaveBeenCalled();
    expect(intents.createPending).not.toHaveBeenCalled();
  });
});
