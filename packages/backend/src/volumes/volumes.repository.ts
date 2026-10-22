import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import {
  resolvePoolAccess,
  resolveServerAccess,
  resolveSharedBackendAccess,
} from '../iam/effective-access.js';
import { numberValue } from '../platform/domain-utils.js';
import type {
  CreatePendingIntentInput,
  EnsurePendingIntentInput,
  IntentExecutor,
  IntentRecord,
  IntentRepository,
} from '../reconcile/intent.repository.js';

export type VolumeExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;
export type VolumeCatalogState = 'ensuring' | 'present';
export type VolumeBindState = 'attaching' | 'attached' | 'detaching';

@Injectable()
export class VolumesRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  list(ownerId?: string, executor: VolumeExecutor = this.database) {
    let query = executor.selectFrom('control.volumes').selectAll().orderBy('created_at', 'desc');
    if (ownerId) query = query.where('owner_id', '=', ownerId);
    return query.execute();
  }

  listByKind(
    kind: 'local' | 'shared',
    options: { ownerId?: string; serverId?: string } = {},
    executor: VolumeExecutor = this.database,
  ) {
    let query = executor.selectFrom('control.volumes').selectAll().orderBy('created_at', 'desc');
    query = kind === 'local'
      ? query.where('shared_backend_id', 'is', null)
      : query.where('shared_backend_id', 'is not', null);
    if (options.ownerId) query = query.where('owner_id', '=', options.ownerId);
    if (options.serverId) query = query.where('server_id', '=', options.serverId);
    return query.execute();
  }

  findById(id: string, executor: VolumeExecutor = this.database) {
    return executor
      .selectFrom('control.volumes')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  insert(input: {
    id: string;
    ownerId: string;
    poolId: string | null;
    serverId: string | null;
    sharedBackendId: string | null;
    name: string;
    incusName: string;
    sizeBytes: number;
    lifecyclePhase?: 'provisioning' | 'active' | 'deleting' | 'failed';
    dirEnsured?: boolean;
  }, executor: VolumeExecutor) {
    return executor
      .insertInto('control.volumes')
      .values({
        id: input.id,
        owner_id: input.ownerId,
        pool_id: input.poolId,
        server_id: input.serverId,
        shared_backend_id: input.sharedBackendId,
        name: input.name,
        incus_name: input.incusName,
        size_bytes: input.sizeBytes,
        used_bytes: null,
        revision: 1,
        observed_revision: null,
        lifecycle_phase: input.lifecyclePhase ?? 'provisioning',
        needs_attention: false,
        failure_code: null,
        dir_ensured: input.dirEnsured ?? false,
        remove_all_committed: false,
        remove_all_server_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateDesired(
    id: string,
    revision: number,
    values: {
      name?: string;
      size_bytes?: number;
      lifecycle_phase?: 'provisioning' | 'active' | 'deleting' | 'failed';
      failure_code?: string | null;
      needs_attention?: boolean;
    },
    executor: VolumeExecutor,
  ) {
    return executor
      .updateTable('control.volumes')
      .set({
        ...values,
        revision: revision + 1,
        needs_attention: false,
      })
      .where('id', '=', id)
      .where('revision', '=', revision)
      .returningAll()
      .executeTakeFirst();
  }

  listAttachments(containerId?: string, volumeId?: string, executor: VolumeExecutor = this.database) {
    let query = executor
      .selectFrom('control.volume_attachments')
      .selectAll()
      .orderBy('created_at');
    if (containerId) query = query.where('container_id', '=', containerId);
    if (volumeId) query = query.where('volume_id', '=', volumeId);
    return query.execute();
  }

  insertAttachment(input: {
    id: string;
    containerId: string;
    volumeId: string;
    deviceName: string;
    containerPath: string;
    readOnly: boolean;
    bindState?: VolumeBindState;
  }, executor: VolumeExecutor) {
    return executor
      .insertInto('control.volume_attachments')
      .values({
        id: input.id,
        container_id: input.containerId,
        volume_id: input.volumeId,
        device_name: input.deviceName,
        container_path: input.containerPath,
        read_only: input.readOnly,
        bind_state: input.bindState ?? 'attaching',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  setAttachmentBindState(
    id: string,
    bindState: VolumeBindState,
    executor: VolumeExecutor,
  ) {
    return executor
      .updateTable('control.volume_attachments')
      .set({ bind_state: bindState })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  async hasAttachments(volumeId: string, executor: VolumeExecutor = this.database) {
    const row = await executor.selectFrom('control.volume_attachments')
      .select('id')
      .where('volume_id', '=', volumeId)
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }

  listPlacements(volumeId: string, executor: VolumeExecutor = this.database) {
    return executor.selectFrom('control.volume_placements')
      .selectAll()
      .where('volume_id', '=', volumeId)
      .execute();
  }

  findPlacement(
    volumeId: string,
    serverId: string,
    executor: VolumeExecutor = this.database,
  ) {
    return executor.selectFrom('control.volume_placements')
      .selectAll()
      .where('volume_id', '=', volumeId)
      .where('server_id', '=', serverId)
      .executeTakeFirst();
  }

  async upsertPlacement(
    input: {
      volumeId: string;
      serverId: string;
      poolId: string;
      catalogState: VolumeCatalogState;
    },
    executor: VolumeExecutor,
  ): Promise<void> {
    await executor.insertInto('control.volume_placements')
      .values({
        volume_id: input.volumeId,
        server_id: input.serverId,
        pool_id: input.poolId,
        catalog_state: input.catalogState,
        observed_revision: null,
      })
      .onConflict((conflict) => conflict
        .columns(['volume_id', 'server_id'])
        .doUpdateSet({
          pool_id: input.poolId,
        }))
      .execute();
  }

  async dropPlacement(
    volumeId: string,
    serverId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<void> {
    await executor.deleteFrom('control.volume_placements')
      .where('volume_id', '=', volumeId)
      .where('server_id', '=', serverId)
      .execute();
  }

  async dropAllPlacements(volumeId: string, executor: VolumeExecutor = this.database): Promise<void> {
    await executor.deleteFrom('control.volume_placements')
      .where('volume_id', '=', volumeId)
      .execute();
  }

  async markCatalogPresent(
    volumeId: string,
    serverId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<void> {
    await executor.updateTable('control.volume_placements')
      .set({ catalog_state: 'present' })
      .where('volume_id', '=', volumeId)
      .where('server_id', '=', serverId)
      .execute();
    await executor.updateTable('control.volumes')
      .set({ dir_ensured: true })
      .where('id', '=', volumeId)
      .execute();
  }

  async deleteVolumeRow(volumeId: string, executor: VolumeExecutor): Promise<void> {
    await executor.deleteFrom('control.volumes').where('id', '=', volumeId).execute();
  }

  /** Row lock for attach flows that must not race a concurrent delete or resize. */
  findByIdForUpdate(id: string, executor: VolumeExecutor) {
    return executor
      .selectFrom('control.volumes')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  async setUsedBytes(
    volumeId: string,
    usedBytes: number | null,
    executor: VolumeExecutor = this.database,
  ): Promise<void> {
    await executor
      .updateTable('control.volumes')
      .set({ used_bytes: usedBytes })
      .where('id', '=', volumeId)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .execute();
  }

  /** Bytes committed by volumes that are neither failed nor being deleted. */
  async sumLiveSizeBytes(
    filter: {
      kind: 'local' | 'shared';
      ownerId?: string;
      serverId?: string;
      poolId?: string;
      sharedBackendId?: string;
    },
    executor: VolumeExecutor = this.database,
  ): Promise<number> {
    let query = executor
      .selectFrom('control.volumes')
      .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('bytes'))
      .where('lifecycle_phase', 'not in', ['failed', 'deleting']);
    query = filter.kind === 'local'
      ? query.where('shared_backend_id', 'is', null)
      : query.where('shared_backend_id', 'is not', null);
    if (filter.ownerId !== undefined) query = query.where('owner_id', '=', filter.ownerId);
    if (filter.serverId !== undefined) query = query.where('server_id', '=', filter.serverId);
    if (filter.poolId !== undefined) query = query.where('pool_id', '=', filter.poolId);
    if (filter.sharedBackendId !== undefined) {
      query = query.where('shared_backend_id', '=', filter.sharedBackendId);
    }
    const row = await query.executeTakeFirstOrThrow();
    return numberValue(row.bytes);
  }

  listSharedBackendVolumes(backendId: string, executor: VolumeExecutor = this.database) {
    return executor
      .selectFrom('control.volumes')
      .select(['id', 'incus_name'])
      .where('shared_backend_id', '=', backendId)
      .execute();
  }

  /** Attachments of one container joined with the volume name and placement state on its server. */
  listContainerAttachmentRows(
    containerId: string,
    serverId: string,
    executor: VolumeExecutor = this.database,
  ) {
    return executor
      .selectFrom('control.volume_attachments as a')
      .innerJoin('control.volumes as v', 'v.id', 'a.volume_id')
      .leftJoin('control.volume_placements as p', (join) => join
        .onRef('p.volume_id', '=', 'a.volume_id')
        .on('p.server_id', '=', serverId))
      .selectAll('a')
      .select([
        'v.name as volume_name',
        'v.shared_backend_id as shared_backend_id',
        'p.catalog_state as catalog_state',
      ])
      .where('a.container_id', '=', containerId)
      .orderBy('a.created_at')
      .execute();
  }

  /** The attachment row locked together with its volume's backend id (kind detection). */
  findAttachmentForUpdate(attachmentId: string, executor: VolumeExecutor) {
    return executor
      .selectFrom('control.volume_attachments as a')
      .innerJoin('control.volumes as v', 'v.id', 'a.volume_id')
      .selectAll('a')
      .select('v.shared_backend_id as shared_backend_id')
      .where('a.id', '=', attachmentId)
      .forUpdate('a')
      .executeTakeFirst();
  }

  /** An existing attachment on the container for the same volume or the same path. */
  findConflictingAttachment(
    containerId: string,
    volumeId: string,
    containerPath: string,
    executor: VolumeExecutor,
  ) {
    return executor
      .selectFrom('control.volume_attachments')
      .select(['id', 'volume_id', 'container_path'])
      .where('container_id', '=', containerId)
      .where((expression) => expression.or([
        expression('volume_id', '=', volumeId),
        expression('container_path', '=', containerPath),
      ]))
      .executeTakeFirst();
  }

  /** Attachments of the given volumes with the attaching container's name. */
  listAttachmentSummaryRows(
    volumeIds: readonly string[],
    executor: VolumeExecutor = this.database,
  ) {
    return executor
      .selectFrom('control.volume_attachments as attachment')
      .innerJoin('control.containers as container', 'container.id', 'attachment.container_id')
      .select([
        'attachment.id',
        'attachment.volume_id',
        'attachment.container_id',
        'attachment.container_path',
        'attachment.bind_state',
        'container.name',
      ])
      .where('attachment.volume_id', 'in', [...volumeIds])
      .orderBy('attachment.created_at')
      .execute();
  }

  /** Which server each attachment's container lives on. */
  listAttachmentContainerServers(
    volumeIds: readonly string[],
    executor: VolumeExecutor = this.database,
  ) {
    if (volumeIds.length === 0) return Promise.resolve([]);
    return executor
      .selectFrom('control.volume_attachments as a')
      .innerJoin('control.containers as c', 'c.id', 'a.container_id')
      .select(['a.volume_id as volume_id', 'c.server_id as server_id'])
      .where('a.volume_id', 'in', [...volumeIds])
      .execute();
  }

  /** Placements on servers that can still be asked for live usage. */
  listPlacementsWithPool(volumeId: string, executor: VolumeExecutor = this.database) {
    return executor
      .selectFrom('control.volume_placements as pl')
      .innerJoin('infra.storage_pools as p', 'p.id', 'pl.pool_id')
      .innerJoin('infra.servers as s', 's.id', 'pl.server_id')
      .select([
        'pl.server_id as server_id',
        'pl.catalog_state as catalog_state',
        'p.incus_name as pool_name',
        'p.driver as driver',
        'p.resize_family as resize_family',
        's.status as server_status',
      ])
      .where('pl.volume_id', '=', volumeId)
      .orderBy('pl.server_id', 'asc')
      .execute();
  }

  async listPendingIntentIds(volumeId: string, executor: VolumeExecutor): Promise<string[]> {
    const rows = await executor
      .selectFrom('control.intents')
      .select('id')
      .where('resource_type', '=', 'volume')
      .where('resource_id', '=', volumeId)
      .where('status', '=', 'pending')
      .execute();
    return rows.map((row) => row.id);
  }
}

// --- eligible destroy executors -------------------------------------------------

export type EligibleDestroyExecutor = {
  server_id: string;
  server_name: string;
  pool_id: string;
  pool_name: string;
};

/**
 * Servers with a registered shareable CephFS pool on the backend, one pool each.
 * Only online servers by default; `includeOffline` answers whether an executor
 * exists at all, so a destroy waits for an unreachable one instead of treating
 * it as gone (which would drop the row and leave the data behind).
 */
export async function listEligibleDestroyExecutors(
  executor: VolumeExecutor,
  sharedBackendId: string,
  options: { excludeServerId?: string; includeOffline?: boolean } = {},
): Promise<EligibleDestroyExecutor[]> {
  let query = executor
    .selectFrom('infra.servers as s')
    .innerJoin('infra.storage_pools as p', 'p.server_id', 's.id')
    .select([
      's.id as server_id',
      's.name as server_name',
      'p.id as pool_id',
      'p.incus_name as pool_name',
    ])
    .where('p.registered', '=', true)
    .where('p.shareable', '=', true)
    .where('p.driver', '=', 'cephfs')
    .where('p.shared_backend_id', '=', sharedBackendId)
    .orderBy('s.id', 'asc')
    .orderBy('p.id', 'asc');
  if (!options.includeOffline) {
    query = query.where('s.status', '=', 'online');
  }
  if (options.excludeServerId) {
    query = query.where('s.id', '!=', options.excludeServerId);
  }
  const rows = await query.execute();
  const firstPoolByServer = new Map<string, EligibleDestroyExecutor>();
  for (const row of rows) {
    if (!firstPoolByServer.has(row.server_id)) {
      firstPoolByServer.set(row.server_id, row);
    }
  }
  return [...firstPoolByServer.values()];
}

// --- owner grants (current coverage, resolved from the effective-access views) ---

/** The owner's current server coverage; throws 403 when absent or expired. */
export async function requireServerAccess(
  executor: VolumeExecutor,
  ownerId: string,
  serverId: string,
) {
  const access = await resolveServerAccess(executor, ownerId, serverId);
  if (!access) throw new ForbiddenException('Server storage access is not granted');
  return access;
}

export async function assertPoolGrant(
  executor: VolumeExecutor,
  ownerId: string,
  poolId: string,
): Promise<void> {
  if (!await resolvePoolAccess(executor, ownerId, poolId)) {
    throw new ForbiddenException('Storage pool access is not granted');
  }
}

/** Capacity limit of the owner's current backend coverage: null = unlimited, undefined = none. */
export async function effectiveSharedGrant(
  executor: VolumeExecutor,
  ownerId: string,
  backendId: string,
): Promise<number | null | undefined> {
  const access = await resolveSharedBackendAccess(executor, ownerId, backendId);
  return access ? access.limitBytes : undefined;
}

export async function assertSharedGrant(
  executor: VolumeExecutor,
  ownerId: string,
  backendId: string,
): Promise<void> {
  const row = await effectiveSharedGrant(executor, ownerId, backendId);
  if (row === undefined) throw new ForbiddenException('Shared backend access is not granted');
}

// --- intent creation with target validation -------------------------------------

/**
 * Volume intents run against one Incus server: a local volume's own server, or
 * a registered placement of a shared volume. destroy is the exception and is
 * not bound to a server. Anything else is rejected before it is queued.
 */
export async function assertVolumeIntentTarget(
  input: Pick<CreatePendingIntentInput, 'kind' | 'resourceId' | 'serverId'>,
  executor: IntentExecutor,
): Promise<void> {
  if (input.kind === IntentKind.VolumeDestroy) {
    if (input.serverId) throw new Error('Volume destroy intents cannot carry a server id');
    return;
  }
  if (!input.serverId) throw new Error('Volume intents require a server id');
  const volume = await executor
    .selectFrom('control.volumes')
    .select(['server_id', 'shared_backend_id'])
    .where('id', '=', input.resourceId)
    .executeTakeFirst();
  if (volume?.shared_backend_id && input.kind === IntentKind.VolumeEnsure) {
    throw new Error('Shared volumes cannot enqueue volume.ensure');
  }
  if (volume && !volume.shared_backend_id && input.serverId !== volume.server_id) {
    throw new Error('Local volume intent server does not match the volume');
  }
  if (volume?.shared_backend_id) {
    const placement = await executor
      .selectFrom('control.volume_placements')
      .select('server_id')
      .where('volume_id', '=', input.resourceId)
      .where('server_id', '=', input.serverId)
      .executeTakeFirst();
    if (!placement) {
      throw new Error('Shared volume intent server does not match a placement');
    }
  }
}

export async function createVolumeIntent(
  intents: Pick<IntentRepository, 'createPending'>,
  input: CreatePendingIntentInput,
  executor: IntentExecutor,
): Promise<IntentRecord> {
  if (input.resourceType === IntentResourceType.Volume) {
    await assertVolumeIntentTarget(input, executor);
  }
  return intents.createPending(input, executor);
}

export async function ensureVolumeIntent(
  intents: Pick<IntentRepository, 'ensurePending'>,
  input: EnsurePendingIntentInput,
  executor: IntentExecutor,
): Promise<IntentRecord> {
  await assertVolumeIntentTarget(input, executor);
  return intents.ensurePending(input);
}
