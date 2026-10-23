import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { ContainerPhase, ContainerPowerIntent, type GpuContainerState } from '@nyabase/common';
import type { ContainerControlTable } from '../platform/persistence-pg/container-control-database.types.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { committedRootBytesSql } from '../platform/persistence-pg/committed-bytes.js';
import { deriveInstanceName } from '../incus/instance-spec.js';
import { numberValue } from '../platform/domain-utils.js';

export type ContainerExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;
export type ContainerRow = Selectable<ContainerControlTable>;

export interface ImageRow {
  id: string;
  alias: string;
  fingerprint: string | null;
  login_user: string;
  min_root_size_bytes: string | number | null;
  network_managed_externally: boolean;
  is_active: boolean;
  deleting: boolean;
}

export interface ServerRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  system_pool_id: string | null;
  parent_interface: string | null;
  preflight_status: string;
}

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
  memBytes: number;
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

  /** Which name rule a new container would break: unique per server, and per owner ignoring case. */
  async nameConflict(
    serverId: string,
    ownerId: string,
    name: string,
    executor: ContainerExecutor = this.database,
  ): Promise<'server' | 'owner' | null> {
    const rows = await executor
      .selectFrom('control.containers')
      .select(['server_id', 'name'])
      .where((where) => where.or([
        where.and([where('server_id', '=', serverId), where('name', '=', name)]),
        where.and([
          where('owner_id', '=', ownerId),
          where(sql`lower(name)`, '=', name.toLowerCase()),
        ]),
      ]))
      .execute();
    if (rows.some((row) => row.server_id === serverId && row.name === name)) return 'server';
    return rows.length > 0 ? 'owner' : null;
  }

  /**
   * Memory of the owner's containers on the server whose power intent is
   * running. Failed ones count too: an intent retry can bring them back.
   */
  async sumRunningMemBytes(
    filter: { ownerId: string; serverId: string; excludeContainerId?: string },
    executor: ContainerExecutor = this.database,
  ): Promise<number> {
    let query = executor
      .selectFrom('control.containers')
      .select(sql<string>`coalesce(sum(mem_bytes), 0)`.as('bytes'))
      .where('owner_id', '=', filter.ownerId)
      .where('server_id', '=', filter.serverId)
      .where('power_intent', '=', ContainerPowerIntent.Running)
      .where('lifecycle_phase', '<>', ContainerPhase.Deleting);
    if (filter.excludeContainerId !== undefined) query = query.where('id', '<>', filter.excludeContainerId);
    const row = await query.executeTakeFirstOrThrow();
    return numberValue(row.bytes);
  }

  /**
   * Root-disk bytes committed by containers that are neither failed nor being
   * deleted; a pending quota change or an unapplied shrink counts at its
   * larger size (`committedRootBytesSql`).
   */
  async sumLiveRootBytes(
    filter: { ownerId?: string; serverId?: string; poolId?: string },
    executor: ContainerExecutor = this.database,
  ): Promise<number> {
    let query = executor
      .selectFrom('control.containers')
      .select(sql<string>`coalesce(sum(${committedRootBytesSql()}), 0)`.as('bytes'))
      .where('lifecycle_phase', 'not in', ['failed', 'deleting']);
    if (filter.ownerId !== undefined) query = query.where('owner_id', '=', filter.ownerId);
    if (filter.serverId !== undefined) query = query.where('server_id', '=', filter.serverId);
    if (filter.poolId !== undefined) query = query.where('root_pool_id', '=', filter.poolId);
    const row = await query.executeTakeFirstOrThrow();
    return numberValue(row.bytes);
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
        observed_revision: null,
        image_alias: input.imageAlias,
        image_fingerprint: input.imageFingerprint,
        root_pool_id: input.rootPoolId,
        root_size_bytes: input.rootSizeBytes,
        root_size_pending_bytes: null,
        root_used_bytes: null,
        mem_bytes: input.memBytes,
        cpu_set: null,
        gpu_state: null,
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

  setGpuState(
    id: string,
    gpuState: GpuContainerState | null,
    executor: ContainerExecutor,
  ) {
    return executor.updateTable('control.containers')
      .set({ gpu_state: gpuState })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateDesired(
    id: string,
    revision: number,
    values: {
      mem_bytes?: number;
      root_size_bytes?: number;
      root_size_pending_bytes?: number | null;
      root_shrink_reserved_bytes?: number | null;
      gpu_state?: GpuContainerState | null;
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
        revision: revision + 1,
        last_transition_at: sql`clock_timestamp()`,
        needs_attention: false,
      })
      .where('id', '=', id)
      .where('revision', '=', revision)
      .returningAll()
      .executeTakeFirst();
  }

  transition(
    id: string,
    revision: number,
    values: {
      lifecycle_phase?: 'provisioning' | 'active' | 'deleting' | 'failed';
      power_intent?: 'running' | 'stopped';
      failure_code?: string | null;
      failure_reason?: string | null;
      needs_attention?: boolean;
    },
    executor: ContainerExecutor,
  ) {
    return this.updateDesired(id, revision, values, executor);
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

  /** An attachment of the container that is still being unmounted, if any. */
  findDetachingAttachment(containerId: string, executor: ContainerExecutor = this.database) {
    return executor.selectFrom('control.volume_attachments')
      .select('id')
      .where('container_id', '=', containerId)
      .where('bind_state', '=', 'detaching')
      .executeTakeFirst();
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
