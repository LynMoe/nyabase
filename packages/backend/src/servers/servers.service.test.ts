import {
  AgentTaskKind, AgentTaskStatus, ContainerPhase, ContainerPowerIntent, ContainerStatus,
  MAX_PLATFORM_SERVERS, ServerStatus,
  AuditAction,
} from '@nyabase/common';
import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessResolverService } from '../access/access-resolver.service.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { HttpDomainPoolEntity } from '../entities/http-domain-pool.entity.js';
import { HttpProxyBindingEntity } from '../entities/http-proxy-binding.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import type { AgentGateway } from '../gateway/agent-gateway.js';
import type { SshProxyGateway } from '../ssh/ssh-proxy-gateway.js';
import { ServersService } from './servers.service.js';
import { AgentTaskFinalizerService } from '../agent-tasks/agent-task-finalizer.service.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { HttpHostnameReservationEntity } from '../entities/http-hostname-reservation.entity.js';
import type { AuditService } from '../audit/audit.service.js';

describe('ServersService delete fencing', () => {
  let dataSource: DataSource;
  let service: ServersService;
  let broadcastSnapshot: ReturnType<typeof vi.fn>;
  let runWithSessionFence: ReturnType<typeof vi.fn>;
  let claimSessionFence: ReturnType<typeof vi.fn>;
  let auditLog: ReturnType<typeof vi.fn>;
  let assertActorCapabilities: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        ServerEntity,
        ImageEntity,
        AgentTaskEntity,
        ResourceLockEntity,
        RemoteFsServerAssignmentEntity,
        RemoteFsMountEntity,
        ContainerEntity,
        ContainerDesiredSpecEntity,
        ContainerLifecycleEntity,
        ContainerMountEntity,
        DataDirectoryEntity,
        QuotaDesiredEntity,
        GpuAllocationEntity,
        ContainerSshRouteEntity,
        ServerGrantEntity,
        ImageGrantEntity,
        HttpDomainPoolEntity,
        HttpProxyBindingEntity,
        MountSourceGrantEntity,
        NetworkAddressClaimEntity,
        HttpHostnameReservationEntity,
      ],
    });
    await dataSource.initialize();
    broadcastSnapshot = vi.fn().mockResolvedValue(undefined);
    claimSessionFence = vi.fn();
    runWithSessionFence = vi.fn(async (
      _serverId: string,
      _reason: string,
      work: () => Promise<unknown>,
      options?: { authorizeAndClaim?: (claim: () => void) => Promise<void> },
    ) => {
      await options?.authorizeAndClaim?.(() => {
        (claimSessionFence as unknown as () => void)();
      });
      return work();
    });
    auditLog = vi.fn().mockResolvedValue(undefined);
    assertActorCapabilities = vi.fn().mockResolvedValue(new Set());
    service = new ServersService(
      dataSource.getRepository(ServerEntity),
      {
        runWithSessionFence,
        stateCache: { get: vi.fn().mockReturnValue(undefined) },
      } as unknown as AgentGateway,
      {
        assertActorCapabilitiesInTransaction: assertActorCapabilities,
        runWithActorCapabilities: vi.fn(async (
          actorId: string,
          capabilities: unknown,
          work: (manager: unknown) => Promise<unknown>,
        ) => {
          await (assertActorCapabilities as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>)(dataSource.manager, actorId, capabilities);
          return work(dataSource.manager);
        }),
      } as unknown as AccessResolverService,
      { broadcastSnapshot } as unknown as SshProxyGateway,
      dataSource,
      { forgetServer: vi.fn() } as never,
      { log: auditLog } as unknown as AuditService,
    );
    await insertServer();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('exposes the immutable host fingerprint only in the explicit admin projection', async () => {
    const hostFingerprint = 'a'.repeat(64);
    await dataSource.getRepository(ServerEntity).update('server-a', { hostFingerprint });

    await expect(service.findDtoById('server-a')).resolves.not.toHaveProperty(
      'hostFingerprint',
    );
    await expect(
      service.findDtoById('server-a', { includeHostFingerprint: true }),
    ).resolves.toMatchObject({ id: 'server-a', hostFingerprint });
    await expect(
      service.findAllDtos({ includeHostFingerprint: true }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'server-a', hostFingerprint }),
    ]);
  });

  it('keeps ordinary server projections free of host and Agent internals', async () => {
    const projected = await service.findUserDtoById('server-a');
    expect(projected).toEqual({
      id: 'server-a',
      name: 'Server A',
      slug: 'server-a',
      status: ServerStatus.Unknown,
      lastSeenAt: null,
      runtimeReady: false,
    });
    expect(projected).not.toHaveProperty('agentTokenHash');
    expect(projected).not.toHaveProperty('dockerDaemon');
    expect(projected).not.toHaveProperty('disks');
    expect(projected).not.toHaveProperty('gpus');
    expect(projected).not.toHaveProperty('quarantineCode');
  });

  it('does not throw when a legacy runtime cache contains an invalid epoch', async () => {
    const internals = service as unknown as {
      agentGateway: { stateCache: { get(serverId: string): unknown } };
    };
    internals.agentGateway.stateCache.get = vi.fn().mockReturnValue({
      runtimeReady: true,
      lastUpdated: 1e300,
      disks: [],
      gpus: [],
      dockerDaemon: null,
      agentVersion: '0.1.0',
    });

    await expect(service.findDtoById('server-a')).resolves.toMatchObject({
      id: 'server-a',
      runtimeObservedAt: null,
    });
  });

  it('validates commandAck self-check data before exposing it', async () => {
    const internals = service as unknown as {
      agentGateway: {
        isOnline(serverId: string): boolean;
        stateCache: { getRuntimeBlockReason(serverId: string): { enabled: boolean } };
        rpc(serverId: string, kind: string, payload: unknown): Promise<unknown>;
      };
      accessResolver: {
        startExternalWithActorCapabilities(
          actorId: string,
          capabilities: unknown,
          work: () => Promise<unknown>,
        ): Promise<{ completion: Promise<unknown> }>;
      };
    };
    internals.agentGateway.isOnline = vi.fn().mockReturnValue(true);
    internals.agentGateway.stateCache.getRuntimeBlockReason = vi.fn().mockReturnValue({ enabled: true });
    internals.accessResolver.startExternalWithActorCapabilities = vi.fn(async (
      _actorId,
      _capabilities,
      work,
    ) => ({ completion: work() }));
    internals.agentGateway.rpc = vi.fn().mockResolvedValue({
      items: [{ id: 'docker', label: 'Docker', status: 'ok', message: 'healthy' }],
    });
    await expect(service.selfCheck('actor-a', 'server-a')).resolves.toEqual({
      items: [{ id: 'docker', label: 'Docker', status: 'ok', message: 'healthy' }],
    });

    internals.agentGateway.rpc = vi.fn().mockResolvedValue({
      items: Array.from({ length: 129 }, () => ({
        id: 'docker', label: 'Docker', status: 'ok', message: 'healthy',
      })),
    });
    await expect(service.selfCheck('actor-a', 'server-a')).rejects.toThrow();
  });

  it('does not acquire an Agent session fence after server authority is revoked', async () => {
    assertActorCapabilities.mockRejectedValueOnce(new Error('authority revoked'));
    await expect(service.delete('actor-a', 'server-a')).rejects.toThrow('authority revoked');
    expect(claimSessionFence).not.toHaveBeenCalled();
    expect(await dataSource.getRepository(ServerEntity).countBy({ id: 'server-a' })).toBe(1);
    expect(auditLog).not.toHaveBeenCalled();

    assertActorCapabilities.mockRejectedValueOnce(new Error('authority revoked'));
    await expect(service.regenerateToken('actor-a', 'server-a')).rejects.toThrow('authority revoked');
    expect(claimSessionFence).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('rechecks authority after fencing and never mutates when revocation wins the final lease', async () => {
    assertActorCapabilities
      .mockResolvedValueOnce(new Set())
      .mockRejectedValueOnce(new Error('authority revoked after fence claim'));

    await expect(service.delete('actor-a', 'server-a'))
      .rejects.toThrow('authority revoked after fence claim');

    expect(claimSessionFence).toHaveBeenCalledOnce();
    expect(await dataSource.getRepository(ServerEntity).countBy({ id: 'server-a' })).toBe(1);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('refuses deletion while a pending task and resource lock reference the server', async () => {
    await dataSource.getRepository(AgentTaskEntity).save({
      id: 'task-a',
      kind: AgentTaskKind.ImageEnsurePresent,
      serverId: 'server-a',
      resourceType: 'image',
      resourceId: 'image-a',
      requestedBy: null,
      requestJson: null,
      payloadJson: { dockerRef: 'example.invalid/image:a' },
      payloadHash: 'hash-a',
      status: AgentTaskStatus.Pending,
      failureStage: null,
      agentResultJson: null,
      dispatchAttemptCount: 0,
      nextDispatchAt: null,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      resultJson: null,
      errorJson: null,
      startedAt: null,
      lastSentAt: null,
      completedAt: null,
    });
    await dataSource.getRepository(ResourceLockEntity).insert({
      resourceKey: 'image:server-a:image-a',
      taskId: 'task-a',
      serverId: 'server-a',
    });

    await expect(service.delete('actor-a', 'server-a')).rejects.toMatchObject({
      response: {
        code: 'SERVER_NOT_EMPTY',
        dependencies: expect.arrayContaining(['pending agent tasks', 'resource locks']),
      },
    });
    expect(await dataSource.getRepository(ServerEntity).findOneBy({ id: 'server-a' })).not.toBeNull();
    expect(broadcastSnapshot).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
    expect(runWithSessionFence).toHaveBeenCalledWith(
      'server-a',
      'Server deletion started',
      expect.any(Function),
      expect.objectContaining({
        requireBoundServerEmptyInventory: true,
        authorizeAndClaim: expect.any(Function),
      }),
    );
  });

  it('deletes an empty server transactionally', async () => {
    await expect(service.delete('actor-a', 'server-a')).resolves.toBeUndefined();
    expect(await dataSource.getRepository(ServerEntity).findOneBy({ id: 'server-a' })).toBeNull();
    expect(runWithSessionFence).toHaveBeenCalledWith(
      'server-a',
      'Server deletion started',
      expect.any(Function),
      expect.objectContaining({
        requireBoundServerEmptyInventory: true,
        authorizeAndClaim: expect.any(Function),
      }),
    );
    expect(broadcastSnapshot).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      'actor-a',
      AuditAction.DeleteServer,
      'server-a',
      'server',
      { serverId: 'server-a', name: 'Server A', slug: 'server-a' },
    );
  });

  it('serializes concurrent creation at the fixed server capacity boundary', async () => {
    await dataSource.getRepository(ServerEntity).save(Array.from(
      { length: MAX_PLATFORM_SERVERS - 2 },
      (_, index) => ({
        id: `server-cap-${index}`,
        name: `Capacity ${index}`,
        slug: `server-cap-${index}`,
        agentTokenHash: `token-hash-cap-${index}`,
        hostFingerprint: null,
        agentConfigFingerprint: null,
        status: ServerStatus.Unknown,
        lastSeenAt: null,
      }),
    ));

    const results = await Promise.allSettled([
      service.create('actor-a', { name: 'Last A', slug: 'last-a' }),
      service.create('actor-a', { name: 'Last B', slug: 'last-b' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await dataSource.getRepository(ServerEntity).count()).toBe(MAX_PLATFORM_SERVERS);
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      'actor-a',
      AuditAction.CreateServer,
      expect.any(String),
      'server',
      expect.not.objectContaining({ agentToken: expect.anything() }),
    );
  });

  it('refuses deletion while an exact local mount-source grant references the server', async () => {
    await dataSource.getRepository(MountSourceGrantEntity).save({
      id: 'mount-grant-a',
      scope: 'user',
      scopeId: 'user-a',
      sourceKind: 'local',
      sourceId: 'disk-a',
      serverId: 'server-a',
      sourceIdentity: 'disk-identity-a',
    });

    await expect(service.delete('actor-a', 'server-a')).rejects.toMatchObject({
      response: {
        code: 'SERVER_NOT_EMPTY',
        dependencies: expect.arrayContaining(['local mount source grants']),
      },
    });
    expect(await dataSource.getRepository(ServerEntity).findOneBy({ id: 'server-a' })).not.toBeNull();
    expect(await dataSource.getRepository(MountSourceGrantEntity).findOneBy({ id: 'mount-grant-a' }))
      .not.toBeNull();
    expect(broadcastSnapshot).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('updates only mutable metadata and never resurrects or rolls back server identity', async () => {
    await dataSource.getRepository(ServerEntity).update('server-a', {
      hostFingerprint: 'host-fingerprint-a',
      agentConfigFingerprint: 'config-fingerprint-a',
    });
    const rawToken = await service.regenerateToken('actor-a', 'server-a');
    const rotatedHash = createHash('sha256').update(rawToken).digest('hex');

    await expect(service.update('actor-a', 'server-a', {
      name: 'Renamed Server',
      slug: 'renamed-server',
    })).resolves.toMatchObject({
      name: 'Renamed Server',
      slug: 'renamed-server',
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: 'server-a' }))
      .toMatchObject({
        agentTokenHash: rotatedHash,
        hostFingerprint: 'host-fingerprint-a',
        agentConfigFingerprint: 'config-fingerprint-a',
      });

    expect(auditLog).toHaveBeenCalledWith(
      'actor-a',
      AuditAction.UpdateServer,
      'server-a',
      'server',
      {
        serverId: 'server-a',
        previous: { name: 'Server A', slug: 'server-a' },
        current: { name: 'Renamed Server', slug: 'renamed-server' },
      },
    );

    await service.delete('actor-a', 'server-a');
    const successfulAuditCount = auditLog.mock.calls.length;
    await expect(service.update('actor-a', 'server-a', { name: 'Must Not Return' }))
      .rejects.toMatchObject({ status: 404 });
    expect(auditLog).toHaveBeenCalledTimes(successfulAuditCount);
    expect(await dataSource.getRepository(ServerEntity).count()).toBe(0);
  });

  it('does not roll back a committed server mutation when audit storage is unavailable', async () => {
    auditLog.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(service.update('actor-a', 'server-a', { name: 'Committed Name' }))
      .resolves.toMatchObject({ name: 'Committed Name' });

    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: 'server-a' }))
      .toMatchObject({ name: 'Committed Name' });
    expect(auditLog).toHaveBeenCalledOnce();
  });

  it('cascades terminal task history while deleting an otherwise empty server', async () => {
    await dataSource.getRepository(AgentTaskEntity).save({
      id: 'task-terminal',
      kind: AgentTaskKind.ImageEnsurePresent,
      serverId: 'server-a',
      resourceType: 'image',
      resourceId: 'image-a',
      requestedBy: null,
      requestJson: null,
      payloadJson: { dockerRef: 'example.invalid/image:a' },
      payloadHash: 'hash-terminal',
      status: AgentTaskStatus.Succeeded,
      failureStage: null,
      agentResultJson: { dockerRef: 'example.invalid/image:a', present: true },
      dispatchAttemptCount: 1,
      nextDispatchAt: null,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      resultJson: { dockerRef: 'example.invalid/image:a', present: true },
      errorJson: null,
      startedAt: new Date(),
      lastSentAt: new Date(),
      completedAt: new Date(),
    });

    await expect(service.delete('actor-a', 'server-a')).resolves.toBeUndefined();
    expect(await dataSource.getRepository(ServerEntity).count()).toBe(0);
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(0);
  });

  it('hard-deletes the container aggregate and every proxy/resource projection after physical absence', async () => {
    const runtimeOverrides = { uid: 0, entrypoint: null, cmd: null, init: false };
    await dataSource.getRepository(ImageEntity).save({
      id: 'image-a',
      name: 'Image A',
      dockerImage: 'example.invalid/image:a',
      runtimeOverrides,
      description: null,
      isActive: true,
      disableSsh: false,
    });
    await dataSource.getRepository(ContainerEntity).save({
      id: 'container-a',
      serverId: 'server-a',
      ownerId: 'user-a',
      name: 'work',
      imageId: 'image-a',
      createdBy: 'user-a',
    });
    await dataSource.getRepository(ContainerDesiredSpecEntity).save({
      id: 'desired-a',
      containerId: 'container-a',
      generation: 1,
      imageRef: 'example.invalid/image:a',
      imageDefaultUid: 0,
      imageRuntimeOverrides: runtimeOverrides,
      cpuMillis: 1000,
      memBytes: 1024,
      diskBytes: 2048,
      gpuMode: 'indices',
      gpuIndices: [0],
      mountsJson: [],
      powerIntent: ContainerPowerIntent.Stopped,
    });
    await dataSource.getRepository(ContainerLifecycleEntity).save({
      containerId: 'container-a',
      phase: ContainerPhase.Deleting,
      boundRuntimeId: 'runtime-a',
      quotaPathsJson: ['/docker/upper', '/docker/work'],
      runtimeSpecHash: 'a'.repeat(64),
      activeTaskId: 'delete-task-a',
      lastTransitionAt: new Date(),
      failureReason: null,
      failureCode: null,
    });
    await dataSource.getRepository(ContainerMountEntity).save({
      id: 'mount-a',
      serverId: 'server-a',
      containerId: 'container-a',
      containerName: 'work',
      sourceKind: 'local',
      sourceId: 'disk-a',
      sourceIdentity: 'disk-identity-a',
      userId: 'user-a',
      dirName: 'data',
      containerPath: '/data',
    });
    await dataSource.getRepository(GpuAllocationEntity).save({
      containerId: 'container-a',
      serverId: 'server-a',
      gpuIndicesJson: [0],
      allocatedAt: new Date(),
    });
    await dataSource.getRepository(ContainerSshRouteEntity).save({
      containerId: 'container-a',
      serverId: 'server-a',
      runtimeId: 'runtime-a',
      macvlanIp: '10.0.0.2',
      runtimeStatus: ContainerStatus.Exited,
      sshStatus: 'container_stopped',
      appliedInternalKeyGeneration: null,
      containerHostKeyFingerprint: null,
      lastError: null,
      observedAt: new Date(),
    });
    await dataSource.getRepository(HttpDomainPoolEntity).save({
      id: 'pool-a',
      wildcardDomain: '*.example.test',
      enabled: true,
      httpsEnabled: false,
      certificatePem: null,
      encryptedPrivateKeyPem: null,
      certificateFingerprint: null,
      certificateNotAfter: null,
    });
    await dataSource.getRepository(HttpProxyBindingEntity).save({
      id: 'binding-a',
      hostname: 'work.example.test',
      domainPoolId: 'pool-a',
      ownerId: 'user-a',
      containerId: 'container-a',
      targetPort: 8080,
    });
    await dataSource.getRepository(HttpHostnameReservationEntity).save({
      hostname: 'work.example.test',
      ownerId: 'user-a',
      bindingId: 'binding-a',
      state: 'active',
      reusableAt: null,
    });
    await dataSource.getRepository(NetworkAddressClaimEntity).save({
      id: 'claim-container-a',
      address: '10.0.0.2',
      networkKey: '10.0.0.0/24',
      ownerKind: 'container',
      ownerId: 'container-a',
      serverId: 'server-a',
      state: 'active',
      reusableAt: null,
    });

    await dataSource.transaction((manager) => new AgentTaskFinalizerService().applySucceeded(
      manager,
      {
        id: 'delete-task-a',
        kind: AgentTaskKind.ContainerDelete,
        serverId: 'server-a',
        resourceId: 'container-a',
        payloadJson: { containerId: 'container-a', runtimeId: 'runtime-a' },
      } as AgentTaskEntity,
      { present: false },
    ));

    for (const entity of [
      ContainerEntity,
      ContainerDesiredSpecEntity,
      ContainerLifecycleEntity,
      ContainerMountEntity,
      GpuAllocationEntity,
      ContainerSshRouteEntity,
      HttpProxyBindingEntity,
    ]) {
      expect(await dataSource.manager.count(entity)).toBe(0);
    }
    await expect(dataSource.getRepository(ContainerEntity).save({
      id: 'container-recreated',
      serverId: 'server-a',
      ownerId: 'user-a',
      name: 'work',
      imageId: 'image-a',
      createdBy: 'user-a',
    })).resolves.toMatchObject({ id: 'container-recreated' });
    await dataSource.getRepository(ContainerEntity).delete('container-recreated');
    await expect(service.delete('actor-a', 'server-a')).rejects.toMatchObject({
      response: {
        code: 'SERVER_NOT_EMPTY',
        dependencies: expect.arrayContaining(['active or draining network address claims']),
      },
    });
  });

  it('database-rejects server-scoped state resurrection after deletion', async () => {
    await service.delete('actor-a', 'server-a');

    await expect(dataSource.getRepository(ServerGrantEntity).insert({
      id: 'grant-after-delete',
      scope: 'user',
      scopeId: 'user-a',
      serverId: 'server-a',
      cpuMillis: null,
      memBytes: null,
      diskBytes: 1024,
      gpuMode: null,
      gpuIndices: null,
    })).rejects.toThrow(/FOREIGN KEY/i);
    expect(await dataSource.getRepository(ServerGrantEntity).count()).toBe(0);

    await expect(dataSource.getRepository(NetworkAddressClaimEntity).insert({
      id: 'claim-after-delete',
      address: '10.0.0.9',
      networkKey: '10.0.0.0/24',
      ownerKind: 'container',
      ownerId: 'container-after-delete',
      serverId: 'server-a',
      state: 'active',
      reusableAt: null,
    })).rejects.toThrow(/FOREIGN KEY/i);
    expect(await dataSource.getRepository(NetworkAddressClaimEntity).count()).toBe(0);
  });

  it('database rejects malformed network claim ownership and lease shapes', async () => {
    await expect(dataSource.getRepository(NetworkAddressClaimEntity).insert({
      id: 'container-without-server',
      address: '10.0.0.9',
      networkKey: '10.0.0.0/24',
      ownerKind: 'container',
      ownerId: 'container-a',
      serverId: null,
      state: 'active',
      reusableAt: null,
    })).rejects.toThrow(/CHECK/i);
    await expect(dataSource.getRepository(NetworkAddressClaimEntity).insert({
      id: 'active-with-deadline',
      address: '10.0.0.10',
      networkKey: '10.0.0.0/24',
      ownerKind: 'container',
      ownerId: 'container-b',
      serverId: 'server-a',
      state: 'active',
      reusableAt: new Date(),
    })).rejects.toThrow(/CHECK/i);
    await expect(dataSource.getRepository(NetworkAddressClaimEntity).insert({
      id: 'runtime-without-evidence',
      address: '10.0.0.11',
      networkKey: '10.0.0.0/24',
      ownerKind: 'runtime_cleanup',
      ownerId: 'runtime-a',
      serverId: 'server-a',
      state: 'active',
      cleanupPayloadJson: () => 'NULL',
      reusableAt: null,
    })).rejects.toThrow(/CHECK/i);
  });

  it('drops terminal quota projection while deleting an otherwise empty server', async () => {
    await dataSource.getRepository(QuotaDesiredEntity).save({
      id: 'quota-a',
      serverId: 'server-a',
      userId: 'user-a',
      numericUserId: 1001,
      limitBytes: 4096,
      source: 'grant',
      generation: 1,
      lastTaskId: 'terminal-task-a',
    });
    await dataSource.getRepository(AgentTaskEntity).save({
      id: 'terminal-task-a',
      kind: AgentTaskKind.QuotaEnsure,
      serverId: 'server-a',
      resourceType: 'quota',
      resourceId: 'user-a',
      requestedBy: null,
      requestJson: null,
      payloadJson: { generation: 1, numericUserId: 1001, diskBytes: 4096 },
      payloadHash: 'hash-terminal-quota',
      status: AgentTaskStatus.Succeeded,
      failureStage: null,
      agentResultJson: { numericUserId: 1001, hardLimitBytes: 4096 },
      dispatchAttemptCount: 1,
      nextDispatchAt: null,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      resultJson: { numericUserId: 1001, hardLimitBytes: 4096 },
      errorJson: null,
      startedAt: new Date(),
      lastSentAt: new Date(),
      completedAt: new Date(),
    });

    await expect(service.delete('actor-a', 'server-a')).resolves.toBeUndefined();
    expect(await dataSource.getRepository(QuotaDesiredEntity).count()).toBe(0);
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(0);
  });

  async function insertServer(): Promise<void> {
    await dataSource.getRepository(ServerEntity).save({
      id: 'server-a',
      name: 'Server A',
      slug: 'server-a',
      agentTokenHash: 'token-hash-a',
      hostFingerprint: null,
      agentConfigFingerprint: null,
      status: ServerStatus.Unknown,
      lastSeenAt: null,
    });
  }
});
