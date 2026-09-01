import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';

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
    ownerId?: string,
    executor: VolumeExecutor = this.database,
  ) {
    let query = executor.selectFrom('control.volumes').selectAll().orderBy('created_at', 'desc');
    query = kind === 'local'
      ? query.where('shared_backend_id', 'is', null)
      : query.where('shared_backend_id', 'is not', null);
    if (ownerId) query = query.where('owner_id', '=', ownerId);
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
        generation: 1,
        observed_generation: null,
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
    generation: number,
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
        generation: generation + 1,
        needs_attention: false,
      })
      .where('id', '=', id)
      .where('generation', '=', generation)
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

  findAttachment(id: string, executor: VolumeExecutor = this.database) {
    return executor
      .selectFrom('control.volume_attachments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
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

  deleteAttachment(id: string, executor: VolumeExecutor) {
    return executor
      .deleteFrom('control.volume_attachments')
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

  listPlacementsOnServer(serverId: string, executor: VolumeExecutor = this.database) {
    return executor.selectFrom('control.volume_placements')
      .selectAll()
      .where('server_id', '=', serverId)
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
        observed_generation: null,
      })
      .onConflict((conflict) => conflict
        .columns(['volume_id', 'server_id'])
        .doUpdateSet({
          pool_id: input.poolId,
        }))
      .execute();
  }

  async setCatalogState(
    volumeId: string,
    serverId: string,
    catalogState: VolumeCatalogState,
    executor: VolumeExecutor,
  ): Promise<void> {
    await executor.updateTable('control.volume_placements')
      .set({ catalog_state: catalogState })
      .where('volume_id', '=', volumeId)
      .where('server_id', '=', serverId)
      .execute();
  }

  async writePlacementObserved(
    input: {
      volumeId: string;
      serverId: string;
      catalogState: VolumeCatalogState;
      observedGeneration?: number | null;
    },
    executor: VolumeExecutor = this.database,
  ): Promise<void> {
    await executor.updateTable('control.volume_placements')
      .set({
        catalog_state: input.catalogState,
        ...(input.observedGeneration === undefined
          ? {}
          : { observed_generation: input.observedGeneration }),
      })
      .where('volume_id', '=', input.volumeId)
      .where('server_id', '=', input.serverId)
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
}
