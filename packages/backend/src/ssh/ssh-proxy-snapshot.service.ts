import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
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
import {
  ContainerControlRepository,
  type ContainerSshRouteRecord,
} from '../containers/container-control.repository.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { SshIdentityService } from './ssh-identity.service.js';

@Injectable()
export class SshProxySnapshotService {
  private readonly logger = new Logger(SshProxySnapshotService.name);
  private generation = 0;

  constructor(
    private readonly transactions: PgTransactionManager,
    private readonly containers: ContainerControlRepository,
    private readonly identities: SshIdentityService,
    private readonly config: NyabaseConfigService,
    private readonly proxySnapshots: ProxySnapshotNotifierService = {
      isServerBlocked: () => false,
    } as unknown as ProxySnapshotNotifierService,
  ) {}

  /**
   * All usable routing/key state is read from one PostgreSQL snapshot. Initial
   * ssh-keygen remains outside the transaction; the persisted winning host key
   * is then sampled inside it.
   */
  async buildSnapshot(): Promise<SshProxySnapshot> {
    await this.identities.ensureProxyHostKey();
    return this.transactions.run(async (transaction) => {
      const clock = await sql<{ now: Date }>`
        select clock_timestamp() as now
      `.execute(transaction);
      const createdAtMs = new Date(clock.rows[0]!.now).getTime();
      const users = await transaction.selectFrom('iam.users')
        .select(['id', 'username', 'status'])
        .where('status', '=', UserStatus.Active)
        .execute();
      const userIds = users.map((user) => user.id);
      const routes = await this.containers.listRoutes({}, transaction);
      const routeIps = [...new Set(routes
        .map((route) => route.macvlanIp)
        .filter((ip): ip is string => Boolean(ip)))];
      const [
        publicKeys,
        internalKeys,
        servers,
        runtimeReadyServers,
        images,
        aggregateRows,
        addressClaims,
        remoteMounts,
        remoteAssignments,
        hostKey,
      ] = await Promise.all([
        userIds.length === 0
          ? Promise.resolve([])
          : transaction.selectFrom('iam.ssh_public_keys')
            .select(['user_id', 'key_text'])
            .where('user_id', 'in', userIds)
            .execute(),
        userIds.length === 0
          ? Promise.resolve([])
          : transaction.selectFrom('iam.user_internal_ssh_keys')
            .selectAll()
            .where('user_id', 'in', userIds)
            .execute(),
        transaction.selectFrom('infra.servers')
          .select(['id', 'slug', 'name', 'status', 'macvlan_cidr'])
          .execute(),
        transaction
          .selectFrom('workflow.agent_runtime_projections as projection')
          .innerJoin(
            'workflow.agent_sessions as session',
            'session.id',
            'projection.session_id',
          )
          .select('projection.server_id')
          .where('projection.runtime_ready', '=', true)
          .where('session.state', '=', 'ready')
          .where('session.lease_expires_at', '>', sql<Date>`clock_timestamp()`)
          .whereRef('session.generation', '=', 'projection.session_generation')
          .whereRef('session.gateway_id', '=', 'projection.gateway_id')
          .execute(),
        transaction.selectFrom('infra.images')
          .select(['id', 'disable_ssh'])
          .execute(),
        this.containers.list({}, transaction),
        this.containers.activeNetworkClaims(
          { addresses: routeIps },
          transaction,
        ),
        transaction.selectFrom('control.container_mounts')
          .select(['container_id', 'server_id', 'source_id'])
          .where('source_kind', '=', 'remote')
          .execute(),
        transaction.selectFrom('infra.remote_fs_server_assignments')
          .select(['server_id', 'remote_fs_mount_id', 'desired_state'])
          .execute(),
        this.identities.getProxyHostKey(transaction),
      ]);

      const publicKeysByUser = new Map<string, string[]>();
      for (const key of publicKeys) {
        const rows = publicKeysByUser.get(key.user_id) ?? [];
        rows.push(key.key_text);
        publicKeysByUser.set(key.user_id, rows);
      }
      const internalByUser = new Map(
        internalKeys.map((key) => [key.user_id, key]),
      );
      const serverById = new Map(servers.map((server) => [server.id, server]));
      const runtimeReadyServerIds = new Set(
        runtimeReadyServers.map((server) => server.server_id),
      );
      const imageById = new Map(images.map((image) => [image.id, image]));
      const containerById = new Map(
        aggregateRows.map((container) => [container.id, container]),
      );
      const claimsByAddress = new Map<string, typeof addressClaims>();
      for (const claim of addressClaims) {
        const claims = claimsByAddress.get(claim.address) ?? [];
        claims.push(claim);
        claimsByAddress.set(claim.address, claims);
      }
      const activeRemoteAssignments = new Set(remoteAssignments
        .filter((assignment) => assignment.desired_state === 'active')
        .map((assignment) =>
          `${assignment.server_id}|${assignment.remote_fs_mount_id}`));
      const unsafeRemoteConsumerIds = new Set(remoteMounts
        .filter((mount) => !activeRemoteAssignments.has(
          `${mount.server_id}|${mount.source_id}`,
        ))
        .map((mount) => mount.container_id));
      const staleAfterMs = this.config.get<number>(
        'ssh.proxySnapshotStaleMs',
      );
      const safeRoutes = routes.filter((route) => {
        const container = containerById.get(route.containerId);
        const server = container
          ? serverById.get(container.serverId)
          : undefined;
        const image = container
          ? imageById.get(container.imageId)
          : undefined;
        const desiredKey = container
          ? internalByUser.get(container.ownerId)
          : undefined;
        const claimsForAddress = route.macvlanIp
          ? claimsByAddress.get(route.macvlanIp) ?? []
          : [];
        const exactClaim = claimsForAddress.find((claim) =>
          claim.ownerKind === 'container'
          && claim.containerId === route.containerId
          && claim.serverId === route.serverId);
        const age = createdAtMs - route.observedAt.getTime();
        return Boolean(
          container
          && !unsafeRemoteConsumerIds.has(container.id)
          && container.lifecyclePhase === ContainerPhase.Active
          && container.activeTaskId === null
          && container.boundRuntimeId === route.runtimeId
          && container.powerIntent === ContainerPowerIntent.Running
          && route.serverId === container.serverId
          && server?.status === ServerStatus.Online
          && runtimeReadyServerIds.has(container.serverId)
          && Boolean(server.macvlan_cidr)
          && image?.disable_ssh === false
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
      }).map((route) => this.routeSnapshot(route));

      const userRows: SshProxySnapshot['users'] = [];
      for (const user of users) {
        const key = internalByUser.get(user.id);
        if (!key?.fingerprint) {
          this.logger.warn(
            `Omitting SSH proxy user ${user.id}: durable internal key is missing`,
          );
          continue;
        }
        try {
          userRows.push({
            id: user.id,
            username: user.username,
            status: user.status as UserStatus,
            publicKeys: publicKeysByUser.get(user.id) ?? [],
            internalPrivateKey: this.identities.decryptUserPrivateKey(key),
            internalPublicKey: key.public_key,
            internalKeyFingerprint: key.fingerprint,
            internalKeyGeneration: key.generation,
          });
        } catch (error) {
          this.logger.warn(
            `Omitting SSH proxy user ${user.id}: internal key decrypt failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
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
          disableSsh: image.disable_ssh,
        })),
        containers: aggregateRows.map((container) => ({
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
    }, { isolationLevel: 'repeatable read' });
  }

  endpoint(): SshProxyEndpoint | null {
    const host = this.config.get<string>('ssh.proxyPublicHost')?.trim();
    const port = this.config.get<number>('ssh.proxyPublicPort');
    return host && port ? { host, port } : null;
  }

  private routeSnapshot(
    route: ContainerSshRouteRecord,
  ): SshProxyRuntimeRouteSnapshot {
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
    return typeof value === 'string'
      && /^SHA256:[A-Za-z0-9+/]{43}$/u.test(value);
  }
}
