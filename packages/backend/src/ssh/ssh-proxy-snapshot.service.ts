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
  type SshProxySnapshotSummaryDto,
} from '@nyabase/common';
import {
  ContainerControlRepository,
  type ContainerSshRouteRecord,
} from '../containers/container-control.repository.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { loadServerAccessKeys } from '../iam/effective-access.js';
import { SshIdentityService } from './ssh-identity.service.js';

function normalizeRouteRuntimeStatus(value: string | null | undefined): ContainerStatus {
  const normalized = value?.toLowerCase();
  if (normalized === 'running') return ContainerStatus.Running;
  if (normalized === 'stopped') return ContainerStatus.Stopped;
  if (normalized === 'frozen') return ContainerStatus.Frozen;
  if (normalized === 'error') return ContainerStatus.Error;
  return ContainerStatus.Unknown;
}

function groupKeysByUser(rows: readonly { user_id: string; key_text: string }[]): Map<string, string[]> {
  const byUser = new Map<string, string[]>();
  for (const row of rows) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row.key_text]);
  return byUser;
}

const EMPTY_SUMMARY: SshProxySnapshotSummaryDto = {
  generation: 0,
  builtAt: null,
  bytes: 0,
  maxBytes: MAX_SSH_PROXY_SNAPSHOT_BYTES,
  users: 0,
  routes: 0,
  failedAt: null,
  error: null,
};

@Injectable()
export class SshProxySnapshotService {
  private generation = 0;
  private summary: SshProxySnapshotSummaryDto | null = null;

  constructor(
    private readonly transactions: PgTransactionManager,
    private readonly containers: ContainerControlRepository,
    private readonly identities: SshIdentityService,
    private readonly config: NyabaseConfigService,
  ) {}

  /** The last build's size and counts, or why it failed, for the admin status page. */
  lastSummary(): SshProxySnapshotSummaryDto | null {
    return this.summary;
  }

  async buildSnapshot(): Promise<SshProxySnapshot> {
    try {
      return await this.build();
    } catch (error) {
      this.summary = {
        ...(this.summary ?? EMPTY_SUMMARY),
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  private async build(): Promise<SshProxySnapshot> {
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
          loadServerAccessKeys(transaction),
        ]);
      const publicKeysByUser = groupKeysByUser(publicKeys);
      const serverById = new Map(servers.map((server) => [server.id, server]));
      const imageIds = new Set(images.map((image) => image.id));
      const claims = await this.containers.activeNetworkClaims({
        addresses: routes.map((route) => route.routedIp).filter((ip): ip is string => Boolean(ip)),
      }, transaction);
      const claimByAddress = new Map(claims.map((claim) => [claim.address, claim]));
      const staleAfterMs = this.config.get<number>('ssh.proxySnapshotStaleMs');
      const visibleContainers = new Map(containers
        .filter((container) => container.instance_name
          && access.has(`${container.owner_id}\0${container.server_id}`))
        .map((container) => [container.id, container]));
      const safeRoutes = routes.filter((route) => {
        const container = visibleContainers.get(route.containerId);
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
      });
      // Only what a routable login can use: the proxy refuses every other key
      // and target anyway, and leaving the rest out keeps the snapshot far from
      // its size cap as users and stopped containers accumulate.
      const routedContainers = safeRoutes.map((route) => visibleContainers.get(route.containerId)!);
      const routedOwners = new Set(routedContainers.map((container) => container.owner_id));
      const routedServers = new Set(routedContainers.map((container) => container.server_id));
      const routedImages = new Set(routedContainers.map((container) => container.image_id));
      const userRows: SshProxySnapshot['users'] = users
        .filter((user) => routedOwners.has(user.id))
        .map((user) => ({
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
        hostSuffix: this.hostSuffix(),
        users: userRows,
        servers: servers.filter((server) => routedServers.has(server.id)).map((server) => ({
          id: server.id,
          slug: server.slug,
          name: server.name,
          status: server.status as ServerStatus,
        })),
        images: images
          .filter((image) => routedImages.has(image.id))
          .map((image) => ({ id: image.id, sshEnabled: true })),
        containers: routedContainers.map((container) => ({
          id: container.id,
          ownerId: container.owner_id,
          serverId: container.server_id,
          imageId: container.image_id,
          name: container.name,
          instanceName: container.instance_name!,
        })),
        routes: safeRoutes.map((route) => this.routeSnapshot(
          route,
          normalizeRouteRuntimeStatus(route.runtimeStatus),
        )),
      });
      const encodedBytes = Buffer.byteLength(JSON.stringify({
        ts: Number.MAX_SAFE_INTEGER,
        kind: 'snapshot',
        payload: snapshot,
      }));
      if (encodedBytes > MAX_SSH_PROXY_SNAPSHOT_BYTES) {
        throw new Error(
          `SSH proxy snapshot is ${encodedBytes} bytes, over the ${MAX_SSH_PROXY_SNAPSHOT_BYTES} byte limit`,
        );
      }
      this.generation = nextGeneration;
      this.summary = {
        generation: nextGeneration,
        builtAt: now.toISOString(),
        bytes: encodedBytes,
        maxBytes: MAX_SSH_PROXY_SNAPSHOT_BYTES,
        users: snapshot.users.length,
        routes: snapshot.routes.length,
        failedAt: null,
        error: null,
      };
      return snapshot;
    }, { isolationLevel: 'repeatable read' });
  }

  /** The DNS suffix of container hostnames (`work.<suffix>`), lower-cased. */
  hostSuffix(): string {
    return this.config.get<string>('ssh.proxyHostSuffix').trim().toLowerCase();
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
