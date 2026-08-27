import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';

export type VolumeExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

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
    poolId: string;
    serverId: string | null;
    sharedBackendId: string | null;
    name: string;
    incusName: string;
    sizeBytes: number;
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
        lifecycle_phase: 'provisioning',
        needs_attention: false,
        failure_code: null,
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
        detach_drained_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  deleteAttachment(id: string, executor: VolumeExecutor) {
    return executor
      .deleteFrom('control.volume_attachments')
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  findDetachDrain(volumeId: string, executor: VolumeExecutor = this.database) {
    return executor.selectFrom('control.volume_detach_drains')
      .selectAll()
      .where('volume_id', '=', volumeId)
      .executeTakeFirst();
  }

  async setDetachDrain(
    volumeId: string,
    drainedAt: Date,
    executor: VolumeExecutor,
  ): Promise<void> {
    await executor.insertInto('control.volume_detach_drains')
      .values({
        volume_id: volumeId,
        drained_at: drainedAt,
        created_at: new Date(),
      })
      .onConflict((conflict) => conflict
        .column('volume_id')
        .doUpdateSet({ drained_at: drainedAt }))
      .execute();
  }

  async clearExpiredDetachDrain(
    volumeId: string,
    now: Date,
    executor: VolumeExecutor = this.database,
  ): Promise<void> {
    await executor.deleteFrom('control.volume_detach_drains')
      .where('volume_id', '=', volumeId)
      .where('drained_at', '<=', now)
      .execute();
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

  listDesiredPlacements(volumeId: string, executor: VolumeExecutor = this.database) {
    return executor.selectFrom('control.volume_placements')
      .selectAll()
      .where('volume_id', '=', volumeId)
      .where('desired_present', '=', true)
      .execute();
  }

  async upsertPlacement(
    input: {
      volumeId: string;
      serverId: string;
      poolId: string;
      desiredPresent: boolean;
    },
    executor: VolumeExecutor,
  ): Promise<void> {
    await executor.insertInto('control.volume_placements')
      .values({
        volume_id: input.volumeId,
        server_id: input.serverId,
        pool_id: input.poolId,
        desired_present: input.desiredPresent,
        observed_present: false,
        observed_generation: null,
        unused_confirmed_at: null,
      })
      .onConflict((conflict) => conflict
        .columns(['volume_id', 'server_id'])
        .doUpdateSet({
          pool_id: input.poolId,
          desired_present: input.desiredPresent,
        }))
      .execute();
  }

  async setDesiredPresent(
    volumeId: string,
    serverId: string,
    desiredPresent: boolean,
    executor: VolumeExecutor,
  ): Promise<void> {
    await executor.updateTable('control.volume_placements')
      .set({ desired_present: desiredPresent })
      .where('volume_id', '=', volumeId)
      .where('server_id', '=', serverId)
      .execute();
  }

  async setAllDesiredPresent(
    volumeId: string,
    desiredPresent: boolean,
    executor: VolumeExecutor,
  ): Promise<void> {
    await executor.updateTable('control.volume_placements')
      .set({ desired_present: desiredPresent })
      .where('volume_id', '=', volumeId)
      .execute();
  }

  async stampUnusedConfirmed(
    volumeId: string,
    serverId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<void> {
    await executor.updateTable('control.volume_placements')
      .set({ unused_confirmed_at: new Date() })
      .where('volume_id', '=', volumeId)
      .where('server_id', '=', serverId)
      .where('unused_confirmed_at', 'is', null)
      .execute();
  }

  async writePlacementObserved(
    input: {
      volumeId: string;
      serverId: string;
      observedPresent: boolean;
      observedGeneration?: number | null;
    },
    executor: VolumeExecutor = this.database,
  ): Promise<void> {
    await executor.updateTable('control.volume_placements')
      .set({
        observed_present: input.observedPresent,
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

  async deleteVolumeRow(volumeId: string, executor: VolumeExecutor): Promise<void> {
    await executor.deleteFrom('control.volumes').where('id', '=', volumeId).execute();
  }

  async liveAttachmentServerIds(
    volumeId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<string[]> {
    const rows = await executor
      .selectFrom('control.volume_attachments as a')
      .innerJoin('control.containers as c', 'c.id', 'a.container_id')
      .select('c.server_id as server_id')
      .where('a.volume_id', '=', volumeId)
      .where('a.detach_drained_at', 'is', null)
      .where('c.lifecycle_phase', 'not in', ['failed', 'deleting'])
      .execute();
    return [...new Set(rows.map((row) => row.server_id))];
  }
}
