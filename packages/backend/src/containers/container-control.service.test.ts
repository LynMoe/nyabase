import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  AuditAction,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  FailureCode,
  IntentKind,
  IntentResourceType,
  StoragePoolResizeFamily,
  Role,
} from '@nyabase/common';
import { makeContainerControlService } from './container-services.test-helper.js';
import { checkRootResize } from './container-rules.js';
import { SYSTEM_ACTOR } from '../iam/actor.js';
import { testActor } from '../iam/actor.test-helper.js';

// The quota lock is plain SQL; this harness has no database behind its transaction.
vi.mock('../platform/persistence-pg/advisory-locks.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../platform/persistence-pg/advisory-locks.js')>(),
  lockOwnerServerQuota: vi.fn().mockResolvedValue(undefined),
}));

// Role and coverage checks are plain SQL; stub them (the PG tests cover the real ones).
const { assertActorRoleMock, resolveServerAccessMock } = vi.hoisted(() => ({
  assertActorRoleMock: vi.fn(),
  resolveServerAccessMock: vi.fn(),
}));
vi.mock('../iam/administration.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../iam/administration.js')>(),
  assertActorRole: assertActorRoleMock,
}));
vi.mock('../iam/effective-access.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../iam/effective-access.js')>(),
  resolveServerAccess: resolveServerAccessMock,
}));

const containerId = 'container-1';
const serverId = 'server-1';
const actorId = 'user-1';
const owner = testActor(actorId);
const userAdmin = testActor('user-admin-1', Role.UserAdmin);
const stranger = testActor('stranger-1');

function makeHarness() {
  const transaction: {
    transaction: boolean;
    selectFrom?: (table: string) => unknown;
  } = { transaction: true };
  const serverQuery = {
    select: vi.fn(),
    where: vi.fn(),
    forUpdate: vi.fn(),
    executeTakeFirst: vi.fn().mockResolvedValue({}),
  };
  serverQuery.select.mockReturnValue(serverQuery);
  serverQuery.where.mockReturnValue(serverQuery);
  serverQuery.forUpdate.mockReturnValue(serverQuery);
  const row = {
    id: containerId,
    owner_id: actorId,
    server_id: serverId,
    revision: 1,
    lifecycle_phase: ContainerPhase.Active,
    power_intent: ContainerPowerIntent.Stopped,
    root_size_bytes: '1073741824',
    root_size_pending_bytes: null,
    root_pool_id: 'pool-1',
    image_id: 'image-1',
  };
  const repository = {
    lock: vi.fn().mockResolvedValue(row),
    find: vi.fn().mockResolvedValue(row),
    currentRoute: vi.fn().mockResolvedValue({
      instance_status: 'Running',
      instance_started_at: new Date('2026-08-07T03:00:00.000Z'),
    }),
    updateDesired: vi.fn().mockResolvedValue({ ...row, revision: 2 }),
    sumRunningMemBytes: vi.fn().mockResolvedValue(0),
    findDetachingAttachment: vi.fn().mockResolvedValue(undefined),

  };
  const access = {
    assertAttachedStorageCoveredInTransaction: vi.fn().mockResolvedValue(undefined),
  };
  assertActorRoleMock.mockReset();
  resolveServerAccessMock.mockReset().mockResolvedValue({
    cpuCores: 2,
    memBytes: 4_000_000_000,
    diskBytes: 8_000_000_000,
    gpuPciAddresses: [],
  });
  const intent = {
    id: 'intent-1',
    kind: IntentKind.ContainerUpdate,
    resourceType: IntentResourceType.Container,
    resourceId: containerId,
    serverId,
    targetRevision: 2,
    createdAt: '2026-08-07T03:00:00.000Z',
  };
  const intents = {
    createPending: vi.fn().mockResolvedValue(intent),
  };
  const audit = { append: vi.fn() };
  const transactions = {
    run: vi.fn(async (work: (value: unknown) => Promise<unknown>) => work(transaction)),
  };
  Object.assign(transaction, { selectFrom: vi.fn(() => serverQuery) });
  const consoleSessions = {
    create: vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      consoleUrl: '/ws/console?sessionId=session-1',
      expiresAt: '2026-08-07T03:01:00.000Z',
    }),
    release: vi.fn(),
  };
  const sshConvergence = {
    repairContainer: vi.fn().mockResolvedValue({ woken: true }),
    reconcileUser: vi.fn(),
  };
  const service = makeContainerControlService(
    {} as never,
    transactions as never,
    repository as never,
    access as never,
    intents as never,
    consoleSessions as never,
    audit as never,
    { listForServer: vi.fn().mockResolvedValue([]) } as never,
    { get: vi.fn().mockReturnValue(null) } as never,
    sshConvergence as never,
    {} as never,
    {
      isEnabled: vi.fn().mockResolvedValue(false),
      lockEnabled: vi.fn().mockResolvedValue(false),
      forContainer: vi.fn(),
      health: vi.fn(),
      releaseContainerClaims: vi.fn().mockResolvedValue(undefined),
      listForContainer: vi.fn().mockResolvedValue([]),
    } as never,
  );
  return {
    service,
    transaction,
    transactions,
    row,
    repository,
    access,
    intents,
    audit,
    consoleSessions,
  };
}

