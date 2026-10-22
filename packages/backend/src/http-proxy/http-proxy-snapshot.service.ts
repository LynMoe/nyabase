import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { sql, type Transaction } from 'kysely';
import {
  ContainerStatus,
  HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
  MAX_HTTP_PROXY_SNAPSHOT_BYTES,
  UserStatus,
  hostnameMatchesHttpProxyWildcard,
  zHttpProxySnapshot,
  type HttpProxySnapshot,
} from '@nyabase/common';
import { loadServerAccessKeys } from '../iam/effective-access.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { decryptPrivateKey, poolHasSafeTlsLease } from './http-proxy-certificates.js';
import {
  routeMatchesContainer,
  runSerializable,
  type HttpExecutor,
} from './http-proxy-state.js';

type Tx = Transaction<NyabaseDatabase>;

async function databaseNow(executor: HttpExecutor): Promise<Date> {
  const result = await sql<{ now: Date }>`
    select clock_timestamp() as now
  `.execute(executor);
  return result.rows[0]!.now;
}

/**
 * Deliberately independent of the server's agent status: the proxy dials the
 * container's routed IP directly, so an agent restart or a Backend restart
 * (which marks every server unreachable until its agent dials back) must not
 * take sites down. A truly dead host just answers 503 at connect time.
 */
function serverCanProxy(server: { parent_interface: string | null }): boolean {
  return Boolean(server.parent_interface);
}

function safeGeneration(value: string | number | bigint): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('HTTP proxy snapshot generation exceeds the safe application range');
  }
  return generation;
}

/** Everything one snapshot is derived from, read inside a single transaction. */
async function loadSnapshotInputs(transaction: Tx) {
  const [
    bindings,
    pools,
    containers,
    routes,
    users,
    servers,
    addressClaims,
    usableAccess,
  ] = await Promise.all([
    transaction.selectFrom('interaction.http_proxy_bindings').selectAll().execute(),
    transaction.selectFrom('interaction.http_domain_pools').selectAll().execute(),
    transaction.selectFrom('control.containers').selectAll().execute(),
    transaction.selectFrom('control.container_ssh_routes').selectAll().execute(),
    transaction.selectFrom('iam.users')
      .select(['id', 'status'])
      .where('status', '=', UserStatus.Active)
      .execute(),
    transaction.selectFrom('infra.servers').selectAll().execute(),
    transaction.selectFrom('control.container_network_claims')
      .selectAll()
      .where('state', '=', 'active')
      .execute(),
    loadServerAccessKeys(transaction),
  ]);
  return { bindings, pools, containers, routes, users, servers, addressClaims, usableAccess };
}

export type SnapshotInputs = Awaited<ReturnType<typeof loadSnapshotInputs>>;

/**
 * The bindings that can be served right now: enabled pool, active owner with
 * current server access, a container wanted running whose last observation was
 * running, a route whose address is claimed by exactly this container, and a
 * hostname the pool actually covers.
 *
 * Tenant isolation rests on the address claim, not on how fresh the
 * observation is: a container's address stays an active claim until the
 * reconciler has seen the instance deleted, and is then quarantined for
 * longer than any snapshot lease before reuse. So a route kept through an
 * agent outage can reach this container or nothing — never another tenant.
 * Stopping, deleting, releasing the claim or removing the binding still drops
 * the route on the next snapshot.
 */
