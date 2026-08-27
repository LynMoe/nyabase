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
    setAllDesiredPresent: vi.fn(),
    deleteVolumeRow: vi.fn(),
  };
  const intents = {
    ensurePending: vi.fn(),
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
      selectFrom: vi.fn(() => ({
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        forUpdate: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue(volume),
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
        kind: IntentKind.VolumeEnsure,
        resourceId: 'volume-1',
        targetGeneration: 2,
        serverId: 'server-1',
        request: {
          operation: 'delete',
          idempotencyKey: 'delete',
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
});
