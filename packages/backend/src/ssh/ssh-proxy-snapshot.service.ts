import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import {
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  ServerStatus,
  UserStatus,
  MAX_SSH_PROXY_SNAPSHOT_BYTES,
  zSshProxySnapshot,
  type SshProxyEndpoint,
  type SshProxyRuntimeRouteSnapshot,
  type SshProxySnapshot,
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
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';

@Injectable()
export class SshProxySnapshotService {
  private readonly logger = new Logger(SshProxySnapshotService.name);
  private generation = 0;

  constructor(
    private dataSource: DataSource,
    private identities: SshIdentityService,
    private config: NyabaseConfigService,
    private proxySnapshots: ProxySnapshotNotifierService = {
      isServerBlocked: () => false,
    } as unknown as ProxySnapshotNotifierService,
  ) {}

  /**
   * Read every table under one database-coordinator lease. A proxy snapshot is
   * either wholly before or wholly after a key rotation/report transaction;
   * it can never combine a new desired key with an old route as a usable row.
   */
  async buildSnapshot(): Promise<SshProxySnapshot> {
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const users = await manager.find(UserEntity, {
        where: { status: UserStatus.Active },
      });
      const activeUserIds = users.map((user) => user.id);
      const routes = await manager.find(ContainerSshRouteEntity);
      const routeIps = [...new Set(routes
        .map((route) => route.macvlanIp)
        .filter((ip): ip is string => Boolean(ip)))];
      const [
        publicKeys,
        internalKeys,
        servers,
        images,
        containers,
        lifecycles,
        desiredSpecs,
        addressClaims,
        containerMounts,
        remoteAssignments,
        hostKey,
      ] = await Promise.all([
        activeUserIds.length === 0
          ? Promise.resolve([])
          : manager.find(SshPublicKeyEntity, { where: { userId: In(activeUserIds) } }),
        activeUserIds.length === 0
          ? Promise.resolve([])
          : manager.find(UserInternalSshKeyEntity, { where: { userId: In(activeUserIds) } }),
        manager.find(ServerEntity),
        manager.find(ImageEntity),
        manager.find(ContainerEntity),
        manager.find(ContainerLifecycleEntity),
        manager.find(ContainerDesiredSpecEntity),
        routeIps.length === 0
          ? Promise.resolve([])
          : manager.find(NetworkAddressClaimEntity, {
            where: { state: 'active', address: In(routeIps) },
          }),
        manager.find(ContainerMountEntity, { where: { sourceKind: 'remote' } }),
        manager.find(RemoteFsServerAssignmentEntity),
        this.identities.ensureProxyHostKeyInTransaction(manager),
      ]);

      const publicKeysByUser = new Map<string, string[]>();
      for (const key of publicKeys) {
        const list = publicKeysByUser.get(key.userId) ?? [];
        list.push(key.keyText);
        publicKeysByUser.set(key.userId, list);
      }
      const internalByUser = new Map(internalKeys.map((key) => [key.userId, key]));
      const serverById = new Map(servers.map((server) => [server.id, server]));
      const imageById = new Map(images.map((image) => [image.id, image]));
      const containerById = new Map(containers.map((container) => [container.id, container]));
      const lifecycleByContainerId = new Map(lifecycles.map((row) => [row.containerId, row]));
      const desiredByContainerId = new Map(desiredSpecs.map((row) => [row.containerId, row]));
      const claimsByAddress = new Map<string, NetworkAddressClaimEntity[]>();
      for (const claim of addressClaims) {
        const claims = claimsByAddress.get(claim.address) ?? [];
        claims.push(claim);
        claimsByAddress.set(claim.address, claims);
      }
      const activeRemoteAssignments = new Set(remoteAssignments
        .filter((assignment) => assignment.desiredState === 'active')
        .map((assignment) => `${assignment.serverId}|${assignment.remoteFsMountId}`));
      const unsafeRemoteConsumerIds = new Set(containerMounts
        .filter((mount) => !activeRemoteAssignments.has(`${mount.serverId}|${mount.sourceId}`))
        .map((mount) => mount.containerId));
      const staleAfterMs = this.config.get<number>('ssh.proxySnapshotStaleMs');
      const createdAtMs = Date.now();

      const safeRoutes = routes
        .filter((route) => {
          const container = containerById.get(route.containerId);
          const lifecycle = lifecycleByContainerId.get(route.containerId);
          const desired = desiredByContainerId.get(route.containerId);
          const server = container ? serverById.get(container.serverId) : undefined;
          const image = container ? imageById.get(container.imageId) : undefined;
          const desiredKey = container ? internalByUser.get(container.ownerId) : undefined;
          const age = createdAtMs - route.observedAt.getTime();
          const claimsForAddress = route.macvlanIp
            ? claimsByAddress.get(route.macvlanIp) ?? []
            : [];
          const exactClaim = claimsForAddress.find((claim) =>
            claim.ownerKind === 'container'
            && claim.ownerId === route.containerId
            && claim.serverId === route.serverId);
          return Boolean(
            container
            && !unsafeRemoteConsumerIds.has(container.id)
            && lifecycle?.phase === ContainerPhase.Active
            && lifecycle.activeTaskId === null
            && lifecycle.boundRuntimeId === route.runtimeId
            && desired?.powerIntent === ContainerPowerIntent.Running
            && route.serverId === container.serverId
            && server?.status === ServerStatus.Online
            && !this.proxySnapshots.isServerBlocked(container.serverId)
            && Boolean(server.macvlanCidr)
            && image?.disableSsh === false
            && desiredKey?.fingerprint
            && route.appliedInternalKeyGeneration === desiredKey.generation
            && route.runtimeStatus === ContainerStatus.Running
            && route.sshStatus === 'running'
            && Boolean(route.macvlanIp)
            && claimsForAddress.length === 1
            && exactClaim
            && this.hasHostFingerprint(route.containerHostKeyFingerprint)
            && age >= 0
            && age <= staleAfterMs,
          );
        })
        .map((route) => this.routeSnapshot(route));

      const userRows: SshProxySnapshot['users'] = [];
      for (const user of users) {
        const key = internalByUser.get(user.id);
        if (!key?.fingerprint) {
          this.logger.warn(`Omitting SSH proxy user ${user.id}: durable internal key is missing`);
          continue;
        }
        try {
          userRows.push({
            id: user.id,
            username: user.username,
            status: user.status,
            publicKeys: publicKeysByUser.get(user.id) ?? [],
            internalPrivateKey: this.identities.decryptUserPrivateKey(key),
            internalPublicKey: key.publicKey,
            internalKeyFingerprint: key.fingerprint,
            internalKeyGeneration: key.generation,
          });
        } catch (error) {
          this.logger.warn(
            `Omitting SSH proxy user ${user.id}: internal key decrypt failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const nextGeneration = this.generation + 1;
      const snapshot = zSshProxySnapshot.parse({
        generation: nextGeneration,
        createdAt: new Date(createdAtMs).toISOString(),
        staleAfterMs,
        validUntil: createdAtMs + staleAfterMs,
        endpoint: this.endpoint(),
        hostKey: {
          privateKey: hostKey.privateKey,
          publicKey: hostKey.publicKey,
          fingerprint: hostKey.fingerprint,
          generation: hostKey.generation,
        },
        users: userRows,
        servers: servers.map((server) => ({
          id: server.id,
          slug: server.slug,
          name: server.name,
          online: server.status === ServerStatus.Online,
        })),
        images: images.map((image) => ({
          id: image.id,
          disableSsh: image.disableSsh,
        })),
        containers: containers.map((container) => ({
          id: container.id,
          ownerId: container.ownerId,
          serverId: container.serverId,
          imageId: container.imageId,
          name: container.name,
        })),
        routes: safeRoutes,
      });
      const encodedBytes = Buffer.byteLength(JSON.stringify({
        ts: Number.MAX_SAFE_INTEGER,
        kind: 'snapshot',
        payload: snapshot,
      }));
      if (encodedBytes > MAX_SSH_PROXY_SNAPSHOT_BYTES) {
        throw new Error(
          `SSH proxy snapshot is ${encodedBytes} bytes; maximum is ${MAX_SSH_PROXY_SNAPSHOT_BYTES}`,
        );
      }
      this.generation = nextGeneration;
      return snapshot;
    });
  }

  endpoint(): SshProxyEndpoint | null {
    const host = this.config.get<string>('ssh.proxyPublicHost')?.trim();
    const port = this.config.get<number>('ssh.proxyPublicPort');
    return host && port ? { host, port } : null;
  }

  private routeSnapshot(route: ContainerSshRouteEntity): SshProxyRuntimeRouteSnapshot {
    return {
      containerId: route.containerId,
      serverId: route.serverId,
      runtimeId: route.runtimeId,
      macvlanIp: route.macvlanIp,
      runtimeStatus: route.runtimeStatus,
      sshStatus: route.sshStatus,
      appliedInternalKeyGeneration: route.appliedInternalKeyGeneration,
      containerHostKeyFingerprint: route.containerHostKeyFingerprint,
      observedAt: route.observedAt.toISOString(),
    };
  }

  private hasHostFingerprint(value: string | null): boolean {
    return typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value);
  }
}