export function routableBindings(inputs: SnapshotInputs) {
  const { bindings, pools, containers, routes, users, servers, addressClaims, usableAccess } = inputs;
  const poolsById = new Map(pools.map((row) => [row.id, row]));
  const containersById = new Map(
    containers
      .filter((row) => usableAccess.has(`${row.owner_id}\0${row.server_id}`))
      .map((row) => [row.id, row]),
  );
  const claimsByAddress = new Map<string, typeof addressClaims>();
  for (const claim of addressClaims) {
    const claims = claimsByAddress.get(claim.address) ?? [];
    claims.push(claim);
    claimsByAddress.set(claim.address, claims);
  }
  const onlineServerIds = new Set(
    servers.filter((server) => serverCanProxy(server)).map((server) => server.id),
  );
  const activeUserIds = new Set(users.map((user) => user.id));
  const routesByContainerId = new Map(
    routes
      .filter((route) => {
        const container = containersById.get(route.container_id);
        return container && routeMatchesContainer(route, container);
      })
      .map((route) => [route.container_id, route]),
  );
  return bindings.flatMap((binding) => {
    const pool = poolsById.get(binding.domain_pool_id);
    const container = containersById.get(binding.container_id);
    const route = routesByContainerId.get(binding.container_id);
    if (
      !pool?.enabled
      || !container
      || !route
      || !activeUserIds.has(binding.owner_id)
      || !onlineServerIds.has(container.server_id)
    ) return [];
    if (container.owner_id !== binding.owner_id) return [];
    if (route.server_id !== container.server_id) return [];
    if (!hostnameMatchesHttpProxyWildcard(binding.hostname, pool.wildcard_domain)) return [];
    if (pool.https_enabled && (!pool.certificate_pem || !pool.encrypted_private_key_pem)) return [];
    if (!route.routed_ip || route.instance_status !== ContainerStatus.Running) {
      return [];
    }
    const claimsForAddress = claimsByAddress.get(route.routed_ip) ?? [];
    const exactClaim = claimsForAddress.find((claim) =>
      claim.owner_kind === 'container'
      && claim.owner_id === container.id
      && claim.server_id === container.server_id);
    if (claimsForAddress.length !== 1 || !exactClaim) return [];
    return [{
      bindingId: binding.id,
      hostname: binding.hostname,
      domainPoolId: pool.id,
      routedIp: route.routed_ip,
      targetPort: binding.target_port,
      ownerId: binding.owner_id,
      containerId: container.id,
      containerName: container.name,
      instanceName: route.instance_name,
      status: route.instance_status as ContainerStatus,
    }];
  });
}

/** Builds the versioned routing snapshot the HTTP proxy process consumes. */
@Injectable()
export class HttpProxySnapshotService {
  constructor(
    private readonly transactions: PgTransactionManager,
    private readonly config: NyabaseConfigService,
  ) {}

  buildSnapshot(): Promise<HttpProxySnapshot> {
    return runSerializable(this.transactions, async (transaction) => {
      const state = await transaction
        .selectFrom('interaction.http_proxy_snapshot_state')
        .selectAll()
        .where('singleton', '=', true)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const now = await databaseNow(transaction);
      const inputs = await loadSnapshotInputs(transaction);
      const createdAtMs = now.getTime();
      const nextGeneration = safeGeneration(state.generation) + 1;
      const snapshot = zHttpProxySnapshot.parse({
        generation: nextGeneration,
        createdAt: now.toISOString(),
        staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        validUntil: createdAtMs + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        routes: routableBindings(inputs),
        domainPools: inputs.pools
          .filter((pool) =>
            pool.enabled
            && pool.https_enabled
            && poolHasSafeTlsLease(pool, createdAtMs))
          .map((pool) => ({
            id: pool.id,
            wildcardDomain: pool.wildcard_domain,
            enabled: pool.enabled,
            httpsEnabled: pool.https_enabled,
            certificatePem: pool.certificate_pem,
            privateKeyPem: decryptPrivateKey(this.config.keyEncryptionSecret(), pool.encrypted_private_key_pem!),
            certificateFingerprint: pool.certificate_fingerprint,
            certificateNotAfter: pool.certificate_not_after?.toISOString() ?? null,
          })),
      });
      const wireEnvelope = JSON.stringify({
        ts: Number.MAX_SAFE_INTEGER,
        kind: 'snapshot',
        payload: snapshot,
      });
      const encodedBytes = Buffer.byteLength(wireEnvelope);
      if (encodedBytes > MAX_HTTP_PROXY_SNAPSHOT_BYTES) {
        throw new Error(
          `HTTP proxy snapshot is ${encodedBytes} bytes; maximum is ${MAX_HTTP_PROXY_SNAPSHOT_BYTES}`,
        );
      }
      await transaction
        .updateTable('interaction.http_proxy_snapshot_state')
        .set({
          generation: nextGeneration,
          lease_issued_at: now,
          lease_valid_until: new Date(createdAtMs + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS),
          payload_sha256: createHash('sha256')
            .update(JSON.stringify(snapshot))
            .digest('hex'),
          updated_at: now,
        })
        .where('singleton', '=', true)
        .executeTakeFirstOrThrow();
      return snapshot;
    });
  }
}
