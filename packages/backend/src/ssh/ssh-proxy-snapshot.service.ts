import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  ServerStatus,
  UserStatus,
  MAX_SSH_PROXY_SNAPSHOT_BYTES,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  zSshProxySnapshot,
  type SshProxyEndpoint,
  type SshProxyInstanceRouteSnapshot,
  type SshProxySnapshot,
} from '@nyabase/common';
import {
  ContainerControlRepository,
  type ContainerSshRouteRecord,
} from '../containers/container-control.repository.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { loadUsableServerAccessKeys } from '../access/usable-server-access.js';
import { SshIdentityService } from './ssh-identity.service.js';

function normalizeRouteRuntimeStatus(value: string | null | undefined): ContainerStatus {
  const normalized = value?.toLowerCase();
  if (normalized === 'running') return ContainerStatus.Running;
  if (normalized === 'stopped') return ContainerStatus.Stopped;
  if (normalized === 'frozen') return ContainerStatus.Frozen;
  if (normalized === 'error') return ContainerStatus.Error;
  return ContainerStatus.Unknown;
}

@Injectable()
export class SshProxySnapshotService {
  private generation = 0;

  constructor(
    private readonly transactions: PgTransactionManager,
    private readonly containers: ContainerControlRepository,
    private readonly identities: SshIdentityService,
    private readonly config: NyabaseConfigService,
  ) {}

  async buildSnapshot(): Promise<SshProxySnapshot> {
    const hostKey = await this.identities.ensureProxyHostKey();
    return this.transactions.run(async (transaction) => {
      const clock = await sql<{ now: Date }>`
        select clock_timestamp() as now
      `.execute(transaction);
      const now = new Date(clock.rows[0]!.now);
      const users = await transaction.selectFrom('iam.users')
        .select(['id', 'username', 'status'])
        .where('status', '=', UserStatus.Active)
        .execute();
      const userIds = users.map((user) => user.id);
      const [publicKeys, servers, images, containers, routes, access] =
        await Promise.all([
          userIds.length === 0
            ? Promise.resolve([])
            : transaction.selectFrom('iam.ssh_public_keys')
              .select(['user_id', 'key_text'])
              .where('user_id', 'in', userIds)
              .execute(),
          transaction.selectFrom('infra.servers')
            .select(['id', 'slug', 'name', 'status', 'parent_interface'])
            .execute(),
          transaction.selectFrom('infra.images')
            .select(['id'])
            .execute(),
          this.containers.list({}, transaction),
          this.containers.listRoutes({}, transaction),
          loadUsableServerAccessKeys(transaction),
        ]);
      const publicKeysByUser = new Map<string, string[]>();
      for (const key of publicKeys) {
        const list = publicKeysByUser.get(key.user_id) ?? [];
        list.push(key.key_text);
        publicKeysByUser.set(key.user_id, list);
      }
      const serverById = new Map(servers.map((server) => [server.id, server]));
      const imageIds = new Set(images.map((image) => image.id));
      const claims = await this.containers.activeNetworkClaims(
        {
          addresses: routes
            .map((route) => route.routedIp)
            .filter((ip): ip is string => Boolean(ip)),
        },
        transaction,
      );
      const claimByAddress = new Map(claims.map((claim) => [claim.address, claim]));
      const staleAfterMs = this.config.get<number>('ssh.proxySnapshotStaleMs');
      const visibleContainers = containers.filter((container) =>
        container.instance_name
        && access.has(`${container.owner_id}\0${container.server_id}`));
      const safeRoutes = routes.filter((route) => {
        const container = visibleContainers.find((row) => row.id === route.containerId);
        const server = container ? serverById.get(container.server_id) : undefined;
        const claim = route.routedIp ? claimByAddress.get(route.routedIp) : undefined;
        const age = now.getTime() - route.observedAt.getTime();
        const runtimeStatus = normalizeRouteRuntimeStatus(route.runtimeStatus);
        return Boolean(
          container
          && container.lifecycle_phase === ContainerPhase.Active
          && container.power_intent === ContainerPowerIntent.Running
          && route.instanceName === container.instance_name
          && runtimeStatus === ContainerStatus.Running
          && route.serverId === container.server_id
          && server?.status === ServerStatus.Online
          && server.parent_interface
          && imageIds.has(container.image_id)
          && route.sshStatus === 'running'
          && route.routedIp
          && claim?.ownerKind === 'container'
          && claim.containerId === container.id
          // Reject only clearly future observations; do not tie route visibility to
          // the proxy snapshot lease window (routes refresh on reconciler notify).
          && age >= -PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS
        );
      }).map((route) => this.routeSnapshot(
        route,
        normalizeRouteRuntimeStatus(route.runtimeStatus),
      ));
      const userRows: SshProxySnapshot['users'] = users.map((user) => ({
        id: user.id,
        username: user.username,
        status: user.status as UserStatus,
        publicKeys: publicKeysByUser.get(user.id) ?? [],
      }));
      const nextGeneration = this.generation + 1;
      const snapshot = zSshProxySnapshot.parse({
        generation: nextGeneration,
        createdAt: now.toISOString(),
        staleAfterMs,
        validUntil: now.getTime() + staleAfterMs,
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
          status: server.status as ServerStatus,
        })),
        images: images.map((image) => ({ id: image.id, sshEnabled: true })),
        containers: visibleContainers.flatMap((container) => container.instance_name
          ? [{
              id: container.id,
              ownerId: container.owner_id,
              serverId: container.server_id,
              imageId: container.image_id,
              name: container.name,
              instanceName: container.instance_name,
            }]
          : []),
        routes: safeRoutes,
      });
      const encodedBytes = Buffer.byteLength(JSON.stringify({
        ts: Number.MAX_SAFE_INTEGER,
        kind: 'snapshot',
        payload: snapshot,
      }));
      if (encodedBytes > MAX_SSH_PROXY_SNAPSHOT_BYTES) {
        throw new Error(`SSH proxy snapshot exceeds ${MAX_SSH_PROXY_SNAPSHOT_BYTES} bytes`);
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
    status: ContainerStatus,
  ): SshProxyInstanceRouteSnapshot {
    return {
      containerId: route.containerId,
      serverId: route.serverId,
      instanceName: route.instanceName,
      routedIp: route.routedIp || null,
      status,
      sshStatus: route.sshStatus,
      observedAt: route.observedAt.toISOString(),
    };
  }
}