describe('checkRootResize', () => {
  it('blocks quota-online shrink when usage is missing or zero', () => {
    expect(checkRootResize({
      containerId: 'c',
      requestedBytes: 64,
      currentBytes: 256,
      usedBytes: null,
      resizeFamily: StoragePoolResizeFamily.QuotaOnline,
      observedStatus: ContainerStatus.Running,
    })?.code).toBe(FailureCode.RootUsageUnknown);
    expect(checkRootResize({
      containerId: 'c',
      requestedBytes: 64,
      currentBytes: 256,
      usedBytes: 0,
      resizeFamily: StoragePoolResizeFamily.QuotaOnline,
      observedStatus: ContainerStatus.Running,
    })?.code).toBe(FailureCode.RootUsageUnknown);
  });

  it('blocks shrink below the observed usage floor', () => {
    expect(checkRootResize({
      containerId: 'c',
      requestedBytes: 64,
      currentBytes: 256,
      usedBytes: 100,
      resizeFamily: StoragePoolResizeFamily.QuotaOnline,
      observedStatus: ContainerStatus.Running,
    })?.code).toBe(FailureCode.RootShrinkBelowUsage);
  });
});

describe('ContainerControlService intent boundary', () => {
  it('updates limits online and creates the intent atomically', async () => {
    const harness = makeHarness();
    const result = await harness.service.updateLimits(owner, containerId, {
      memBytes: 2_000_000_000,
    });

    expect(harness.repository.updateDesired).toHaveBeenCalledWith(
      containerId,
      1,
      { mem_bytes: 2_000_000_000 },
      harness.transaction,
    );
    expect(harness.intents.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        targetRevision: 2,
        request: { operation: 'limits' },
      }),
      harness.transaction,
    );
    expect(harness.audit.append).toHaveBeenCalledWith(
      harness.transaction,
      actorId,
      AuditAction.UpdateContainerLimits,
      containerId,
      'container',
      { operation: 'limits' },
    );
    expect(result).toMatchObject({
      intentId: 'intent-1',
      targetRevision: 2,
      status: 'pending',
    });
  });

  it('rejects mutations once the owner has no current server coverage without writing desired state', async () => {
    const harness = makeHarness();
    resolveServerAccessMock.mockResolvedValueOnce(null);

    await expect(harness.service.updateLimits(owner, containerId, {
      memBytes: 2_000_000_000,
    })).rejects.toThrow('Server access was revoked');
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
    expect(harness.intents.createPending).not.toHaveBeenCalled();
  });

  it('lets an owner in the grace period stop and delete, but not start or restart', async () => {
    for (const action of ['stop', 'delete'] as const) {
      const harness = makeHarness();
      resolveServerAccessMock.mockResolvedValueOnce(null);
      await expect(harness.service.action(owner, containerId, action)).resolves.toMatchObject({
        status: 'pending',
      });
      expect(harness.intents.createPending).toHaveBeenCalledOnce();
    }
    for (const action of ['start', 'restart'] as const) {
      const harness = makeHarness();
      resolveServerAccessMock.mockResolvedValueOnce(null);
      await expect(harness.service.action(owner, containerId, action))
        .rejects.toThrow('Server access was revoked');
      expect(harness.intents.createPending).not.toHaveBeenCalled();
    }
  });

  it('stores the observed started_at baseline for restart without calling Incus', async () => {
    const harness = makeHarness();
    const result = await harness.service.action(owner, containerId, 'restart');

    expect(harness.repository.updateDesired).toHaveBeenCalledWith(
      containerId,
      1,
      {
        lifecycle_phase: ContainerPhase.Active,
        power_intent: ContainerPowerIntent.Running,
        failure_code: null,
        failure_reason: null,
      },
      harness.transaction,
    );
    expect(harness.intents.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: IntentKind.ContainerPower,
        baseline: { startedAt: '2026-08-07T03:00:00.000Z' },
        request: { action: 'restart', operation: 'restart' },
      }),
      harness.transaction,
    );
    expect(result).toMatchObject({ intentId: 'intent-1', status: 'pending' });
  });

  it('rejects start and restart while a volume is detaching', async () => {
    const harness = makeHarness();
    harness.repository.findDetachingAttachment.mockResolvedValue({ id: 'att-1' });

    await expect(harness.service.action(owner, containerId, 'start')).rejects.toMatchObject({
      response: { code: 'INSTANCE_BUSY' },
    });
    await expect(harness.service.action(owner, containerId, 'restart')).rejects.toMatchObject({
      response: { code: 'INSTANCE_BUSY' },
    });
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
    expect(harness.intents.createPending).not.toHaveBeenCalled();
  });

  it('lets the system actor stop a container without a role', async () => {
    const harness = makeHarness();
    await harness.service.action(SYSTEM_ACTOR, containerId, 'stop');
    expect(assertActorRoleMock).not.toHaveBeenCalled();
    expect(harness.repository.updateDesired).toHaveBeenCalledWith(
      containerId,
      1,
      {
        lifecycle_phase: ContainerPhase.Active,
        power_intent: ContainerPowerIntent.Stopped,
        failure_code: null,
        failure_reason: null,
      },
      harness.transaction,
    );
  });

  it('still requires the user admin role for an administrator stop', async () => {
    const harness = makeHarness();
    await harness.service.action(userAdmin, containerId, 'stop', 'all');
    expect(assertActorRoleMock).toHaveBeenCalledWith(
      harness.transaction,
      'user-admin-1',
      Role.UserAdmin,
    );
    expect(resolveServerAccessMock).not.toHaveBeenCalled();
    // Read committed: the role re-check reads past the IAM lock wait, not a
    // snapshot from before it. Only the owner's start admission needs serializable.
    expect(harness.transactions.run).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'read committed' }),
    );
    await harness.service.action(owner, containerId, 'stop');
    expect(harness.transactions.run).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'serializable' }),
    );
  });

  it('blocks root changes while a quota application is pending', async () => {
    const harness = makeHarness();
    Object.assign(harness.row, { root_size_pending_bytes: '2147483648' });

    await expect(harness.service.resizeRoot(owner, containerId, {
      sizeBytes: 3_221_225_472,
    })).rejects.toMatchObject({
      response: { code: 'ROOT_QUOTA_PENDING' },
    });
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
    expect(harness.intents.createPending).not.toHaveBeenCalled();
  });

  it('rejects block_backed running root shrink without writing desired state or intents', async () => {
    const harness = makeHarness();
    Object.assign(harness.row, {
      power_intent: ContainerPowerIntent.Running,
      root_size_bytes: '10737418240',
    });
    harness.repository.currentRoute.mockResolvedValue({
      instance_status: 'Running',
      instance_started_at: new Date('2026-08-07T03:00:00.000Z'),
    });
    const selectFrom = vi.fn((table: string) => {
      const query = {
        select: vi.fn(),
        selectAll: vi.fn(),
        where: vi.fn(),
        forUpdate: vi.fn(),
        executeTakeFirst: vi.fn(),
      };
      query.select.mockReturnValue(query);
      query.selectAll.mockReturnValue(query);
      query.where.mockReturnValue(query);
      query.forUpdate.mockReturnValue(query);
      if (table === 'infra.images') {
        query.executeTakeFirst.mockResolvedValue({ min_root_size_bytes: 1 });
      } else if (table === 'infra.storage_pools') {
        query.executeTakeFirst.mockResolvedValue({
          resize_family: 'block_backed',
          quota_effective: true,
        });
      } else {
        query.executeTakeFirst.mockResolvedValue({});
      }
      return query;
    });
    Object.assign(harness.transaction, { selectFrom });

    await expect(harness.service.resizeRoot(owner, containerId, {
      sizeBytes: 5_368_709_120,
    })).rejects.toMatchObject({
      response: { code: 'ROOT_SHRINK_REQUIRES_STOP' },
    });
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
    expect(harness.intents.createPending).not.toHaveBeenCalled();
  });

  it('rejects quota-online root shrink below observed usage without writing desired state', async () => {
    const harness = makeHarness();
    Object.assign(harness.row, {
      root_size_bytes: '2147483648',
      root_used_bytes: '400000000',
    });
    const selectFrom = vi.fn((table: string) => {
      const query = {
        select: vi.fn(),
        selectAll: vi.fn(),
        where: vi.fn(),
        forUpdate: vi.fn(),
        executeTakeFirst: vi.fn(),
      };
      query.select.mockReturnValue(query);
      query.selectAll.mockReturnValue(query);
      query.where.mockReturnValue(query);
      query.forUpdate.mockReturnValue(query);
      if (table === 'infra.images') {
        query.executeTakeFirst.mockResolvedValue({ min_root_size_bytes: 1 });
      } else if (table === 'infra.storage_pools') {
        query.executeTakeFirst.mockResolvedValue({
          resize_family: 'quota_online',
          quota_effective: true,
        });
      } else {
        query.executeTakeFirst.mockResolvedValue({});
      }
      return query;
    });
    Object.assign(harness.transaction, { selectFrom });

    await expect(harness.service.resizeRoot(owner, containerId, {
      sizeBytes: 67_108_864,
    })).rejects.toMatchObject({
      response: { code: FailureCode.RootShrinkBelowUsage },
    });
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
    expect(harness.intents.createPending).not.toHaveBeenCalled();
  });

  it('rejects quota-online root shrink when usage has not been observed', async () => {
    const harness = makeHarness();
    Object.assign(harness.row, { root_size_bytes: '2147483648', root_used_bytes: null });
    const selectFrom = vi.fn((table: string) => {
      const query = {
        select: vi.fn(),
        selectAll: vi.fn(),
        where: vi.fn(),
        forUpdate: vi.fn(),
        executeTakeFirst: vi.fn(),
      };
      query.select.mockReturnValue(query);
      query.selectAll.mockReturnValue(query);
      query.where.mockReturnValue(query);
      query.forUpdate.mockReturnValue(query);
      if (table === 'infra.images') {
        query.executeTakeFirst.mockResolvedValue({ min_root_size_bytes: 1 });
      } else if (table === 'infra.storage_pools') {
        query.executeTakeFirst.mockResolvedValue({
          resize_family: 'quota_online',
          quota_effective: true,
        });
      } else {
        query.executeTakeFirst.mockResolvedValue({});
      }
      return query;
    });
    Object.assign(harness.transaction, { selectFrom });

    await expect(harness.service.resizeRoot(owner, containerId, {
      sizeBytes: 67_108_864,
    })).rejects.toMatchObject({
      response: { code: FailureCode.RootUsageUnknown },
    });
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
  });

  function quotaOnlinePool(harness: ReturnType<typeof makeHarness>) {
    const selectFrom = vi.fn((table: string) => {
      const query = {
        select: vi.fn(),
        selectAll: vi.fn(),
        where: vi.fn(),
        forUpdate: vi.fn(),
        executeTakeFirst: vi.fn(),
      };
      query.select.mockReturnValue(query);
      query.selectAll.mockReturnValue(query);
      query.where.mockReturnValue(query);
      query.forUpdate.mockReturnValue(query);
      query.executeTakeFirst.mockResolvedValue(
        table === 'infra.images'
          ? { min_root_size_bytes: 1 }
          : table === 'infra.storage_pools'
            ? { resize_family: 'quota_online', quota_effective: true }
            : {},
      );
      return query;
    });
    Object.assign(harness.transaction, { selectFrom });
  }

  it('keeps the old root size reserved while an accepted shrink is unapplied', async () => {
    const harness = makeHarness();
    Object.assign(harness.row, { root_size_bytes: '2147483648', root_used_bytes: '100000000' });
    quotaOnlinePool(harness);

    await harness.service.resizeRoot(owner, containerId, { sizeBytes: 1_073_741_824 });

    expect(harness.repository.updateDesired).toHaveBeenCalledWith(
      containerId,
      1,
      {
        root_size_bytes: 1_073_741_824,
        root_size_pending_bytes: null,
        root_shrink_reserved_bytes: 2_147_483_648,
      },
      harness.transaction,
    );
  });

  it('grows back within an unapplied shrink reservation without a capacity check', async () => {
    const harness = makeHarness();
    Object.assign(harness.row, {
      root_size_bytes: '1073741824',
      root_shrink_reserved_bytes: '2147483648',
    });
    quotaOnlinePool(harness);

    // No capacity query is mocked: admitting any growth here would throw.
    await harness.service.resizeRoot(owner, containerId, { sizeBytes: 1_610_612_736 });

    expect(harness.repository.updateDesired).toHaveBeenCalledWith(
      containerId,
      1,
      expect.objectContaining({
        root_size_bytes: 1_610_612_736,
        root_shrink_reserved_bytes: 2_147_483_648,
      }),
      harness.transaction,
    );
  });

  it('authorizes exec through the current server grant and never audits the command', async () => {
    const harness = makeHarness();
    const secret = 'not-for-audit';
    const result = await harness.service.createExecSession(owner, containerId, {
      command: ['/bin/sh', '-c', secret],
      tty: true,
      cols: 80,
      rows: 24,
    });

    expect(result.sessionId).toBe('session-1');
    expect(harness.consoleSessions.create).toHaveBeenCalledOnce();
    const auditPayload = harness.audit.append.mock.calls.at(-1)?.[5] as Record<string, unknown>;
    expect(auditPayload).not.toHaveProperty('command');
    expect(JSON.stringify(auditPayload)).not.toContain(secret);
  });

  it('rejects exec for a different owner before creating a console session', async () => {
    const harness = makeHarness();
    await expect(harness.service.createExecSession(testActor('other-user'), containerId, {
      command: ['/bin/sh'],
      tty: true,
      cols: 80,
      rows: 24,
    })).rejects.toThrow();
    expect(harness.consoleSessions.create).not.toHaveBeenCalled();
  });
});

