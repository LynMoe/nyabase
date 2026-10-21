import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  AuditAction,
  Capability,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  FailureCode,
  IntentKind,
  IntentResourceType,
  StoragePoolResizeFamily,
} from '@nyabase/common';
import { makeContainerControlService } from './container-services.test-helper.js';
import { checkRootResize } from './container-rules.js';
import { systemActor } from '../iam/actor.js';
import { testActor } from '../iam/actor.test-helper.js';

const containerId = 'container-1';
const serverId = 'server-1';
const actorId = 'user-1';
const owner = testActor(actorId);
const operator = testActor('operator-1', Capability.ManageContainersAny);
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
    findDetachingAttachment: vi.fn().mockResolvedValue(undefined),

  };
  const access = {
    assertAttachedStorageCoveredInTransaction: vi.fn().mockResolvedValue(undefined),
    resolveServerInTransaction: vi.fn().mockResolvedValue({
      cpuMillis: 2_000,
      memBytes: 4_000_000_000,
      diskBytes: 8_000_000_000,
      gpuPciAddresses: [],
    }),
    assertActorCapabilitiesInTransaction: vi.fn(),
  };
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
      forContainer: vi.fn(),
      health: vi.fn(),
      releaseContainerClaims: vi.fn().mockResolvedValue(undefined),
    } as never,
  );
  return {
    service,
    transaction,
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
      cpuMillis: 750,
      memBytes: 2_000_000_000,
    });

    expect(harness.repository.updateDesired).toHaveBeenCalledWith(
      containerId,
      1,
      { cpu_millis: 750, mem_bytes: 2_000_000_000 },
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
    harness.access.resolveServerInTransaction.mockResolvedValueOnce(null);

    await expect(harness.service.updateLimits(owner, containerId, {
      cpuMillis: 750,
      memBytes: 2_000_000_000,
    })).rejects.toThrow('Server access was revoked');
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
    expect(harness.intents.createPending).not.toHaveBeenCalled();
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

  it('lets nyabase-system stop a container without ManageContainersAny', async () => {
    const harness = makeHarness();
    await harness.service.action(systemActor('system-actor'), containerId, 'stop');
    expect(harness.access.assertActorCapabilitiesInTransaction).not.toHaveBeenCalled();
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

  it('still requires ManageContainersAny for operator admin stop', async () => {
    const harness = makeHarness();
    await harness.service.action(operator, containerId, 'stop');
    expect(harness.access.assertActorCapabilitiesInTransaction).toHaveBeenCalledWith(
      harness.transaction,
      'operator-1',
      [Capability.ManageContainersAny],
    );
    expect(harness.access.resolveServerInTransaction).not.toHaveBeenCalled();
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
    expect(harness.access.resolveServerInTransaction).toHaveBeenCalled();
    expect(harness.access.assertActorCapabilitiesInTransaction).not.toHaveBeenCalled();
  });

  it('refuses another user without the capability, with the owner-only route statuses', async () => {
    const harness = makeHarness();
    // reads and power actions were 403
    await expect(harness.service.get(stranger, containerId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(harness.service.action(stranger, containerId, 'stop'))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(harness.service.repairSsh(stranger, containerId))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(harness.service.getStats(stranger, containerId))
      .rejects.toBeInstanceOf(ForbiddenException);
    // desired-state edits and GPU changes hid the row with a 404
    await expect(harness.service.updateLimits(stranger, containerId, { cpuMillis: 1, memBytes: 1 }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(harness.service.resizeRoot(stranger, containerId, { sizeBytes: 2_147_483_648 }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(harness.service.mutateGpus(stranger, containerId, {}))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
    expect(harness.intents.createPending).not.toHaveBeenCalled();
  });

  it('lets a ManageContainersAny holder act on someone else\'s container without a grant', async () => {
    const harness = makeHarness();
    await expect(harness.service.repairSsh(operator, containerId)).resolves.toEqual({ woken: true });
    await harness.service.updateLimits(operator, containerId, { cpuMillis: 99_000, memBytes: 99_000_000_000 });
    expect(harness.access.resolveServerInTransaction).not.toHaveBeenCalled();
    expect(harness.repository.updateDesired).toHaveBeenCalled();
  });

  it('rejects scope=all lists without the capability and scopes mine to the caller', async () => {
    const harness = makeHarness();
    await expect(harness.service.list(owner, { scope: 'all' })).rejects.toBeInstanceOf(ForbiddenException);
    const list = vi.fn().mockResolvedValue([]);
    Object.assign(harness.repository, { list });
    await harness.service.list(owner, {});
    expect(list).toHaveBeenLastCalledWith({ ownerId: actorId, serverId: undefined });
    await harness.service.list(operator, { scope: 'all', serverId: 'server-9' });
    expect(list).toHaveBeenLastCalledWith({ ownerId: undefined, serverId: 'server-9' });
  });

  it('requires a browser JWT for console admission', async () => {
    const harness = makeHarness();
    await expect(harness.service.createExecSession(
      { ...owner, authKind: 'api-token' },
      containerId,
      { command: ['/bin/sh'], tty: true, cols: 80, rows: 24 },
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.consoleSessions.create).not.toHaveBeenCalled();
  });
});
