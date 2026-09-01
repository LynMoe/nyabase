import { describe, expect, it, vi } from 'vitest';
import {
  AuditAction,
  ContainerPhase,
  ContainerPowerIntent,
  IntentKind,
} from '@nyabase/common';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';

function createService() {
  const transactions = {
    run: vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work({})),
  };
  const containerRepository = {
    list: vi.fn(),
    find: vi.fn(),
  };
  const containers = {
    actionForAdmin: vi.fn(),
    actionForSystem: vi.fn(),
  };
  const volumes = {
    list: vi.fn(),
    listAttachments: vi.fn(),
    updateDesired: vi.fn(),
    listPlacements: vi.fn().mockResolvedValue([]),
    deleteVolumeRow: vi.fn(),
  };
  const intents = {
    ensurePending: vi.fn(),
    settleOne: vi.fn(),
  };
  const reconcileClaims = {
    claim: vi.fn().mockResolvedValue({
      resourceType: 'container',
      resourceId: 'container-1',
      placementServerId: 'server-1',
      serverId: 'server-1',
      workerId: 'system-actor',
    }),
    release: vi.fn().mockResolvedValue(true),
  };
  const access = {
    authorizationCommitted: vi.fn(),
  };
  const audit = {
    append: vi.fn(),
  };
  const service = new UserServerResourcePurgeService(
    transactions as never,
    containerRepository as never,
    containers as never,
    volumes as never,
    intents as never,
    reconcileClaims as never,
    access as never,
    audit as never,
  );
  return {
    service,
    transactions,
    containerRepository,
    containers,
    volumes,
    intents,
    reconcileClaims,
    access,
    audit,
  };
}

