import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditAction, GpuGrantMode, ServerStatus, UserStatus } from '@nyabase/common';
import { ResourceKeyService } from '../../agent-tasks/resource-key.service.js';
import { ContainerDesiredSpecEntity } from '../../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../../entities/container-lifecycle.entity.js';
import { GpuAllocationEntity } from '../../entities/gpu-allocation.entity.js';
import { ImageEntity } from '../../entities/image.entity.js';
import { QuotaDesiredEntity } from '../../entities/quota-desired.entity.js';
import { ServerEntity } from '../../entities/server.entity.js';
import { SshProxyHostKeyEntity } from '../../entities/ssh-proxy-host-key.entity.js';
import { NetworkAddressClaimEntity } from '../../entities/network-address-claim.entity.js';
import { UserEntity } from '../../entities/user.entity.js';
import { UserInternalSshKeyEntity } from '../../entities/user-internal-ssh-key.entity.js';
import { SshIdentityService } from '../../ssh/ssh-identity.service.js';
import { ContainerControlService } from '../container-control.service.js';

describe('ContainerControlService SSH generation fence', () => {
  let dataSource: DataSource;
  let identities: SshIdentityService;
  let control: ContainerControlService;
  let audit: { log: ReturnType<typeof vi.fn> };
  const capturedPayloads: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    capturedPayloads.length = 0;
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        UserEntity,
        UserInternalSshKeyEntity,
        SshProxyHostKeyEntity,
        ServerEntity,
        ImageEntity,
        QuotaDesiredEntity,
        ContainerEntity,
        ContainerDesiredSpecEntity,
        ContainerLifecycleEntity,
        GpuAllocationEntity,
        NetworkAddressClaimEntity,
      ],
    });
    await dataSource.initialize();
    await dataSource.getRepository(UserEntity).save({
      id: 'user-a',
      numericId: 1001,
      username: 'alice',
      passwordHash: 'hash',
      displayName: 'Alice',
      status: UserStatus.Active,
    });
    await dataSource.getRepository(UserInternalSshKeyEntity).save({
      userId: 'user-a',
      encryptedPrivateKey: 'enc:private-1',
      publicKey: 'public-1',
      fingerprint: 'fingerprint-1',
      generation: 1,
      rotatedAt: new Date(),
    });
    await dataSource.getRepository(ServerEntity).save({
      id: 'server-a',
      name: 'Server A',
      slug: 'server-a',
      agentTokenHash: 'token-hash',
      hostFingerprint: 'host-a',
      agentConfigFingerprint: 'config-a',
      status: ServerStatus.Online,
      lastSeenAt: new Date(),
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanReservedIps: [],
    });
    await dataSource.getRepository(ImageEntity).save({
      id: 'image-a',
      name: 'image-a',
      dockerImage: 'image:a',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      description: null,
      isActive: true,
      disableSsh: false,
    });
    await dataSource.getRepository(QuotaDesiredEntity).save({
      id: 'quota-a',
      serverId: 'server-a',
      userId: 'user-a',
      numericUserId: 1001,
      limitBytes: 1024,
      source: 'grant',
      generation: 1,
      lastTaskId: 'quota-task-a',
    });

    const keygen = {
      generateEd25519: vi.fn(async (comment: string) => {
        const generation = Number(comment.split(':').at(-1)) || 1;
        return {
          privateKey: `private-${generation}`,
          publicKey: `public-${generation}`,
          fingerprint: `fingerprint-${generation}`,
        };
      }),
    };
    const crypto = {
      encrypt: vi.fn((value: string) => `enc:${value}`),
      decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
    };
    identities = new SshIdentityService(
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(UserInternalSshKeyEntity),
      dataSource.getRepository(SshProxyHostKeyEntity),
      keygen as never,
      crypto as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      dataSource,
    );

    const grant = {
      cpuMillis: 1000,
      memBytes: 2048,
      diskBytes: 1024,
      gpuMode: GpuGrantMode.None,
      gpuIndices: [],
    };
    const access = {
      resolveServer: vi.fn().mockResolvedValue(grant),
      resolveAllowedImages: vi.fn().mockResolvedValue(new Set(['image-a'])),
      resolveContainerCreateAccessInTransaction: vi.fn().mockResolvedValue({
        grant,
        mountSourcesAllowed: true,
      }),
    };
    const containerTasks = {
      createContainerTask: vi.fn(async (_manager: unknown, input: { payload: Record<string, unknown> }) => {
        capturedPayloads.push(input.payload);
        return { ok: true, taskId: `task-${capturedPayloads.length}`, status: 'pending' };
      }),
    };
    const stateCache = {
      getRuntimeBlockReason: vi.fn().mockReturnValue({ enabled: true }),
      isRuntimeReady: vi.fn().mockReturnValue(true),
      requireRuntimeReady: vi.fn().mockReturnValue({ dockerRoot: '/var/lib/docker' }),
      resolveImageDockerId: vi.fn().mockReturnValue('sha256:image-a'),
      get: vi.fn().mockReturnValue({ gpus: [] }),
      getAll: vi.fn().mockReturnValue([]),
    };
    audit = { log: vi.fn().mockResolvedValue(undefined) };
    control = new ContainerControlService(
      dataSource,
      access as never,
      {} as never,
      containerTasks as never,
      new ResourceKeyService(),
      dataSource.getRepository(ContainerEntity),
      dataSource.getRepository(ContainerDesiredSpecEntity),
      dataSource.getRepository(ContainerLifecycleEntity),
      {} as never,
      dataSource.getRepository(ImageEntity),
      dataSource.getRepository(ServerEntity),
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(GpuAllocationEntity),
      {} as never,
      {} as never,
      {} as never,
      { stateCache, isOnline: vi.fn().mockReturnValue(true) } as never,
      {} as never,
      { isAuthorizedForAdmission: vi.fn().mockResolvedValue(true) } as never,
      {} as never,
      identities,
      {} as never,
      audit as never,
    );
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('rolls back when rotation lands between the optimistic read and enqueue, then retries with the new key', async () => {
    const original = identities.getUserInternalPublicKey.bind(identities);
    let outerRead!: () => void;
    const outerReadDone = new Promise<void>((resolve) => { outerRead = resolve; });
    let releaseOuterRead!: () => void;
    const outerReadGate = new Promise<void>((resolve) => { releaseOuterRead = resolve; });
    vi.spyOn(identities, 'getUserInternalPublicKey').mockImplementationOnce(async (userId) => {
      const key = await original(userId);
      outerRead();
      await outerReadGate;
      return key;
    });

    const firstCreate = control.create('user-a', {
      serverId: 'server-a',
      imageId: 'image-a',
      name: 'work',
    });
    await outerReadDone;
    await identities.rotateUserKey('user-a', 'admin-a', async () => undefined);
    releaseOuterRead();

    await expect(firstCreate).rejects.toThrow(/rotated while creating/i);
    expect(capturedPayloads).toEqual([]);

    await expect(control.create('user-a', {
      serverId: 'server-a',
      imageId: 'image-a',
      name: 'work',
    })).resolves.toMatchObject({ taskId: 'task-1' });
    expect(capturedPayloads).toEqual([
      expect.objectContaining({
        ssh: {
          enabled: true,
          internalPublicKey: 'public-2',
          internalKeyGeneration: 2,
        },
      }),
    ]);
    expect(audit.log).toHaveBeenCalledOnce();
    expect(audit.log).toHaveBeenCalledWith(
      'user-a',
      AuditAction.CreateContainer,
      expect.any(String),
      'container',
      expect.objectContaining({ taskId: 'task-1', serverId: 'server-a', imageId: 'image-a' }),
    );
  });

  it.each([
    ServerStatus.AgentQuarantined,
    ServerStatus.Offline,
  ])('does not allocate an address while a shared-network peer is %s', async (status) => {
    await dataSource.getRepository(ServerEntity).save({
      id: 'server-b',
      name: 'Server B',
      slug: 'server-b',
      agentTokenHash: 'token-hash-b',
      hostFingerprint: 'host-b',
      agentConfigFingerprint: 'config-b',
      status,
      lastSeenAt: new Date(),
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanReservedIps: [],
    });

    await expect(control.create('user-a', {
      serverId: 'server-a',
      imageId: 'image-a',
      name: 'work',
    })).rejects.toMatchObject({ response: { code: 'NETWORK_INVENTORY_UNTRUSTED' } });
    expect(capturedPayloads).toEqual([]);
    expect(await dataSource.getRepository(NetworkAddressClaimEntity).count({
      where: { ownerKind: 'container' },
    })).toBe(0);
  });
});
