import { describe, expect, it, vi } from 'vitest';
import {
  AuditAction,
  Capability,
  ContainerPhase,
  ContainerPowerIntent,
  IntentKind,
  IntentResourceType,
} from '@nyabase/common';
import { ContainerControlService } from './container-control.service.js';

const containerId = 'container-1';
const serverId = 'server-1';
const actorId = 'user-1';

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
    generation: 1,
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
    updateDesired: vi.fn().mockResolvedValue({ ...row, generation: 2 }),

  };
  const access = {
    resolveServerInTransaction: vi.fn().mockResolvedValue({
      accessPhase: 'live',
      cpuMillis: 2_000,
      memBytes: 4_000_000_000,
      diskBytes: 8_000_000_000,
      extensionGrants: {},
    }),
    assertActorCapabilitiesInTransaction: vi.fn(),
  };
  const intent = {
    id: 'intent-1',
    kind: IntentKind.ContainerUpdate,
    resourceType: IntentResourceType.Container,
    resourceId: containerId,
    serverId,
    targetGeneration: 2,
    createdAt: '2026-08-07T03:00:00.000Z',
  };
  const intents = {
    createPending: vi.fn().mockResolvedValue(intent),
  };
  const audit = { append: vi.fn() };
  const wake = { wake: vi.fn() };
  const transactions = {
    run: vi.fn(async (work: (value: unknown) => Promise<unknown>) => work(transaction)),
  };
  const attachmentQuery = {
    select: vi.fn(),
    where: vi.fn(),
    executeTakeFirst: vi.fn().mockResolvedValue(undefined),
  };
  attachmentQuery.select.mockReturnValue(attachmentQuery);
  attachmentQuery.where.mockReturnValue(attachmentQuery);
  Object.assign(transaction, {
    selectFrom: vi.fn((table: string) => (
      table === 'control.volume_attachments' ? attachmentQuery : serverQuery
    )),
  });
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
  const service = new ContainerControlService(
    {} as never,
    transactions as never,
    repository as never,
    access as never,
    intents as never,
    wake as never,
    consoleSessions as never,
    audit as never,
    {} as never,
    { listForServer: vi.fn().mockResolvedValue([]) } as never,
    { get: vi.fn().mockReturnValue(null) } as never,
    sshConvergence as never,
  );
  return {
    service,
    transaction,
    row,
    repository,
    access,
    intents,
    audit,
    wake,
    consoleSessions,
  };
}

describe('ContainerControlService intent boundary', () => {
  it('updates limits online and creates the intent atomically', async () => {
    const harness = makeHarness();
    const result = await harness.service.updateLimitsForUser(containerId, actorId, {
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
        targetGeneration: 2,
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
    expect(harness.wake.wake).toHaveBeenCalledWith({
      resourceType: IntentResourceType.Container,
      resourceId: containerId,
      serverId,
      reason: 'intent',
    });
    expect(result).toMatchObject({
      intentId: 'intent-1',
      targetGeneration: 2,
      status: 'pending',
    });
  });

  it('rejects mutations after server access enters grace without writing desired state', async () => {
    const harness = makeHarness();
    harness.access.resolveServerInTransaction.mockResolvedValueOnce({
      accessPhase: 'grace',
    });

    await expect(harness.service.updateLimitsForUser(containerId, actorId, {
      cpuMillis: 750,
      memBytes: 2_000_000_000,
    })).rejects.toThrow('Server access was revoked');
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
    expect(harness.intents.createPending).not.toHaveBeenCalled();
    expect(harness.wake.wake).not.toHaveBeenCalled();
  });

  it('stores the observed started_at baseline for restart without calling Incus', async () => {
    const harness = makeHarness();
    const result = await harness.service.action(containerId, 'restart', actorId);

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
    const attachmentQuery = harness.transaction.selectFrom!('control.volume_attachments') as {
      executeTakeFirst: ReturnType<typeof vi.fn>;
    };
    attachmentQuery.executeTakeFirst.mockResolvedValue({ id: 'att-1' });

    await expect(harness.service.action(containerId, 'start', actorId)).rejects.toMatchObject({
      response: { code: 'INSTANCE_BUSY' },
    });
    await expect(harness.service.action(containerId, 'restart', actorId)).rejects.toMatchObject({
      response: { code: 'INSTANCE_BUSY' },
    });
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
    expect(harness.intents.createPending).not.toHaveBeenCalled();
  });

  it('lets nyabase-system stop a container without ManageContainersAny', async () => {
    const harness = makeHarness();
    await harness.service.actionForSystem(containerId, 'stop', 'system-actor');
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
    await harness.service.actionForAdmin(containerId, 'stop', actorId);
    expect(harness.access.assertActorCapabilitiesInTransaction).toHaveBeenCalledWith(
      harness.transaction,
      actorId,
      [Capability.ManageContainersAny],
    );
  });

  it('blocks root changes while a quota application is pending', async () => {
    const harness = makeHarness();
    Object.assign(harness.row, { root_size_pending_bytes: '2147483648' });

    await expect(harness.service.resizeRootForUser(containerId, actorId, {
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

    await expect(harness.service.resizeRootForUser(containerId, actorId, {
      sizeBytes: 5_368_709_120,
    })).rejects.toMatchObject({
      response: { code: 'ROOT_SHRINK_REQUIRES_STOP' },
    });
    expect(harness.repository.updateDesired).not.toHaveBeenCalled();
    expect(harness.intents.createPending).not.toHaveBeenCalled();
    expect(harness.wake.wake).not.toHaveBeenCalled();
  });

  it('authorizes exec through the current server grant and never audits the command', async () => {
    const harness = makeHarness();
    const secret = 'not-for-audit';
    const result = await harness.service.createExecSession(containerId, actorId, 4, {
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
    await expect(harness.service.createExecSession(containerId, 'other-user', 4, {
      command: ['/bin/sh'],
      tty: true,
      cols: 80,
      rows: 24,
    })).rejects.toThrow();
    expect(harness.consoleSessions.create).not.toHaveBeenCalled();
  });
});