describe('UserServerResourcePurgeService grant expiry actions', () => {
  it('stops containers attached to a retained shared volume during grace', async () => {
    const fixture = createService();
    fixture.volumes.list.mockResolvedValue([{
      id: 'volume-1',
      owner_id: 'user-1',
      pool_id: 'pool-1',
      server_id: 'server-1',
      shared_backend_id: 'backend-1',
    }]);
    fixture.volumes.listAttachments.mockResolvedValue([
      { container_id: 'container-1' },
    ]);
    fixture.containerRepository.find.mockResolvedValue({
      id: 'container-1',
      server_id: 'server-1',
      lifecycle_phase: ContainerPhase.Active,
      power_intent: ContainerPowerIntent.Running,
    });
    fixture.containers.actionForSystem.mockResolvedValue({ intentId: 'stop-intent' });

    const result = await fixture.service.stopRunningContainersForSharedBackend(
      'user-1',
      'backend-1',
      'system-actor',
    );

    expect(result).toEqual({ intentIds: ['stop-intent'] });
    expect(fixture.containers.actionForSystem).toHaveBeenCalledWith(
      'container-1',
      'stop',
      'system-actor',
    );
    expect(fixture.audit.append).toHaveBeenCalledWith(
      {},
      'system-actor',
      AuditAction.ExpiryStopContainers,
      'user-1',
      'user',
      {
        resourceKind: 'shared_backend',
        resourceId: 'backend-1',
        intentIds: ['stop-intent'],
      },
    );
    expect(fixture.access.authorizationCommitted).toHaveBeenCalledWith(['user-1']);
    expect(fixture.intents.ensurePending).not.toHaveBeenCalled();
    expect(fixture.reconcileClaims.claim).toHaveBeenCalledWith({
      resourceType: 'container',
      resourceId: 'container-1',
      placementServerId: 'server-1',
      serverId: 'server-1',
      workerId: 'system-actor',
    });
    expect(fixture.reconcileClaims.release).toHaveBeenCalledWith({
      resourceType: 'container',
      resourceId: 'container-1',
      placementServerId: 'server-1',
      workerId: 'system-actor',
    });
  });

  it('retries a leased grace stop and does not enqueue a duplicate intent', async () => {
    const fixture = createService();
    let powerIntent = ContainerPowerIntent.Running;
    fixture.volumes.list.mockResolvedValue([{
      id: 'volume-1',
      owner_id: 'user-1',
      pool_id: 'pool-1',
      server_id: 'server-1',
      shared_backend_id: 'backend-1',
    }]);
    fixture.volumes.listAttachments.mockResolvedValue([
      { container_id: 'container-1' },
    ]);
    fixture.containerRepository.find.mockImplementation(async () => ({
      id: 'container-1',
      server_id: 'server-1',
      lifecycle_phase: ContainerPhase.Active,
      power_intent: powerIntent,
    }));
    fixture.reconcileClaims.claim
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        resourceType: 'container',
        resourceId: 'container-1',
        placementServerId: 'server-1',
        serverId: 'server-1',
        workerId: 'worker-1',
      });
    fixture.containers.actionForSystem.mockImplementation(async () => {
      powerIntent = ContainerPowerIntent.Stopped;
      return { intentId: 'stop-intent' };
    });

    await expect(fixture.service.stopRunningContainersForSharedBackend(
      'user-1',
      'backend-1',
      'system-actor',
      'worker-1',
    )).resolves.toEqual({ intentIds: [] });
    await expect(fixture.service.stopRunningContainersForSharedBackend(
      'user-1',
      'backend-1',
      'system-actor',
      'worker-1',
    )).resolves.toEqual({ intentIds: ['stop-intent'] });
    await expect(fixture.service.stopRunningContainersForSharedBackend(
      'user-1',
      'backend-1',
      'system-actor',
      'worker-1',
    )).resolves.toEqual({ intentIds: [] });

    expect(fixture.reconcileClaims.claim).toHaveBeenCalledTimes(2);
    expect(fixture.reconcileClaims.release).toHaveBeenCalledTimes(1);
    expect(fixture.containers.actionForSystem).toHaveBeenCalledTimes(1);
  });

  it('purges lost local volumes through desired-state intents without tasks', async () => {
    const fixture = createService();
    const volume = {
      id: 'volume-1',
      owner_id: 'user-1',
      pool_id: 'pool-1',
      server_id: 'server-1',
      shared_backend_id: null,
      generation: 1,
      lifecycle_phase: 'active',
    };
    const updatedVolume = { ...volume, generation: 2, lifecycle_phase: 'deleting' };
    const transaction = {
      selectFrom: vi.fn((table: string) => ({
        selectAll: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        forUpdate: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([]),
        executeTakeFirst: vi.fn().mockResolvedValue(
          String(table).startsWith('control.volumes') ? volume : undefined,
        ),
      })),
    };
    fixture.transactions.run.mockImplementation(async (
      work: (transaction: unknown) => Promise<unknown>,
    ) => work(transaction));
    fixture.volumes.list.mockResolvedValue([volume]);
    fixture.volumes.listAttachments.mockResolvedValue([
      { container_id: 'container-1' },
    ]);
    fixture.volumes.updateDesired.mockResolvedValue(updatedVolume);
    fixture.volumes.listPlacements.mockResolvedValue([
      { volume_id: 'volume-1', server_id: 'server-1' },
    ]);
    fixture.intents.ensurePending.mockResolvedValue({ id: 'volume-delete-intent' });
    fixture.containerRepository.find.mockResolvedValue({
      id: 'container-1',
      lifecycle_phase: ContainerPhase.Active,
      power_intent: ContainerPowerIntent.Stopped,
    });
    fixture.containers.actionForSystem.mockResolvedValue({ intentId: 'container-delete-intent' });

    const result = await fixture.service.purgeStoragePoolVolumes(
      'user-1',
      'pool-1',
      'system-actor',
    );

    expect(result).toEqual({
      intentIds: ['volume-delete-intent', 'container-delete-intent'],
      volumeIds: ['volume-1'],
    });
    expect(fixture.intents.ensurePending).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: IntentKind.VolumeDestroy,
        resourceId: 'volume-1',
        targetGeneration: 2,
        request: {
          operation: 'destroy',
          idempotencyKey: 'destroy',
        },
      }),
      transaction,
    );
    expect(fixture.containers.actionForSystem).toHaveBeenCalledWith(
      'container-1',
      'delete',
      'system-actor',
    );
    expect(fixture.audit.append).toHaveBeenCalledWith(
      transaction,
      'system-actor',
      AuditAction.ExpiryPurgeResources,
      'pool-1',
      'storage_pool',
      expect.objectContaining({
        userId: 'user-1',
        volumeIds: ['volume-1'],
      }),
    );
    expect(fixture.access.authorizationCommitted).toHaveBeenCalledWith(['user-1']);
    expect(fixture.containers.actionForSystem.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.intents.ensurePending.mock.invocationCallOrder[0]);
  });

  it('does not deleteVolumeRow while attachments remain on empty tracking', async () => {
    const fixture = createService();
    const volume = {
      id: 'volume-1',
      owner_id: 'user-1',
      pool_id: null,
      server_id: null,
      shared_backend_id: 'backend-1',
      generation: 1,
      lifecycle_phase: 'active',
      dir_ensured: false,
    };
    const transaction = {
      selectFrom: vi.fn((table: string) => ({
        selectAll: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        forUpdate: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([]),
        executeTakeFirst: vi.fn().mockResolvedValue(
          String(table).startsWith('control.volumes') ? volume : undefined,
        ),
      })),
    };
    fixture.transactions.run.mockImplementation(async (
      work: (transaction: unknown) => Promise<unknown>,
    ) => work(transaction));
    fixture.volumes.list.mockResolvedValue([volume]);
    fixture.volumes.listAttachments.mockResolvedValue([
      { container_id: 'container-1' },
    ]);
    fixture.volumes.listPlacements.mockResolvedValue([]);
    fixture.volumes.updateDesired.mockResolvedValue({
      ...volume,
      generation: 2,
      lifecycle_phase: 'deleting',
    });
    fixture.intents.ensurePending.mockResolvedValue({ id: 'destroy-1' });
    fixture.containerRepository.find.mockResolvedValue({
      id: 'container-1',
      lifecycle_phase: ContainerPhase.Active,
      power_intent: ContainerPowerIntent.Stopped,
    });
    fixture.containers.actionForSystem.mockResolvedValue({ intentId: 'container-delete-intent' });

    const result = await fixture.service.purgeSharedBackendVolumes(
      'user-1',
      'backend-1',
      'system-actor',
    );

    expect(result.volumeIds).toEqual(['volume-1']);
    expect(fixture.volumes.deleteVolumeRow).not.toHaveBeenCalled();
    expect(fixture.intents.ensurePending).toHaveBeenCalled();
    expect(fixture.containers.actionForSystem).toHaveBeenCalledWith(
      'container-1',
      'delete',
      'system-actor',
    );
    expect(fixture.containers.actionForSystem.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.intents.ensurePending.mock.invocationCallOrder[0]);
  });

  it('audits operator purges separately from expiry cleanup', async () => {
    const adminFixture = createService();
    adminFixture.containerRepository.list.mockResolvedValue([]);
    adminFixture.volumes.list.mockResolvedValue([]);

    await adminFixture.service.purge('user-1', 'server-1', 'operator-1', 'admin');

    expect(adminFixture.audit.append).toHaveBeenCalledWith(
      {},
      'operator-1',
      'user.server.purge_resources',
      'user-1',
      'user',
      expect.objectContaining({ reason: 'admin' }),
    );

    const expiryFixture = createService();
    expiryFixture.containerRepository.list.mockResolvedValue([]);
    expiryFixture.volumes.list.mockResolvedValue([]);

    await expiryFixture.service.purge('user-1', 'server-1', 'operator-1', 'expiry');

    expect(expiryFixture.audit.append).toHaveBeenCalledWith(
      {},
      'operator-1',
      AuditAction.ExpiryPurgeResources,
      'user-1',
      'user',
      expect.objectContaining({ reason: 'expiry' }),
    );
  });

  it('grant-expiry empty placements follow dir_ensured and eligible executors', async () => {
    async function purge(volume: Record<string, unknown>, eligible: boolean) {
      const fixture = createService();
      const transaction = {
        selectFrom: vi.fn((table: string) => ({
          selectAll: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          forUpdate: vi.fn().mockReturnThis(),
          execute: vi.fn().mockResolvedValue(eligible
            ? [{ server_id: 'server-1', server_name: 's', pool_id: 'p', pool_name: 'cephfs' }]
            : []),
          executeTakeFirst: vi.fn().mockResolvedValue(
            String(table).startsWith('control.volumes') ? volume : undefined,
          ),
        })),
      };
      fixture.transactions.run.mockImplementation(async (
        work: (transaction: unknown) => Promise<unknown>,
      ) => work(transaction));
      fixture.volumes.list.mockResolvedValue([volume]);
      fixture.volumes.listAttachments.mockResolvedValue([]);
      fixture.volumes.listPlacements.mockResolvedValue([]);
      fixture.volumes.updateDesired.mockResolvedValue({
        ...volume,
        generation: 2,
        lifecycle_phase: 'deleting',
      });
      fixture.intents.ensurePending.mockResolvedValue({ id: 'destroy-1' });
      const result = await fixture.service.purgeSharedBackendVolumes(
        'user-1',
        'backend-1',
        'system-actor',
      );
      return { fixture, result };
    }

    const neverMounted = await purge({
      id: 'volume-1',
      owner_id: 'user-1',
      pool_id: null,
      server_id: null,
      shared_backend_id: 'backend-1',
      generation: 1,
      lifecycle_phase: 'active',
      dir_ensured: false,
    }, true);
    expect(neverMounted.fixture.volumes.deleteVolumeRow).toHaveBeenCalled();
    expect(neverMounted.fixture.intents.ensurePending).not.toHaveBeenCalled();

    const destroy = await purge({
      id: 'volume-2',
      owner_id: 'user-1',
      pool_id: null,
      server_id: null,
      shared_backend_id: 'backend-1',
      generation: 1,
      lifecycle_phase: 'active',
      dir_ensured: true,
    }, true);
    expect(destroy.fixture.intents.ensurePending).toHaveBeenCalledWith(
      expect.objectContaining({ kind: IntentKind.VolumeDestroy }),
      expect.anything(),
    );

    const leaked = await purge({
      id: 'volume-3',
      owner_id: 'user-1',
      pool_id: null,
      server_id: null,
      shared_backend_id: 'backend-1',
      generation: 1,
      lifecycle_phase: 'active',
      dir_ensured: true,
    }, false);
    expect(leaked.fixture.volumes.deleteVolumeRow).toHaveBeenCalled();
    expect(leaked.fixture.intents.ensurePending).not.toHaveBeenCalled();
    expect(leaked.fixture.audit.append).toHaveBeenCalledWith(
      expect.anything(),
      'system-actor',
      AuditAction.DeleteVolume,
      'volume-3',
      'volume',
      { reason: 'destroy_executor_gone' },
    );
  });
});