describe('ContainerControlService actor authorization', () => {
  it('lets the owner act under a live server grant', async () => {
    const harness = makeHarness();
    await harness.service.action(owner, containerId, 'stop');
    expect(resolveServerAccessMock).toHaveBeenCalled();
    expect(assertActorRoleMock).not.toHaveBeenCalled();
  });

  it('hides another user\'s container with a 404, even from a user admin without scope=all', async () => {
    const harness = makeHarness();
    for (const actor of [stranger, userAdmin]) {
      await expect(harness.service.get(actor, containerId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(harness.service.action(actor, containerId, 'stop'))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(harness.service.repairSsh(actor, containerId))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(harness.service.getStats(actor, containerId))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(harness.service.updateLimits(actor, containerId, { memBytes: 1 }))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(harness.service.resizeRoot(actor, containerId, { sizeBytes: 2_147_483_648 }))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(harness.service.mutateGpus(actor, containerId, {}))
        .rejects.toBeInstanceOf(NotFoundException);
    }
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
    expect(harness.intents.createPending).not.toHaveBeenCalled();
  });

  it('refuses scope=all without the user admin role (403), also on the caller\'s own container', async () => {
    const harness = makeHarness();
    await expect(harness.service.get(owner, containerId, 'all')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(harness.service.action(owner, containerId, 'stop', 'all'))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(harness.service.updateLimits(owner, containerId, { memBytes: 1 }, 'all'))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(harness.service.mutateGpus(stranger, containerId, {}, 'all'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.intents.createPending).not.toHaveBeenCalled();
  });

  it('lets a user admin act on someone else\'s container with scope=all and no grant check', async () => {
    const harness = makeHarness();
    await expect(harness.service.repairSsh(userAdmin, containerId, 'all')).resolves.toEqual({ woken: true });
    await harness.service.updateLimits(userAdmin, containerId, { memBytes: 99_000_000_000 }, 'all');
    expect(resolveServerAccessMock).not.toHaveBeenCalled();
    expect(harness.repository.updateDesired).toHaveBeenCalled();
  });

  it('gives a user admin the owner rules on their own container unless scope=all', async () => {
    const harness = makeHarness();
    Object.assign(harness.row, { owner_id: userAdmin.userId });
    await harness.service.updateLimits(userAdmin, containerId, { memBytes: 99_000_000_000 });
    expect(resolveServerAccessMock).toHaveBeenCalledWith(
      harness.transaction,
      userAdmin.userId,
      serverId,
    );
    expect(assertActorRoleMock).not.toHaveBeenCalled();
  });

  it('rejects scope=all lists without the user admin role and scopes mine to the caller', async () => {
    const harness = makeHarness();
    await expect(harness.service.list(owner, { scope: 'all' })).rejects.toBeInstanceOf(ForbiddenException);
    const list = vi.fn().mockResolvedValue([]);
    Object.assign(harness.repository, { list });
    await harness.service.list(owner, {});
    expect(list).toHaveBeenLastCalledWith({ ownerId: actorId, serverId: undefined });
    await harness.service.list(userAdmin, { scope: 'all', serverId: 'server-9' });
    expect(list).toHaveBeenLastCalledWith({ ownerId: undefined, serverId: 'server-9' });
  });

  it('requires a signed-in user for console admission', async () => {
    const harness = makeHarness();
    await expect(harness.service.createExecSession(
      SYSTEM_ACTOR,
      containerId,
      { command: ['/bin/sh'], tty: true, cols: 80, rows: 24 },
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.consoleSessions.create).not.toHaveBeenCalled();
  });
});
