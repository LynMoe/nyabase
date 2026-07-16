import { DataSource, EntityManager } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  ServerStatus,
  SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
  UserStatus,
} from '@nyabase/common';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { SshProxySnapshotService } from './ssh-proxy-snapshot.service.js';

const HOST_FINGERPRINT = 'SHA256:UCUiLr7Pjs9wFFJMDByLgc3NrtdU344OgUM45wZPcIQ';

describe('SshProxySnapshotService consistency fence', () => {
  let dataSource: DataSource;
  let service: SshProxySnapshotService;
  let staleAfterMs: number;

  beforeEach(async () => {
    staleAfterMs = 300_000;
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        UserEntity,
        SshPublicKeyEntity,
        UserInternalSshKeyEntity,
        ServerEntity,
        ImageEntity,
        ContainerEntity,
        ContainerDesiredSpecEntity,
        ContainerLifecycleEntity,
        ContainerSshRouteEntity,
        NetworkAddressClaimEntity,
        ContainerMountEntity,
        RemoteFsServerAssignmentEntity,
        RemoteFsMountEntity,
      ],
    });
    await dataSource.initialize();
    const identities = {
      ensureProxyHostKeyInTransaction: vi.fn(async () => ({
        id: 'singleton',
        privateKey: 'host-private',
        encryptedPrivateKey: 'host-private',
        publicKey: 'host-public',
        fingerprint: HOST_FINGERPRINT,
        generation: 1,
        rotatedAt: new Date(),
      })),
      decryptUserPrivateKey: vi.fn((key: UserInternalSshKeyEntity) => key.encryptedPrivateKey),
    };
    const config = {
      get: vi.fn((key: string) => {
        if (key === 'ssh.proxySnapshotStaleMs') return staleAfterMs;
        if (key === 'ssh.proxyPublicHost') return 'ssh.example.test';
        if (key === 'ssh.proxyPublicPort') return 2222;
        return undefined;
      }),
    };
    service = new SshProxySnapshotService(dataSource, identities as never, config as never);

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
      encryptedPrivateKey: 'private-1',
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
      imageRef: 'image:a',
      imageDefaultUid: 0,
      imageRuntimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      cpuMillis: 1000,
      memBytes: 1024,
      diskBytes: 1024,
      gpuMode: 'none',
      gpuIndices: [],
      mountsJson: [],
      powerIntent: ContainerPowerIntent.Running,
    });
    await dataSource.getRepository(ContainerLifecycleEntity).save({
      containerId: 'container-a',
      phase: ContainerPhase.Active,
      boundRuntimeId: 'runtime-a',
      quotaPathsJson: [],
      activeTaskId: null,
      lastTransitionAt: new Date(),
      failureReason: null,
      failureCode: null,
    });
    await dataSource.getRepository(ContainerSshRouteEntity).save({
      containerId: 'container-a',
      serverId: 'server-a',
      runtimeId: 'runtime-a',
      macvlanIp: '10.0.0.2',
      runtimeStatus: ContainerStatus.Running,
      sshStatus: 'running',
      appliedInternalKeyGeneration: 1,
      containerHostKeyFingerprint: HOST_FINGERPRINT,
      lastError: null,
      observedAt: new Date(),
    });
    await dataSource.getRepository(NetworkAddressClaimEntity).save({
      id: 'claim-a',
      address: '10.0.0.2',
      networkKey: '10.0.0.0/24',
      ownerKind: 'container',
      ownerId: 'container-a',
      serverId: 'server-a',
      state: 'active',
      cleanupPayloadJson: null,
      reusableAt: null,
    });
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('publishes a route only for the current desired key generation and a valid host fingerprint', async () => {
    await dataSource.getRepository(UserInternalSshKeyEntity).update('user-a', {
      generation: 2,
      publicKey: 'public-2',
      fingerprint: 'fingerprint-2',
    });
    expect((await service.buildSnapshot()).routes).toEqual([]);

    await dataSource.getRepository(ContainerSshRouteEntity).update('container-a', {
      appliedInternalKeyGeneration: 2,
      containerHostKeyFingerprint: null,
      observedAt: new Date(),
    });
    expect((await service.buildSnapshot()).routes).toEqual([]);

    await dataSource.getRepository(ContainerSshRouteEntity).update('container-a', {
      containerHostKeyFingerprint: HOST_FINGERPRINT,
      observedAt: new Date(),
    });
    expect((await service.buildSnapshot()).routes).toEqual([
      expect.objectContaining({
        containerId: 'container-a',
        appliedInternalKeyGeneration: 2,
        containerHostKeyFingerprint: HOST_FINGERPRINT,
      }),
    ]);
  });

  it('keeps a healthy 15-second Agent route fresh at the minimum supported lease', async () => {
    staleAfterMs = SSH_PROXY_SNAPSHOT_STALE_MIN_MS;
    await dataSource.getRepository(ContainerSshRouteEntity).update('container-a', {
      observedAt: new Date(Date.now() - 15_001),
    });
    expect((await service.buildSnapshot()).routes).toHaveLength(1);

    await dataSource.getRepository(ContainerSshRouteEntity).update('container-a', {
      observedAt: new Date(Date.now() - SSH_PROXY_SNAPSHOT_STALE_MIN_MS - 1),
    });
    expect((await service.buildSnapshot()).routes).toEqual([]);
  });

  it('cannot observe a mixed key/route generation during a report or rotation transaction', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstWrite!: () => void;
    const firstWriteDone = new Promise<void>((resolve) => { firstWrite = resolve; });
    const writer = runSerializedTransaction(dataSource, async (manager) => {
      await manager.update(UserInternalSshKeyEntity, 'user-a', {
        generation: 2,
        publicKey: 'public-2',
        fingerprint: 'fingerprint-2',
      });
      firstWrite();
      await gate;
      await manager.update(ContainerSshRouteEntity, 'container-a', {
        appliedInternalKeyGeneration: 2,
        observedAt: new Date(),
      });
    });
    await firstWriteDone;

    let settled = false;
    const snapshotPromise = service.buildSnapshot().then((snapshot) => {
      settled = true;
      return snapshot;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await writer;
    const snapshot = await snapshotPromise;
    expect(snapshot.users).toEqual([
      expect.objectContaining({ id: 'user-a', internalKeyGeneration: 2 }),
    ]);
    expect(snapshot.routes).toEqual([
      expect.objectContaining({ containerId: 'container-a', appliedInternalKeyGeneration: 2 }),
    ]);
  });

  it('does not load unbounded deleted-user key history into a snapshot transaction', async () => {
    await dataSource.getRepository(UserEntity).save({
      id: 'user-deleted',
      numericId: 1002,
      username: 'deleted',
      passwordHash: 'hash',
      displayName: 'Deleted',
      status: UserStatus.Deleted,
    });
    await dataSource.getRepository(UserInternalSshKeyEntity).save({
      userId: 'user-deleted',
      encryptedPrivateKey: 'deleted-private',
      publicKey: 'deleted-public',
      fingerprint: 'deleted-fingerprint',
      generation: 1,
      rotatedAt: new Date(),
    });
    await dataSource.getRepository(SshPublicKeyEntity).save({
      id: 'deleted-public-key',
      userId: 'user-deleted',
      name: 'deleted',
      keyText: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogusButBounded deleted',
      createdAt: new Date(),
    });
    const find = vi.spyOn(EntityManager.prototype, 'find');

    const snapshot = await service.buildSnapshot();

    expect(snapshot.users.map((user) => user.id)).toEqual(['user-a']);
    expect(find).toHaveBeenCalledWith(UserEntity, { where: { status: UserStatus.Active } });
    expect(find).toHaveBeenCalledWith(
      SshPublicKeyEntity,
      expect.objectContaining({ where: { userId: expect.anything() } }),
    );
    expect(find).toHaveBeenCalledWith(
      UserInternalSshKeyEntity,
      expect.objectContaining({ where: { userId: expect.anything() } }),
    );
    expect(find).toHaveBeenCalledWith(NetworkAddressClaimEntity, {
      where: { state: 'active', address: expect.anything() },
    });
  });
});
