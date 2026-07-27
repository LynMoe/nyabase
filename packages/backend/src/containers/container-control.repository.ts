import { Inject, Injectable } from '@nestjs/common';
import { ContainerPhase } from '@nyabase/common';
import type {
  ContainerPowerIntent,
  ContainerStatus,
  ImageRuntimeOverrides,
} from '@nyabase/common';
import type { Kysely, Selectable, Transaction, Updateable } from 'kysely';
import { sql } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import type { ContainerControlTable } from './container-control-database.types.js';

export type ContainerExecutor =
  | Kysely<NyabaseDatabase>
  | Transaction<NyabaseDatabase>;

export interface ContainerAggregate {
  id: string;
  serverId: string;
  ownerId: string;
  imageId: string;
  createdBy: string;
  name: string;
  revision: number;
  desiredGeneration: number;
  imageRef: string;
  imageDefaultUid: number;
  imageRuntimeOverrides: ImageRuntimeOverrides;
  cpuMillis: number;
  memBytes: number;
  diskBytes: number;
  gpuMode: 'none' | 'indices' | 'all';
  gpuIndices: number[];
  mountsJson: unknown[];
  powerIntent: ContainerPowerIntent;
  lifecyclePhase: ContainerPhase;
  observedGeneration: number | null;
  boundRuntimeId: string | null;
  quotaPaths: string[];
  runtimeSpecHash: string | null;
  activeTaskId: string | null;
  lastTransitionAt: Date;
  failureReason: string | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContainerMountRecord {
  id: string;
  containerId: string;
  serverId: string;
  resourceId: string;
  sourceKind: 'local' | 'remote';
  sourceId: string;
  sourceIdentity: string;
  userId: string;
  dirName: string;
  containerPath: string;
}

export interface ContainerSshRouteRecord {
  containerId: string;
  serverId: string;
  runtimeId: string;
  macvlanIp: string | null;
  runtimeStatus: ContainerStatus;
  sshStatus: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown';
  appliedInternalKeyGeneration: number | null;
  containerHostKeyFingerprint: string | null;
  lastError: string | null;
  observedAt: Date;
}

export interface ContainerNetworkClaimRecord {
  id: string;
  containerId: string | null;
  ownerKind: 'container' | 'runtime_cleanup';
  ownerId: string;
  serverId: string;
  networkKey: string;
  address: string;
  state: 'active' | 'releasing';
  reusableAt: Date | null;
  cleanupPayload: unknown | null;
}

export interface NewContainerAggregate {
  id: string;
  serverId: string;
  ownerId: string;
  imageId: string;
  createdBy: string;
  name: string;
  imageRef: string;
  imageDefaultUid: number;
  imageRuntimeOverrides: ImageRuntimeOverrides;
  cpuMillis: number;
  memBytes: number;
  diskBytes: number;
  gpuMode: 'none' | 'indices' | 'all';
  gpuIndices: number[];
  mountsJson: unknown[];
  powerIntent: ContainerPowerIntent;
  lifecyclePhase: ContainerPhase;
}

function safeInteger(value: string | number | bigint, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} exceeds the safe application range`);
  }
  return parsed;
}

@Injectable()
export class ContainerControlRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  async list(
    filters: { ownerId?: string; serverId?: string } = {},
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerAggregate[]> {
    let query = executor.selectFrom('control.containers').selectAll();
    if (filters.ownerId) query = query.where('owner_id', '=', filters.ownerId);
    if (filters.serverId) query = query.where('server_id', '=', filters.serverId);
    return (await query.orderBy('created_at', 'desc').orderBy('id').execute())
      .map(toContainer);
  }

  async find(
    id: string,
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerAggregate | null> {
    const row = await executor.selectFrom('control.containers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toContainer(row) : null;
  }

  async findByIds(
    ids: readonly string[],
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerAggregate[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    return (await executor.selectFrom('control.containers')
      .selectAll()
      .where('id', 'in', uniqueIds)
      .execute()).map(toContainer);
  }

  async lock(
    id: string,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<ContainerAggregate | null> {
    const row = await transaction.selectFrom('control.containers')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row ? toContainer(row) : null;
  }

  async countOnServer(
    serverId: string,
    executor: ContainerExecutor = this.database,
  ): Promise<number> {
    const row = await executor.selectFrom('control.containers')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async insert(
    input: NewContainerAggregate,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<ContainerAggregate> {
    const row = await transaction.insertInto('control.containers').values({
      id: input.id,
      server_id: input.serverId,
      owner_id: input.ownerId,
      image_id: input.imageId,
      created_by: input.createdBy,
      name: input.name,
      revision: 1,
      desired_generation: 1,
      image_ref: input.imageRef,
      image_default_uid: input.imageDefaultUid,
      image_runtime_overrides: JSON.stringify(input.imageRuntimeOverrides),
      cpu_millis: input.cpuMillis,
      mem_bytes: input.memBytes,
      disk_bytes: input.diskBytes,
      gpu_mode: input.gpuMode,
      gpu_indices: input.gpuIndices,
      mounts_json: JSON.stringify(input.mountsJson),
      power_intent: input.powerIntent,
      lifecycle_phase: input.lifecyclePhase,
      observed_generation: null,
      bound_runtime_id: null,
      quota_paths: [],
      runtime_spec_hash: null,
      active_task_id: null,
      last_transition_at: new Date(),
      failure_reason: null,
      failure_code: null,
    }).returningAll().executeTakeFirstOrThrow();
    return toContainer(row);
  }

  async transition(
    id: string,
    expectedRevision: number,
    patch: {
      powerIntent?: ContainerPowerIntent;
      lifecyclePhase?: ContainerPhase;
      activeTaskId?: string | null;
      desiredGeneration?: number;
      observedGeneration?: number | null;
      boundRuntimeId?: string | null;
      quotaPaths?: string[];
      runtimeSpecHash?: string | null;
      failureReason?: string | null;
      failureCode?: string | null;
      name?: string;
    },
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<ContainerAggregate | null> {
    const values: Updateable<ContainerControlTable> = {
      last_transition_at: new Date(),
    };
    if (patch.powerIntent !== undefined) values.power_intent = patch.powerIntent;
    if (patch.lifecyclePhase !== undefined) values.lifecycle_phase = patch.lifecyclePhase;
    if (patch.activeTaskId !== undefined) values.active_task_id = patch.activeTaskId;
    if (patch.desiredGeneration !== undefined) {
      values.desired_generation = patch.desiredGeneration;
    }
    if (patch.observedGeneration !== undefined) {
      values.observed_generation = patch.observedGeneration;
    }
    if (patch.boundRuntimeId !== undefined) values.bound_runtime_id = patch.boundRuntimeId;
    if (patch.quotaPaths !== undefined) values.quota_paths = patch.quotaPaths;
    if (patch.runtimeSpecHash !== undefined) values.runtime_spec_hash = patch.runtimeSpecHash;
    if (patch.failureReason !== undefined) values.failure_reason = patch.failureReason;
    if (patch.failureCode !== undefined) values.failure_code = patch.failureCode;
    if (patch.name !== undefined) values.name = patch.name;
    const row = await transaction.updateTable('control.containers')
      .set(values)
      .set('revision', sql<string>`revision + 1`)
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    return row ? toContainer(row) : null;
  }

  async delete(
    id: string,
    expectedRevision: number,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<boolean> {
    const result = await transaction.deleteFrom('control.containers')
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  /**
   * Recovery-only CAS boundary for a failed aggregate. The Workflow caller
   * supplies the durable recovery task identity from the same transaction.
   */
  async recoverFailed(
    id: string,
    expectedRevision: number,
    activeTaskId: string,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<ContainerAggregate | null> {
    const row = await transaction.updateTable('control.containers')
      .set({
        lifecycle_phase: ContainerPhase.Updating,
        active_task_id: activeTaskId,
        failure_code: null,
        failure_reason: null,
        last_transition_at: new Date(),
      })
      .set('revision', sql<string>`revision + 1`)
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .where('lifecycle_phase', '=', ContainerPhase.Failed)
      .returningAll()
      .executeTakeFirst();
    return row ? toContainer(row) : null;
  }

  async replaceMounts(
    containerId: string,
    mounts: readonly ContainerMountRecord[],
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    await transaction.deleteFrom('control.container_mounts')
      .where('container_id', '=', containerId)
      .execute();
    if (mounts.length === 0) return;
    await transaction.insertInto('control.container_mounts')
      .values(mounts.map((mount) => ({
        id: mount.id,
        container_id: mount.containerId,
        server_id: mount.serverId,
        resource_id: mount.resourceId,
        source_kind: mount.sourceKind,
        source_id: mount.sourceId,
        source_identity: mount.sourceIdentity,
        user_id: mount.userId,
        dir_name: mount.dirName,
        container_path: mount.containerPath,
      })))
      .execute();
  }

  async listMounts(
    containerIds: readonly string[],
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerMountRecord[]> {
    if (containerIds.length === 0) return [];
    return (await executor.selectFrom('control.container_mounts')
      .selectAll()
      .where('container_id', 'in', [...containerIds])
      .orderBy('container_id')
      .orderBy('container_path')
      .execute()).map((row) => ({
      id: row.id,
      containerId: row.container_id,
      serverId: row.server_id,
      resourceId: row.resource_id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      sourceIdentity: row.source_identity,
      userId: row.user_id,
      dirName: row.dir_name,
      containerPath: row.container_path,
    }));
  }

  async replaceGpuClaims(
    containerId: string,
    serverId: string,
    gpuIndices: readonly number[],
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    await transaction.deleteFrom('control.container_gpu_claims')
      .where('container_id', '=', containerId)
      .execute();
    if (gpuIndices.length === 0) return;
    await transaction.insertInto('control.container_gpu_claims')
      .values(gpuIndices.map((gpuIndex) => ({
        id: crypto.randomUUID(),
        container_id: containerId,
        server_id: serverId,
        gpu_index: gpuIndex,
      })))
      .execute();
  }

  async claimedGpuIndices(
    serverId: string,
    executor: ContainerExecutor = this.database,
  ): Promise<number[]> {
    return (await executor.selectFrom('control.container_gpu_claims')
      .select('gpu_index')
      .where('server_id', '=', serverId)
      .execute()).map((row) => row.gpu_index);
  }

  async listNetworkAddresses(
    networkKey: string,
    executor: ContainerExecutor = this.database,
  ): Promise<string[]> {
    return (await executor.selectFrom('control.container_network_claims')
      .select('address')
      .where('network_key', '=', networkKey)
      .execute()).map((row) => row.address);
  }

  async insertNetworkClaim(
    input: {
      id: string;
      containerId: string;
      serverId: string;
      networkKey: string;
      address: string;
    },
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    await transaction.insertInto('control.container_network_claims').values({
      id: input.id,
      container_id: input.containerId,
      owner_kind: 'container',
      owner_id: input.containerId,
      server_id: input.serverId,
      network_key: input.networkKey,
      address: input.address,
      state: 'active',
      reusable_at: null,
      cleanup_payload_json: null,
    }).execute();
  }

  async networkClaimForContainer(
    containerId: string,
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerNetworkClaimRecord | null> {
    const row = await executor.selectFrom('control.container_network_claims')
      .selectAll()
      .where('container_id', '=', containerId)
      .executeTakeFirst();
    return row ? {
      id: row.id,
      containerId: row.container_id,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      serverId: row.server_id,
      networkKey: row.network_key,
      address: row.address,
      state: row.state,
      reusableAt: row.reusable_at,
      cleanupPayload: row.cleanup_payload_json,
    } : null;
  }

  async activeNetworkClaims(
    input: { serverId?: string; containerIds?: readonly string[]; addresses?: readonly string[] },
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerNetworkClaimRecord[]> {
    // Each supplied collection is an intersecting filter. An explicitly empty
    // collection therefore has an empty result and must never compile to
    // PostgreSQL's invalid `IN ()` syntax.
    if (input.containerIds?.length === 0 || input.addresses?.length === 0) return [];
    let query = executor.selectFrom('control.container_network_claims')
      .selectAll()
      .where('state', '=', 'active');
    if (input.serverId) query = query.where('server_id', '=', input.serverId);
    if (input.containerIds) {
      query = query.where('container_id', 'in', [...input.containerIds]);
    }
    if (input.addresses) query = query.where('address', 'in', [...input.addresses]);
    return (await query.execute()).map((row) => ({
      id: row.id,
      containerId: row.container_id,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      serverId: row.server_id,
      networkKey: row.network_key,
      address: row.address,
      state: row.state,
      reusableAt: row.reusable_at,
      cleanupPayload: row.cleanup_payload_json,
    }));
  }

  async markNetworkClaimReleasing(
    containerId: string,
    reusableAt: Date,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<boolean> {
    const updated = await transaction.updateTable('control.container_network_claims')
      .set({ state: 'releasing', reusable_at: reusableAt })
      .where('container_id', '=', containerId)
      .where('state', '=', 'active')
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  }

  currentDatabaseTime(
    executor: ContainerExecutor = this.database,
  ): Promise<Date> {
    return sql<{ now: Date }>`select clock_timestamp() as now`
      .execute(executor)
      .then((result) => new Date(result.rows[0]!.now));
  }

  networkClaimReuseDeadline(
    delayMs: number,
    executor: ContainerExecutor = this.database,
  ): Promise<Date> {
    const boundedDelayMs = Math.max(
      0,
      Math.min(86_400_000, Math.trunc(delayMs)),
    );
    return sql<{ reusableAt: Date }>`
      select clock_timestamp()
        + (${boundedDelayMs} * interval '1 millisecond') as "reusableAt"
    `.execute(executor)
      .then((result) => new Date(result.rows[0]!.reusableAt));
  }

  async runtimeCleanupClaims(
    serverId: string,
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerNetworkClaimRecord[]> {
    const rows = await executor.selectFrom('control.container_network_claims')
      .selectAll()
      .where('owner_kind', '=', 'runtime_cleanup')
      .where('server_id', '=', serverId)
      .orderBy('owner_id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      containerId: row.container_id,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      serverId: row.server_id,
      networkKey: row.network_key,
      address: row.address,
      state: row.state,
      reusableAt: row.reusable_at,
      cleanupPayload: row.cleanup_payload_json,
    }));
  }

  async allNetworkClaims(
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerNetworkClaimRecord[]> {
    const rows = await executor.selectFrom('control.container_network_claims')
      .selectAll()
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      containerId: row.container_id,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      serverId: row.server_id,
      networkKey: row.network_key,
      address: row.address,
      state: row.state,
      reusableAt: row.reusable_at,
      cleanupPayload: row.cleanup_payload_json,
    }));
  }

  async insertRuntimeCleanupClaim(
    input: {
      id: string;
      runtimeId: string;
      serverId: string;
      networkKey: string;
      address: string;
      cleanupPayload: unknown;
    },
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    await transaction.insertInto('control.container_network_claims').values({
      id: input.id,
      container_id: null,
      owner_kind: 'runtime_cleanup',
      owner_id: input.runtimeId,
      server_id: input.serverId,
      network_key: input.networkKey,
      address: input.address,
      state: 'active',
      reusable_at: null,
      cleanup_payload_json: JSON.stringify(input.cleanupPayload),
    }).execute();
  }

  async adoptReleasedContainerClaimForRuntimeCleanup(
    input: {
      containerId: string;
      runtimeId: string;
      serverId: string;
      networkKey: string;
      address: string;
      cleanupPayload: unknown;
    },
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<boolean> {
    const updated = await transaction.updateTable('control.container_network_claims')
      .set({
        owner_kind: 'runtime_cleanup',
        owner_id: input.runtimeId,
        state: 'active',
        reusable_at: null,
        cleanup_payload_json: JSON.stringify(input.cleanupPayload),
      })
      .where('container_id', 'is', null)
      .where('owner_kind', '=', 'container')
      .where('owner_id', '=', input.containerId)
      .where('server_id', '=', input.serverId)
      .where('network_key', '=', input.networkKey)
      .where('address', '=', input.address)
      .where('state', '=', 'releasing')
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  }

  async markRuntimeCleanupReleasing(
    runtimeId: string,
    serverId: string,
    reusableAt: Date,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<ContainerNetworkClaimRecord | null> {
    const row = await transaction.updateTable('control.container_network_claims')
      .set({ state: 'releasing', reusable_at: reusableAt })
      .where('owner_kind', '=', 'runtime_cleanup')
      .where('owner_id', '=', runtimeId)
      .where('server_id', '=', serverId)
      .where('state', '=', 'active')
      .returningAll()
      .executeTakeFirst();
    return row ? {
      id: row.id,
      containerId: row.container_id,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      serverId: row.server_id,
      networkKey: row.network_key,
      address: row.address,
      state: row.state,
      reusableAt: row.reusable_at,
      cleanupPayload: row.cleanup_payload_json,
    } : null;
  }

  async reactivateRuntimeCleanupClaim(
    id: string,
    cleanupPayload: unknown,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<boolean> {
    const updated = await transaction.updateTable('control.container_network_claims')
      .set({
        state: 'active',
        reusable_at: null,
        cleanup_payload_json: JSON.stringify(cleanupPayload),
      })
      .where('id', '=', id)
      .where('owner_kind', '=', 'runtime_cleanup')
      .where('state', '=', 'releasing')
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  }

  async deleteReleasedNetworkClaim(
    id: string,
    reusableAt: Date,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<boolean> {
    const deleted = await transaction.deleteFrom('control.container_network_claims')
      .where('id', '=', id)
      .where('state', '=', 'releasing')
      .where('reusable_at', '=', reusableAt)
      .executeTakeFirst();
    return Number(deleted.numDeletedRows) === 1;
  }

  async releasedNetworkClaimCandidates(
    now: Date,
    limit: number,
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerNetworkClaimRecord[]> {
    const rows = await executor.selectFrom('control.container_network_claims')
      .selectAll()
      .where('state', '=', 'releasing')
      .where('reusable_at', '<=', now)
      .orderBy('reusable_at')
      .orderBy('id')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      containerId: row.container_id,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      serverId: row.server_id,
      networkKey: row.network_key,
      address: row.address,
      state: row.state,
      reusableAt: row.reusable_at,
      cleanupPayload: row.cleanup_payload_json,
    }));
  }

  async replaceServerRoutes(
    serverId: string,
    routes: readonly ContainerSshRouteRecord[],
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    await transaction.deleteFrom('control.container_ssh_routes')
      .where('server_id', '=', serverId)
      .execute();
    if (routes.length === 0) return;
    await transaction.insertInto('control.container_ssh_routes').values(
      routes.map((route) => this.routeValues(route)),
    ).execute();
  }

  async upsertRoute(
    route: ContainerSshRouteRecord,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    await transaction.insertInto('control.container_ssh_routes')
      .values(this.routeValues(route))
      .onConflict((conflict) => conflict.column('container_id').doUpdateSet({
        server_id: route.serverId,
        runtime_id: route.runtimeId,
        macvlan_ip: route.macvlanIp,
        runtime_status: route.runtimeStatus,
        ssh_status: route.sshStatus,
        applied_internal_key_generation: route.appliedInternalKeyGeneration,
        container_host_key_fingerprint: route.containerHostKeyFingerprint,
        last_error: route.lastError,
        observed_at: route.observedAt,
      }))
      .execute();
  }

  async deleteRoutes(
    filters: { serverId?: string } = {},
    executor: ContainerExecutor = this.database,
  ): Promise<void> {
    let query = executor.deleteFrom('control.container_ssh_routes');
    if (filters.serverId) query = query.where('server_id', '=', filters.serverId);
    await query.execute();
  }

  async listRoutes(
    filters: { serverId?: string } = {},
    executor: ContainerExecutor = this.database,
  ): Promise<ContainerSshRouteRecord[]> {
    let query = executor.selectFrom('control.container_ssh_routes').selectAll();
    if (filters.serverId) query = query.where('server_id', '=', filters.serverId);
    return (await query.execute()).map((row) => this.toRoute(row));
  }

  async routes(
    containerIds: readonly string[],
    executor: ContainerExecutor = this.database,
  ): Promise<Map<string, ContainerSshRouteRecord>> {
    if (containerIds.length === 0) return new Map();
    const rows = await executor.selectFrom('control.container_ssh_routes')
      .selectAll()
      .where('container_id', 'in', [...containerIds])
      .execute();
    return new Map(rows.map((row) => [row.container_id, this.toRoute(row)]));
  }

  private routeValues(route: ContainerSshRouteRecord) {
    return {
      container_id: route.containerId,
      server_id: route.serverId,
      runtime_id: route.runtimeId,
      macvlan_ip: route.macvlanIp,
      runtime_status: route.runtimeStatus,
      ssh_status: route.sshStatus,
      applied_internal_key_generation: route.appliedInternalKeyGeneration,
      container_host_key_fingerprint: route.containerHostKeyFingerprint,
      last_error: route.lastError,
      observed_at: route.observedAt,
    };
  }

  private toRoute(
    row: Selectable<import('./container-control-database.types.js').ContainerSshRouteTable>,
  ): ContainerSshRouteRecord {
    return {
      containerId: row.container_id,
      serverId: row.server_id,
      runtimeId: row.runtime_id,
      macvlanIp: row.macvlan_ip,
      runtimeStatus: row.runtime_status,
      sshStatus: row.ssh_status,
      appliedInternalKeyGeneration: row.applied_internal_key_generation,
      containerHostKeyFingerprint: row.container_host_key_fingerprint,
      lastError: row.last_error,
      observedAt: row.observed_at,
    };
  }
}

function toContainer(row: Selectable<ContainerControlTable>): ContainerAggregate {
  return {
    id: row.id,
    serverId: row.server_id,
    ownerId: row.owner_id,
    imageId: row.image_id,
    createdBy: row.created_by,
    name: row.name,
    revision: safeInteger(row.revision, 'container revision'),
    desiredGeneration: row.desired_generation,
    imageRef: row.image_ref,
    imageDefaultUid: row.image_default_uid,
    imageRuntimeOverrides: row.image_runtime_overrides,
    cpuMillis: row.cpu_millis,
    memBytes: safeInteger(row.mem_bytes, 'container memory'),
    diskBytes: safeInteger(row.disk_bytes, 'container disk'),
    gpuMode: row.gpu_mode,
    gpuIndices: row.gpu_indices,
    mountsJson: row.mounts_json,
    powerIntent: row.power_intent,
    lifecyclePhase: row.lifecycle_phase,
    observedGeneration: row.observed_generation,
    boundRuntimeId: row.bound_runtime_id,
    quotaPaths: row.quota_paths,
    runtimeSpecHash: row.runtime_spec_hash,
    activeTaskId: row.active_task_id,
    lastTransitionAt: row.last_transition_at,
    failureReason: row.failure_reason,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
