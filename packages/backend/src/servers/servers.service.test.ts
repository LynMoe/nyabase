import { ForbiddenException } from '@nestjs/common';
import { MAX_PLATFORM_SERVERS, ServerStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { ServersService } from './servers.service.js';

const server = {
  id: 'server-a',
  name: 'Node A',
  slug: 'node-a',
  agentTokenHash: 'a'.repeat(64),
  hostFingerprint: 'host-secret',
  agentConfigFingerprint: 'config-secret',
  status: ServerStatus.Online,
  quarantineCode: null,
  quarantineMessage: null,
  lastSeenAt: new Date('2026-01-01T00:00:00Z'),
  macvlanCidr: '10.1.0.0/24',
  macvlanGateway: '10.1.0.1',
  macvlanReservedIps: ['10.1.0.2'],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function transactionStub() {
  return {
    selectFrom: vi.fn(() => ({
      select: vi.fn(() => ({
        where: vi.fn(() => ({
          executeTakeFirst: vi.fn().mockResolvedValue(undefined),
        })),
      })),
    })),
  };
}

function makeService(overrides: {
  infrastructure?: Record<string, unknown>;
  gateway?: Record<string, unknown>;
  access?: Record<string, unknown>;
  workflow?: Record<string, unknown>;
} = {}) {
  const infrastructure = {
    findServerById: vi.fn().mockResolvedValue(server),
    findServerByTokenHash: vi.fn(),
    listServers: vi.fn().mockResolvedValue([server]),
    lockServerCapacity: vi.fn(),
    countServers: vi.fn().mockResolvedValue(0),
    findServerBySlug: vi.fn().mockResolvedValue(null),
    insertServer: vi.fn(),
    replaceAgentTokenHash: vi.fn(),
    ...overrides.infrastructure,
  };
  const gateway = {
    stateCache: {
      get: vi.fn().mockReturnValue(undefined),
      getAll: vi.fn().mockReturnValue([]),
    },
    runWithSessionFence: vi.fn(async (
      _id: string,
      _reason: string,
      work: () => Promise<unknown>,
      options?: { authorizeAndClaim?: (claim: () => void) => Promise<void> },
    ) => {
      await options?.authorizeAndClaim?.(() => undefined);
      return work();
    }),
    ...overrides.gateway,
  };
  const access = {
    assertActorCapabilitiesInTransaction: vi.fn().mockResolvedValue(new Set()),
    runWithActorCapabilities: vi.fn(async (
      _actorId: string,
      _capabilities: unknown,
      work: () => Promise<unknown>,
    ) => work()),
    ...overrides.access,
  };
  const transaction = transactionStub();
  const workflow = {
    runWithAgentSessionMutationFence: vi.fn(async (
      _serverId: string,
      _reason: string,
      work: (tx: ReturnType<typeof transactionStub>) => Promise<unknown>,
    ) => work(transaction)),
    ...overrides.workflow,
  };
  return {
    infrastructure,
    gateway,
    access,
    service: new ServersService(
      infrastructure,
      gateway as never,
      access as never,
      { broadcastSnapshot: vi.fn() } as never,
      { run: vi.fn((work) => work(transaction)) },
      { forgetServer: vi.fn() } as never,
      { append: vi.fn(), log: vi.fn() } as never,
      workflow as never,
    ),
  };
}

describe('ServersService PostgreSQL adapter boundary', () => {
  it('exposes immutable host identity only in the explicit admin projection', async () => {
    const { service } = makeService();
    await expect(service.findDtoById(server.id)).resolves.not.toHaveProperty(
      'hostFingerprint',
    );
    await expect(service.findDtoById(server.id, {
      includeHostFingerprint: true,
    })).resolves.toMatchObject({ hostFingerprint: 'host-secret' });
  });

  it('keeps ordinary user projections free of Agent credentials and addressing', async () => {
    const { service } = makeService();
    const dto = await service.findUserDtoById(server.id);
    expect(dto).not.toHaveProperty('agentTokenHash');
    expect(dto).not.toHaveProperty('hostFingerprint');
    expect(dto).not.toHaveProperty('macvlanCidr');
  });

  it('projects a server list from the single bulk read without per-server existence reads', async () => {
    const servers = Array.from({ length: 128 }, (_, index) => ({
      ...server,
      id: `server-${index}`,
      name: `Node ${index}`,
      slug: `node-${index}`,
    }));
    const findServerById = vi.fn();
    const { service, infrastructure } = makeService({
      infrastructure: {
        listServers: vi.fn().mockResolvedValue(servers),
        findServerById,
      },
    });

    await expect(service.findAllDtos()).resolves.toHaveLength(128);
    expect(infrastructure.listServers).toHaveBeenCalledOnce();
    expect(findServerById).not.toHaveBeenCalled();
  });

  it('retains the public disk-list server existence check', async () => {
    const findServerById = vi.fn().mockResolvedValue(server);
    const { service } = makeService({
      infrastructure: { findServerById },
    });

    await expect(service.listDiskDtos(server.id)).resolves.toEqual([]);
    expect(findServerById).toHaveBeenCalledOnce();
  });

  it('fails runtime readiness closed while durable quarantine outruns a stale projection', async () => {
    const quarantined = {
      ...server,
      status: ServerStatus.AgentQuarantined,
      quarantineCode: 'AGENT_TASK_FAIL_STOP',
      quarantineMessage: 'invalid Agent result',
    };
    const { service } = makeService({
      infrastructure: {
        findServerById: vi.fn().mockResolvedValue(quarantined),
      },
      gateway: {
        stateCache: {
          get: vi.fn().mockReturnValue({
            runtimeReady: true,
            lastUpdated: Date.parse('2026-01-01T00:00:01Z'),
            disks: [],
            gpus: [],
            dockerDaemon: null,
          }),
          getAll: vi.fn().mockReturnValue([]),
        },
      },
    });

    await expect(service.findDtoById(server.id)).resolves.toMatchObject({
      status: ServerStatus.AgentQuarantined,
      runtimeReady: false,
    });
    await expect(service.findUserDtoById(server.id)).resolves.toMatchObject({
      status: ServerStatus.AgentQuarantined,
      runtimeReady: false,
    });
  });

  it('checks server capacity while holding the PostgreSQL advisory lock', async () => {
    const { service, infrastructure } = makeService({
      infrastructure: {
        countServers: vi.fn().mockResolvedValue(MAX_PLATFORM_SERVERS),
      },
    });
    await expect(service.create('actor-a', {
      name: 'Overflow',
      slug: 'overflow',
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SERVER_CAPACITY_REACHED' }),
    });
    expect(infrastructure.lockServerCapacity).toHaveBeenCalledTimes(1);
    expect(infrastructure.insertServer).not.toHaveBeenCalled();
  });

  it('rolls back token mutation when transactional authority is revoked', async () => {
    const { service, infrastructure } = makeService({
      access: {
        assertActorCapabilitiesInTransaction: vi.fn().mockRejectedValue(
          new ForbiddenException('authority revoked'),
        ),
      },
    });
    await expect(service.regenerateToken('actor-a', server.id))
      .rejects.toThrow('authority revoked');
    expect(infrastructure.replaceAgentTokenHash).not.toHaveBeenCalled();
  });
});
