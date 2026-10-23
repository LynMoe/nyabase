import { describe, expect, it, vi } from 'vitest';
import {
  AuditAction,
  ContainerPhase,
  ContainerPowerIntent,
  IntentKind,
  Role,
} from '@nyabase/common';
import { SYSTEM_ACTOR } from '../iam/actor.js';
import { testActor } from '../iam/actor.test-helper.js';
import { assertActorRole } from '../iam/administration.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';

vi.mock('../iam/administration.js', () => ({ assertActorRole: vi.fn() }));

const SYSTEM = SYSTEM_ACTOR;

function createService() {
  const transactions = {
    run: vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work({})),
  };
  const containerRepository = {
    list: vi.fn(),
    find: vi.fn(),
  };
  const containers = {
    action: vi.fn(),
    actionInTransaction: vi.fn(),
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
  const attachments = {
    forceDetach: vi.fn(),
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
    attachments as never,
    audit as never,
  );
  return {
    service,
    transactions,
    containerRepository,
    containers,
    volumes,
    intents,
    attachments,
    audit,
  };
}

describe('UserServerResourcePurgeService grant expiry actions', () => {
  it('detaches a lapsed shared volume during grace and leaves its container alone', async () => {
    const fixture = createService();
    fixture.volumes.list.mockResolvedValue([{
      id: 'volume-1',
      owner_id: 'user-1',
      pool_id: null,
      server_id: null,
      shared_backend_id: 'backend-1',
    }, {
      id: 'volume-2',
      owner_id: 'user-1',
      pool_id: null,
      server_id: null,
      shared_backend_id: 'backend-2',
    }]);
    fixture.volumes.listAttachments.mockImplementation(async (_container: unknown, volumeId: string) =>
      volumeId === 'volume-1'
        ? [
          { id: 'attachment-1', container_id: 'container-1', bind_state: 'attached' },
          { id: 'attachment-2', container_id: 'container-2', bind_state: 'detaching' },
        ]
        : [{ id: 'attachment-3', container_id: 'container-3', bind_state: 'attached' }]);
    // A detaching attachment is offered again; forceDetach leaves it alone while its intent runs.
    fixture.attachments.forceDetach.mockImplementation(async (_actor: unknown, id: string) =>
      id === 'attachment-1' ? { id: 'detach-intent' } : null);

    const result = await fixture.service.detachVolumesForSharedBackend(SYSTEM, 'user-1', 'backend-1');

    expect(result).toEqual({ intentIds: ['detach-intent'] });
    expect(fixture.attachments.forceDetach.mock.calls).toEqual([
      [SYSTEM, 'attachment-1'],
      [SYSTEM, 'attachment-2'],
    ]);
    expect(fixture.containers.action).not.toHaveBeenCalled();
    expect(fixture.audit.append).toHaveBeenCalledWith(
      {},
      null,
      AuditAction.ExpiryDetachVolumes,
      'user-1',
      'user',
      {
        resourceKind: 'shared_backend',
        resourceId: 'backend-1',
        intentIds: ['detach-intent'],
      },
    );
  });

  it('does not audit a grace pass that found nothing left to detach', async () => {
    const fixture = createService();
    fixture.volumes.list.mockResolvedValue([{
      id: 'volume-1',
      owner_id: 'user-1',
      pool_id: 'pool-1',
      server_id: 'server-1',
      shared_backend_id: null,
    }]);
    fixture.volumes.listAttachments.mockResolvedValue([
      { id: 'attachment-1', container_id: 'container-1', bind_state: 'attached' },
    ]);
    // The container is already being deleted, or another pass got there first.
    fixture.attachments.forceDetach.mockResolvedValue(null);

    await expect(fixture.service.detachVolumesForStoragePool(SYSTEM, 'user-1', 'pool-1'))
      .resolves.toEqual({ intentIds: [] });
    expect(fixture.audit.append).not.toHaveBeenCalled();
  });

  it('stops a running container that is still provisioning when server access lapses', async () => {
    const fixture = createService();
    fixture.containerRepository.list.mockResolvedValue([
      { id: 'c-active', lifecycle_phase: ContainerPhase.Active, power_intent: ContainerPowerIntent.Running },
      { id: 'c-provisioning', lifecycle_phase: ContainerPhase.Provisioning, power_intent: ContainerPowerIntent.Running },
      { id: 'c-deleting', lifecycle_phase: ContainerPhase.Deleting, power_intent: ContainerPowerIntent.Running },
      { id: 'c-stopped', lifecycle_phase: ContainerPhase.Active, power_intent: ContainerPowerIntent.Stopped },
    ]);
    fixture.containers.action.mockImplementation(async (_actor: unknown, id: string) => ({ intentId: `stop-${id}` }));

    const result = await fixture.service.stopRunningContainersForGraceEntry(SYSTEM, 'user-1', 'server-1');

    expect(result.intentIds).toEqual(['stop-c-active', 'stop-c-provisioning']);
  });

  it('purges lost local volumes through desired-state intents without tasks', async () => {
    const fixture = createService();
    const volume = {
      id: 'volume-1',
      owner_id: 'user-1',
      pool_id: 'pool-1',
      server_id: 'server-1',
      shared_backend_id: null,
      revision: 1,
      lifecycle_phase: 'active',
    };
    const updatedVolume = { ...volume, revision: 2, lifecycle_phase: 'deleting' };
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
    fixture.volumes.list.mockResolvedValue([volume]);
    fixture.volumes.listAttachments.mockResolvedValue([
      { id: 'attachment-1', container_id: 'container-1', bind_state: 'attached' },
    ]);
    fixture.volumes.updateDesired.mockResolvedValue(updatedVolume);
    fixture.volumes.listPlacements.mockResolvedValue([
      { volume_id: 'volume-1', server_id: 'server-1' },
    ]);
    fixture.intents.ensurePending.mockResolvedValue({ id: 'volume-delete-intent' });

    const result = await fixture.service.purgeStoragePoolVolumes(
      transaction as never,
      SYSTEM,
      'user-1',
      'pool-1',
    );

    expect(result).toEqual({
      intentIds: ['volume-delete-intent'],
      volumeIds: ['volume-1'],
    });
    // Only the volume goes: the container it was attached to is kept, and the
    // destroy is queued in the caller's transaction (no transaction of its own).
    expect(fixture.containers.actionInTransaction).not.toHaveBeenCalled();
    expect(fixture.transactions.run).not.toHaveBeenCalled();
    expect(fixture.attachments.forceDetach).not.toHaveBeenCalled();
    expect(fixture.intents.ensurePending).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: IntentKind.VolumeDestroy,
        resourceId: 'volume-1',
        targetRevision: 2,
        request: {
          operation: 'destroy',
          idempotencyKey: 'destroy',
        },
      }),
      transaction,
    );
    expect(fixture.audit.append).toHaveBeenCalledWith(
      transaction,
      null,
      AuditAction.ExpiryPurgeResources,
      'pool-1',
      'storage_pool',
      expect.objectContaining({
        userId: 'user-1',
        volumeIds: ['volume-1'],
        intentIds: ['volume-delete-intent'],
      }),
    );
  });

  it('does not deleteVolumeRow while attachments remain on empty tracking', async () => {
    const fixture = createService();
    const volume = {
      id: 'volume-1',
      owner_id: 'user-1',
      pool_id: null,
      server_id: null,
      shared_backend_id: 'backend-1',
      revision: 1,
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
    fixture.volumes.list.mockResolvedValue([volume]);
    fixture.volumes.listAttachments.mockResolvedValue([
      { id: 'attachment-1', container_id: 'container-1', bind_state: 'attached' },
    ]);
    fixture.volumes.listPlacements.mockResolvedValue([]);
    fixture.volumes.updateDesired.mockResolvedValue({
      ...volume,
      revision: 2,
      lifecycle_phase: 'deleting',
    });
    fixture.intents.ensurePending.mockResolvedValue({ id: 'destroy-1' });

    const result = await fixture.service.purgeSharedBackendVolumes(
      transaction as never,
      SYSTEM,
      'user-1',
      'backend-1',
    );

    expect(result.volumeIds).toEqual(['volume-1']);
    expect(fixture.volumes.deleteVolumeRow).not.toHaveBeenCalled();
    expect(fixture.intents.ensurePending).toHaveBeenCalled();
    expect(fixture.containers.actionInTransaction).not.toHaveBeenCalled();
  });

  it('audits administrator purges separately from expiry cleanup', async () => {
    const adminFixture = createService();
    adminFixture.containerRepository.list.mockResolvedValue([]);
    adminFixture.volumes.list.mockResolvedValue([]);

    await adminFixture.service.purge(testActor('admin-1', Role.Admin), 'user-1', 'server-1');

    // The administrator's role is re-read first, in a read-committed transaction.
    expect(assertActorRole).toHaveBeenCalledWith({}, 'admin-1', Role.Admin);
    expect(adminFixture.transactions.run).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'read committed' }),
    );
    vi.mocked(assertActorRole).mockClear();
    expect(adminFixture.audit.append).toHaveBeenCalledWith(
      {},
      'admin-1',
      'user.server.purge_resources',
      'user-1',
      'user',
      expect.objectContaining({ reason: 'admin' }),
    );

    const expiryFixture = createService();
    expiryFixture.containerRepository.list.mockResolvedValue([]);
    expiryFixture.volumes.list.mockResolvedValue([]);

    await expiryFixture.service.purge(SYSTEM, 'user-1', 'server-1');

    expect(assertActorRole).not.toHaveBeenCalled();
    expect(expiryFixture.audit.append).toHaveBeenCalledWith(
      {},
      null,
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
      fixture.volumes.list.mockResolvedValue([volume]);
      fixture.volumes.listAttachments.mockResolvedValue([]);
      fixture.volumes.listPlacements.mockResolvedValue([]);
      fixture.volumes.updateDesired.mockResolvedValue({
        ...volume,
        revision: 2,
        lifecycle_phase: 'deleting',
      });
      fixture.intents.ensurePending.mockResolvedValue({ id: 'destroy-1' });
      const result = await fixture.service.purgeSharedBackendVolumes(
        transaction as never,
        SYSTEM,
        'user-1',
        'backend-1',
      );
      return { fixture, result };
    }

    const neverMounted = await purge({
      id: 'volume-1',
      owner_id: 'user-1',
      pool_id: null,
      server_id: null,
      shared_backend_id: 'backend-1',
      revision: 1,
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
      revision: 1,
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
      revision: 1,
      lifecycle_phase: 'active',
      dir_ensured: true,
    }, false);
    expect(leaked.fixture.volumes.deleteVolumeRow).toHaveBeenCalled();
    expect(leaked.fixture.intents.ensurePending).not.toHaveBeenCalled();
    expect(leaked.fixture.audit.append).toHaveBeenCalledWith(
      expect.anything(),
      null,
      AuditAction.DeleteVolume,
      'volume-3',
      'volume',
      { reason: 'destroy_executor_gone' },
    );
  });
});
