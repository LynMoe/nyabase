import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { ContainerControlTable } from './container-control-database.types.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { deriveInstanceName } from '../incus/instance-spec.js';

export type ContainerExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;
export type ContainerRow = Selectable<ContainerControlTable>;

export interface NewContainerInput {
  id: string;
  serverId: string;
  ownerId: string;
  imageId: string;
  createdBy: string;
  name: string;
  imageAlias: string;
  imageFingerprint: string;
  rootPoolId: string;
  rootSizeBytes: number;
  cpuMillis: number;
  memBytes: number;
  extensions: Record<string, unknown>;
  powerIntent: 'running' | 'stopped';
  networkKey: string;
  address: string;
}

export interface ContainerSshRouteRecord {
  containerId: string;
  serverId: string;
  instanceName: string;
  routedIp: string;
  runtimeStatus: string;
  sshStatus: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown';
  lastError: string | null;
  observedAt: Date;
}

export interface NetworkClaimRecord {
  id: string;
  containerId: string | null;
  serverId: string;
  networkKey: string;
  address: string;
  state: 'active' | 'releasing';
  reusableAt: Date | null;
  ownerKind: 'container' | 'runtime_cleanup';
  ownerId: string;
}

@Injectable()
export class ContainerControlRepository {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  list(
    options: { ownerId?: string; serverId?: string } = {},
    executor: ContainerExecutor = this.database,
  ) {
    let query = executor.selectFrom('control.containers')
      .selectAll()
      .orderBy('created_at', 'desc');
    if (options.ownerId) query = query.where('owner_id', '=', options.ownerId);
    if (options.serverId) query = query.where('server_id', '=', options.serverId);
    return query.execute();
  }

  find(id: string, executor: ContainerExecutor = this.database) {
    return executor.selectFrom('control.containers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  lock(id: string, executor: Transaction<NyabaseDatabase>) {
    return executor.selectFrom('control.containers')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  insert(input: NewContainerInput, executor: ContainerExecutor) {
    return executor.insertInto('control.containers')
      .values({
        id: input.id,
        server_id: input.serverId,
        owner_id: input.ownerId,
        image_id: input.imageId,
        created_by: input.createdBy,
        name: input.name,
        revision: 1,
        generation: 1,
        observed_generation: null,
        image_alias: input.imageAlias,
        image_fingerprint: input.imageFingerprint,
        root_pool_id: input.rootPoolId,
        root_size_bytes: input.rootSizeBytes,
        root_size_pending_bytes: null,
        root_used_bytes: null,
        cpu_millis: input.cpuMillis,
        mem_bytes: input.memBytes,
        extensions: input.extensions,
        nesting: true,
        syscall_intercept: true,
        power_intent: input.powerIntent,
        lifecycle_phase: 'provisioning',
        instance_name: deriveInstanceName(input.id),
        needs_attention: false,
        failure_code: null,
        failure_reason: null,
        last_transition_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
      .then(async (row) => {
        await executor.insertInto('control.container_network_claims')
          .values({
            id: randomUUID(),
            container_id: row.id,
            server_id: input.serverId,
            network_key: input.networkKey,
            address: input.address,
            state: 'active',
            reusable_at: null,
            owner_kind: 'container',
            owner_id: row.id,
            cleanup_payload_json: null,
          })
          .execute();
        await executor.insertInto('control.container_ssh_routes')
          .values({
            container_id: row.id,
            server_id: input.serverId,
            instance_name: deriveInstanceName(row.id),
            routed_ip: input.address,
            instance_status: 'unknown',
            instance_started_at: null,
            ssh_status: 'unknown',
            last_error: null,
            observed_at: new Date(),
          })
          .execute();
        return row;
      });
  }

  setExtensions(
    id: string,
    extensions: Record<string, unknown>,
    executor: ContainerExecutor,
  ) {
    return executor.updateTable('control.containers')
      .set({ extensions })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateDesired(
    id: string,
    generation: number,
    values: {
      cpu_millis?: number;
      mem_bytes?: number;
      root_size_bytes?: number;
      root_size_pending_bytes?: number | null;
      extensions?: Record<string, unknown>;
      power_intent?: 'running' | 'stopped';
      lifecycle_phase?: 'provisioning' | 'active' | 'deleting' | 'failed';
      failure_code?: string | null;
      failure_reason?: string | null;
      needs_attention?: boolean;
    },
    executor: ContainerExecutor,
  ) {
    return executor.updateTable('control.containers')
      .set({
        ...values,
        revision: sql`revision + 1`,
        generation: generation + 1,
        last_transition_at: sql`clock_timestamp()`,
        needs_attention: false,
      })
      .where('id', '=', id)
      .where('generation', '=', generation)
      .returningAll()
      .executeTakeFirst();
  }

  transition(
    id: string,
    generation: number,
    values: {
      lifecycle_phase?: 'provisioning' | 'active' | 'deleting' | 'failed';
      power_intent?: 'running' | 'stopped';
      failure_code?: string | null;
      failure_reason?: string | null;
      needs_attention?: boolean;
    },
    executor: ContainerExecutor,
  ) {
    return this.updateDesired(id, generation, values, executor);
  }

  async findAvailableAddress(
    networkKey: string,
    allocationCidr: string,
    reserved: readonly string[],
    seed: string,
    executor: ContainerExecutor,
  ): Promise<string> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`container-network:${networkKey}`}, 0))`
      .execute(executor);
    await executor.deleteFrom('control.container_network_claims')
      .where('network_key', '=', networkKey)
      .where('state', '=', 'releasing')
      .where('reusable_at', '<=', new Date())
      .execute();
    const claims = await executor.selectFrom('control.container_network_claims')
      .select(['address', 'state', 'reusable_at'])
      .where('network_key', '=', networkKey)
      .forUpdate()
      .execute();
    const occupied = new Set(
      claims
        .filter((claim) => claim.state === 'active'
          || (claim.reusable_at !== null && new Date(claim.reusable_at).getTime() > Date.now()))
        .map((claim) => claim.address),
    );
    for (const value of reserved) occupied.add(value);
    const parsed = parseIpv4Cidr(allocationCidr);
    if (!parsed) throw new Error('Invalid IP pool CIDR');
    const total = 2 ** (32 - parsed.prefix);
    const start = Number.parseInt(seed.replaceAll('-', '').slice(0, 8), 16) % Math.max(total, 1);
    for (let offset = 0; offset < Math.min(total, 65_536); offset += 1) {
      const candidate = ipv4Text(parsed.network + ((start + offset) % total));
      if (
        candidate === ipv4Text(parsed.network)
        || candidate === parsed.gateway
        || candidate === ipv4Text(parsed.broadcast)
        || occupied.has(candidate)
      ) continue;
      return candidate;
    }
    throw new Error('No IP address is available');
  }

  listAttachments(containerId: string, executor: ContainerExecutor = this.database) {
    return executor.selectFrom('control.volume_attachments')
      .selectAll()
      .where('container_id', '=', containerId)
      .orderBy('created_at')
      .execute();
  }

  currentRoute(containerId: string, executor: ContainerExecutor = this.database) {
    return executor.selectFrom('control.container_ssh_routes')
      .selectAll()
      .where('container_id', '=', containerId)
      .executeTakeFirst();
  }

  routes(
    containerIds: readonly string[],
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerSshRouteRecord[]> {
    if (containerIds.length === 0) return Promise.resolve([]);
    return executor.selectFrom('control.container_ssh_routes')
      .selectAll()
      .where('container_id', 'in', [...containerIds])
      .execute()
      .then((rows) => rows.map((row) => this.route(row)));
  }

  listRoutes(
    options: { serverId?: string } = {},
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerSshRouteRecord[]> {
    let query = executor.selectFrom('control.container_ssh_routes').selectAll();
    if (options.serverId) query = query.where('server_id', '=', options.serverId);
    return query.execute().then((rows) => rows.map((row) => this.route(row)));
  }

  async replaceServerRoutes(
    serverId: string,
    routes: readonly ContainerSshRouteRecord[],
    executor: ContainerExecutor,
  ): Promise<void> {
    await executor.deleteFrom('control.container_ssh_routes')
      .where('server_id', '=', serverId)
      .execute();
    if (routes.length === 0) return;
    await executor.insertInto('control.container_ssh_routes')
      .values(routes.map((route) => ({
        container_id: route.containerId,
        server_id: route.serverId,
        instance_name: route.instanceName,
        routed_ip: route.routedIp,
        instance_status: route.runtimeStatus,
        ssh_status: route.sshStatus,
        last_error: route.lastError,
        observed_at: route.observedAt,
      })))
      .execute();
  }

  async deleteRoutes(
    options: { serverId?: string; containerId?: string } = {},
    executor: ContainerExecutor = this.database,
  ): Promise<void> {
    let query = executor.deleteFrom('control.container_ssh_routes');
    if (options.serverId) query = query.where('server_id', '=', options.serverId);
    if (options.containerId) query = query.where('container_id', '=', options.containerId);
    await query.execute();
  }

  activeNetworkClaims(
    filter: { addresses?: readonly string[]; serverId?: string } = {},
    executor: ContainerExecutor = this.database,
  ): Promise<NetworkClaimRecord[]> {
    let query = executor.selectFrom('control.container_network_claims')
      .selectAll()
      .where('state', '=', 'active');
    if (filter.serverId) query = query.where('server_id', '=', filter.serverId);
    if (filter.addresses && filter.addresses.length > 0) {
      query = query.where('address', 'in', [...filter.addresses]);
    }
    return query.execute().then((rows) => rows.map((row) => ({
      id: row.id,
      containerId: row.container_id,
      serverId: row.server_id,
      networkKey: row.network_key,
      address: row.address,
      state: row.state,
      reusableAt: row.reusable_at ? new Date(row.reusable_at) : null,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
    })));
  }

  countOnServer(serverId: string, executor: ContainerExecutor = this.database) {
    return executor.selectFrom('control.containers')
      .select(sql<number>`count(*)`.as('count'))
      .where('server_id', '=', serverId)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .executeTakeFirstOrThrow()
      .then((row) => Number(row.count));
  }

  private route(row: {
    container_id: string;
    server_id: string;
    instance_name: string;
    routed_ip: string;
    instance_status: string;
    ssh_status: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown';
    last_error: string | null;
    observed_at: Date;
  }): ContainerSshRouteRecord {
    return {
      containerId: row.container_id,
      serverId: row.server_id,
      instanceName: row.instance_name,
      routedIp: row.routed_ip,
      runtimeStatus: row.instance_status,
      sshStatus: row.ssh_status,
      lastError: row.last_error,
      observedAt: row.observed_at,
    };
  }
}

function parseIpv4Cidr(value: string): {
  network: number;
  broadcast: number;
  prefix: number;
  gateway: string | null;
} | null {
  const [address, rawPrefix] = value.split('/');
  const prefix = Number(rawPrefix);
  if (!address || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const number = ipv4Number(address);
  if (number === null) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = number & mask;
  return {
    network,
    broadcast: (network | (~mask >>> 0)) >>> 0,
    prefix,
    gateway: null,
  };
}

function ipv4Number(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result * 256 + octet) >>> 0;
  }
  return result;
}

function ipv4Text(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}
