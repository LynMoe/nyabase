import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { IncusError } from '../incus/index.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { OrphanSightingsStore } from '../reconcile/orphan-sightings.store.js';
import { IntentRepository, type IntentFailure } from '../reconcile/intent.repository.js';
import type { ResourceAuthority } from '../reconcile/managed-reconciler.js';
import type { VolumeDriver } from './volume-rules.js';
import { ensureVolumeIntent, listEligibleDestroyExecutors } from './volumes.repository.js';

export interface VolumeRecord {
  id: string;
  pool_id: string | null;
  server_id: string | null;
  shared_backend_id: string | null;
  incus_name: string;
  size_bytes: string;
  used_bytes: string | null;
  revision: number;
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  needs_attention: boolean;
  dir_ensured: boolean;
  remove_all_committed: boolean;
  remove_all_server_id: string | null;
}

export interface VolumeRow extends VolumeRecord {
  driver: VolumeDriver;
  resize_family: 'quota_online' | 'block_backed';
  block_filesystem: string | null;
  target_server_id: string;
  catalog_state: 'ensuring' | 'present';
  placement_pool_id: string;
  placement_pool_name: string;
}

export interface VolumeAttachmentRow {
  id: string;
  container_id: string;
  power_intent: 'running' | 'stopped';
}

export interface CatalogRow {
  server_id: string;
  pool_id: string;
  pool_name: string;
  catalog_state: 'ensuring' | 'present';
  server_status: 'online' | 'unreachable' | 'unknown';
}

/** Every SQL statement the volume reconciler issues; the Incus-facing logic never touches Kysely. */
@Injectable()
export class VolumeReconcileStore {
  private readonly logger = new Logger(VolumeReconcileStore.name);
  /** Quarantine ledger of volumes no row owns (full scan). */
  readonly orphans: OrphanSightingsStore;

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly intents: IntentRepository,
  ) {
    this.orphans = new OrphanSightingsStore(database);
  }

  // --- ManagedReconciler state -------------------------------------------------

  async needsAttention(volumeId: string): Promise<boolean> {
    const row = await this.database
      .selectFrom('control.volumes')
      .select(['needs_attention', 'lifecycle_phase'])
      .where('id', '=', volumeId)
      .executeTakeFirst();
    return row?.needs_attention === true && row.lifecycle_phase !== 'deleting';
  }

  /**
   * One placement's success clears the volume's failure only once the volume
   * is reconciled as a whole, as `recordVerified` decides: this is still its
   * revision and every placement has observed it. Otherwise an intent that
   * finishes on one server would hide a failure another placement just
   * recorded. A parked volume is released by a retry or the next edit anyway.
   */
  async markSucceeded(volumeId: string, revision: number): Promise<void> {
    await this.database
      .updateTable('control.volumes')
      .set({
        observed_revision: revision,
        needs_attention: false,
        failure_code: null,
      })
      .where('id', '=', volumeId)
      .where('revision', '=', revision)
      .where('lifecycle_phase', '!=', 'deleting')
      .where(({ exists, not, selectFrom }) => not(exists(
        selectFrom('control.volume_placements')
          .select('server_id')
          .where('volume_id', '=', volumeId)
          .where((expression) => expression.or([
            expression('catalog_state', '!=', 'present'),
            expression('observed_revision', 'is', null),
            expression('observed_revision', '!=', revision),
          ])),
      )))
      .execute();
  }

  async markFailure(volumeId: string, failure: IntentFailure, _attention: boolean): Promise<void> {
    const code = failure.code.slice(0, 128);
    const current = await this.database
      .selectFrom('control.volumes')
      .select('lifecycle_phase')
      .where('id', '=', volumeId)
      .executeTakeFirst();
    if (current?.lifecycle_phase === 'deleting') {
      await this.database
        .updateTable('control.volumes')
        .set({ failure_code: code })
        .where('id', '=', volumeId)
        .where('lifecycle_phase', '=', 'deleting')
        .execute();
      return;
    }
    // A failed shrink/ensure must surface on the volume card too, so the
    // resource is flagged either way. Parking never changes the phase: the
    // volume still exists (and stays attached), so it keeps counting against
    // quota, and a user retry or the next desired-state edit releases it.
    await this.database
      .updateTable('control.volumes')
      .set({ needs_attention: true, failure_code: code })
      .where('id', '=', volumeId)
      .where('lifecycle_phase', '!=', 'deleting')
      .execute();
  }

  async resourceAuthorities(
    volumeIds: readonly string[],
  ): Promise<Map<string, ResourceAuthority>> {
    const rows = volumeIds.length === 0
      ? []
      : await this.database
        .selectFrom('control.volumes')
        .select(['id', 'owner_id'])
        .where('id', 'in', volumeIds)
        .execute();
    // A deleted volume has no entry (see ResourceAuthority).
    return new Map(rows.map((row) => [row.id, { ownerId: row.owner_id }]));
  }

  // --- full scan ---------------------------------------------------------------

  listRegisteredPools(serverId: string) {
    return this.database
      .selectFrom('infra.storage_pools')
      .select(['id', 'incus_name', 'shared_backend_id', 'server_id', 'registered', 'driver', 'shareable', 'resize_family'])
      .where('server_id', '=', serverId)
      .where('registered', '=', true)
      .execute();
  }

  /** Volumes that live on the server, or sit on a shareable backend it can reach. */
  listScanVolumes(serverId: string, shareableBackendIds: readonly string[]) {
    return this.database
      .selectFrom('control.volumes as v')
      .select([
        'v.id as id',
        'v.revision as revision',
        'v.server_id as server_id',
        'v.shared_backend_id as shared_backend_id',
        'v.lifecycle_phase as lifecycle_phase',
        'v.needs_attention as needs_attention',
        'v.incus_name as incus_name',
        'v.size_bytes as size_bytes',
        'v.pool_id as pool_id',
      ])
      .where((expression) => {
        const clauses = [expression('v.server_id', '=', serverId)];
        if (shareableBackendIds.length > 0) {
          clauses.push(expression('v.shared_backend_id', 'in', [...shareableBackendIds]));
        }
        return expression.or(clauses);
      })
      .execute();
  }

  async listKnownIncusNames(): Promise<Set<string>> {
    const rows = await this.database.selectFrom('control.volumes').select('incus_name').execute();
    return new Set(rows.map((row) => row.incus_name));
  }

  listPlacementsOnServer(serverId: string) {
    return this.database
      .selectFrom('control.volume_placements')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute();
  }

  async recordObservedUsage(volumeId: string, usedBytes: bigint | null): Promise<void> {
    await this.database
      .updateTable('control.volumes')
      .set({ used_bytes: usedBytes === null ? null : usedBytes.toString() })
      .where('id', '=', volumeId)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .execute();
  }

  async enqueueResize(row: { id: string; revision: number }, serverId: string): Promise<void> {
    await ensureVolumeIntent(this.intents, {
      kind: 'volume.resize',
      resourceType: 'volume',
      resourceId: row.id,
      serverId,
      targetRevision: row.revision,
      reuseSettled: false,
      request: { source: 'full_scan', operation: 'resize', idempotencyKey: 'resize' },
    }, this.database);
  }

  async enqueueEnsure(
    row: { id: string; revision: number },
    serverId: string,
    operation: 'create' | 'ensure_attachment',
  ): Promise<void> {
    await ensureVolumeIntent(this.intents, {
      kind: 'volume.ensure',
      resourceType: 'volume',
      resourceId: row.id,
      serverId,
      targetRevision: row.revision,
      reuseSettled: false,
      request: { source: 'full_scan', operation, idempotencyKey: operation },
    }, this.database);
  }

  async enqueueDestroy(row: { id: string; revision: number }): Promise<void> {
    await ensureVolumeIntent(this.intents, {
      kind: 'volume.destroy',
      resourceType: 'volume',
      resourceId: row.id,
      targetRevision: row.revision,
      reuseSettled: false,
      request: { source: 'full_scan', operation: 'destroy', idempotencyKey: 'destroy' },
    }, this.database);
  }

  // --- ensure / resize ---------------------------------------------------------

  async readVolumeRow(volumeId: string): Promise<VolumeRecord | undefined> {
    const volume = await this.database
      .selectFrom('control.volumes')
      .select([
        'id',
        'pool_id',
        'server_id',
        'shared_backend_id',
        'incus_name',
        'size_bytes',
        'used_bytes',
        'revision',
        'lifecycle_phase',
        'needs_attention',
        'dir_ensured',
        'remove_all_committed',
        'remove_all_server_id',
      ])
      .where('id', '=', volumeId)
      .executeTakeFirst();
    if (!volume) return undefined;
    return {
      ...volume,
      size_bytes: String(volume.size_bytes),
      used_bytes: volume.used_bytes === null || volume.used_bytes === undefined
        ? null
        : String(volume.used_bytes),
    };
  }

  /** The volume together with its placement (pool and catalog state) on the intent's server. */
  async readVolume(volumeId: string, intentServerId: string): Promise<VolumeRow | undefined> {
    const volume = await this.readVolumeRow(volumeId);
    if (!volume) return undefined;
    const placement = await this.database
      .selectFrom('control.volume_placements as pl')
      .innerJoin('infra.storage_pools as pp', 'pp.id', 'pl.pool_id')
      .select([
        'pl.catalog_state as catalog_state',
        'pl.pool_id as placement_pool_id',
        'pp.incus_name as placement_pool_name',
        'pp.driver as driver',
        'pp.resize_family as resize_family',
        'pp.block_filesystem as block_filesystem',
      ])
      .where('pl.volume_id', '=', volumeId)
      .where('pl.server_id', '=', intentServerId)
      .executeTakeFirst();
    if (!placement) return undefined;
    if (!volume.shared_backend_id && volume.server_id !== intentServerId) {
      throw new IncusError('MISSING_STORAGE_POOL', 'managed_failure', {
        poolId: volume.pool_id ?? '',
        serverId: intentServerId,
      });
    }
    return {
      ...volume,
      driver: placement.driver,
      resize_family: placement.resize_family,
      block_filesystem: placement.block_filesystem,
      target_server_id: intentServerId,
      catalog_state: placement.catalog_state,
      placement_pool_id: placement.placement_pool_id,
      placement_pool_name: placement.placement_pool_name,
    };
  }

  readAttachments(volumeId: string, serverId: string): Promise<VolumeAttachmentRow[]> {
    return this.database
      .selectFrom('control.volume_attachments as a')
      .innerJoin('control.containers as c', 'c.id', 'a.container_id')
      .select([
        'a.id as id',
        'a.container_id as container_id',
        'c.power_intent as power_intent',
      ])
      .where('a.volume_id', '=', volumeId)
      .where('c.server_id', '=', serverId)
      .execute();
  }

  /**
   * Undo a shrink the volume's usage blocks: the desired size goes back to
   * what Incus holds (within the reservation the shrink kept, so no grant or
   * capacity is exceeded) and the volume is parked. Only for the revision the
   * pass reconciled: a resize accepted meanwhile is never overwritten. Returns
   * false when that revision is no longer current.
   */
  async revertImpossibleShrink(
    row: Pick<VolumeRecord, 'id' | 'revision'>,
    actualSizeBytes: bigint,
    usedBytes: bigint | null,
    failureCode: string,
  ): Promise<boolean> {
    const result = await this.database
      .updateTable('control.volumes')
      .set({
        size_bytes: actualSizeBytes.toString(),
        shrink_reserved_bytes: null,
        used_bytes: usedBytes === null ? null : usedBytes.toString(),
        needs_attention: true,
        failure_code: failureCode.slice(0, 128),
      })
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .where('lifecycle_phase', 'not in', ['deleting', 'failed'])
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Whether `revision` is still the volume's desired revision. */
  async isCurrentRevision(volumeId: string, revision: number): Promise<boolean> {
    const row = await this.database
      .selectFrom('control.volumes')
      .select('id')
      .where('id', '=', volumeId)
      .where('revision', '=', revision)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The placement on the intent's server is now verified. When every placement
   * has caught up the volume itself becomes observed (and active), and a
   * shrink's reservation is released: Incus now holds the desired size.
   */
  async recordVerified(row: VolumeRow, usedBytes: bigint | null): Promise<void> {
    await this.database
      .updateTable('control.volume_placements')
      .set({
        catalog_state: 'present',
        observed_revision: row.revision,
      })
      .where('volume_id', '=', row.id)
      .where('server_id', '=', row.target_server_id)
      .execute();
    await this.database
      .updateTable('control.volumes')
      .set({ dir_ensured: true })
      .where('id', '=', row.id)
      .execute();
    const lagging = await this.database
      .selectFrom('control.volume_placements')
      .select('server_id')
      .where('volume_id', '=', row.id)
      .where((expression) => expression.or([
        expression('catalog_state', '!=', 'present'),
        expression('observed_revision', 'is', null),
        expression('observed_revision', '!=', row.revision),
      ]))
      .executeTakeFirst();
    const usedBytesUpdate = usedBytes === null
      ? {}
      : {
        used_bytes: sql<string>`case
          when used_bytes is null then ${usedBytes.toString()}::bigint
          else greatest(used_bytes, ${usedBytes.toString()}::bigint)
        end`,
      };
    if (!lagging) {
      await this.database
        .updateTable('control.volumes')
        .set({
          observed_revision: row.revision,
          lifecycle_phase: row.lifecycle_phase === 'provisioning' ? 'active' : row.lifecycle_phase,
          shrink_reserved_bytes: null,
          ...usedBytesUpdate,
          failure_code: null,
          needs_attention: false,
        })
        .where('id', '=', row.id)
        .where('revision', '=', row.revision)
        .where('lifecycle_phase', 'not in', ['deleting', 'failed'])
        .execute();
    } else if (usedBytes !== null) {
      await this.database
        .updateTable('control.volumes')
        .set(usedBytesUpdate)
        .where('id', '=', row.id)
        .where('lifecycle_phase', 'not in', ['deleting', 'failed'])
        .execute();
    }
  }

  // --- destroy -----------------------------------------------------------------

  async hasAnyAttachments(volumeId: string): Promise<boolean> {
    const row = await this.database
      .selectFrom('control.volume_attachments')
      .select('id')
      .where('volume_id', '=', volumeId)
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }

  listCatalogs(volumeId: string): Promise<CatalogRow[]> {
    return this.database
      .selectFrom('control.volume_placements as pl')
      .innerJoin('infra.storage_pools as pp', 'pp.id', 'pl.pool_id')
      .innerJoin('infra.servers as s', 's.id', 'pl.server_id')
      .select([
        'pl.server_id as server_id',
        'pl.pool_id as pool_id',
        'pl.catalog_state as catalog_state',
        'pp.incus_name as pool_name',
        's.status as server_status',
      ])
      .where('pl.volume_id', '=', volumeId)
      .orderBy('pl.server_id', 'asc')
      .execute();
  }

  async markRemoveAllCommitted(volumeId: string, executorServerId: string | null): Promise<void> {
    await this.database
      .updateTable('control.volumes')
      .set({
        remove_all_committed: true,
        remove_all_server_id: executorServerId,
      })
      .where('id', '=', volumeId)
      .where('lifecycle_phase', '=', 'deleting')
      .execute();
  }

  async pinRemoveAllServer(volumeId: string, serverId: string): Promise<void> {
    await this.database
      .updateTable('control.volumes')
      .set({ remove_all_server_id: serverId })
      .where('id', '=', volumeId)
      .where('lifecycle_phase', '=', 'deleting')
      .where('remove_all_committed', '=', false)
      .execute();
  }

  async dropAllPlacements(volumeId: string): Promise<void> {
    await this.database
      .deleteFrom('control.volume_placements')
      .where('volume_id', '=', volumeId)
      .execute();
  }

  async lockVolumeQuota(volume: VolumeRecord): Promise<void> {
    if (volume.server_id && volume.pool_id) {
      await this.database
        .selectFrom('infra.storage_pools')
        .select('id')
        .where('id', '=', volume.pool_id)
        .forUpdate()
        .executeTakeFirst();
      return;
    }
    if (volume.shared_backend_id) {
      await this.database
        .selectFrom('infra.shared_backends')
        .select('id')
        .where('id', '=', volume.shared_backend_id)
        .forUpdate()
        .executeTakeFirst();
    }
  }

  async listDestroyExecutors(
    volume: VolumeRecord,
  ): Promise<Array<{ server_id: string; pool_name: string }>> {
    if (volume.shared_backend_id) {
      const rows = await listEligibleDestroyExecutors(this.database, volume.shared_backend_id);
      return rows.map((row) => ({ server_id: row.server_id, pool_name: row.pool_name }));
    }
    if (!volume.server_id) return [];
    const server = await this.database
      .selectFrom('infra.servers')
      .select(['id', 'status'])
      .where('id', '=', volume.server_id)
      .executeTakeFirst();
    if (!server || server.status !== 'online') return [];
    const pool = volume.pool_id
      ? await this.database
        .selectFrom('infra.storage_pools')
        .select('incus_name')
        .where('id', '=', volume.pool_id)
        .executeTakeFirst()
      : undefined;
    if (!pool) return [];
    return [{ server_id: volume.server_id, pool_name: pool.incus_name }];
  }

  /**
   * Whether anything could still destroy the data, online or not: the shared
   * backend still has an executor pool, or the local volume's server and pool
   * still exist. Only when nothing does is the destroy executor gone.
   */
  async hasAnyDestroyExecutor(volume: VolumeRecord): Promise<boolean> {
    if (volume.shared_backend_id) {
      const rows = await listEligibleDestroyExecutors(this.database, volume.shared_backend_id, {
        includeOffline: true,
      });
      return rows.length > 0;
    }
    if (!volume.server_id || !volume.pool_id) return false;
    const pool = await this.database
      .selectFrom('infra.storage_pools')
      .select('id')
      .where('id', '=', volume.pool_id)
      .where('server_id', '=', volume.server_id)
      .executeTakeFirst();
    return pool !== undefined;
  }

  /** Drop the logical volume once nothing tracks it any more, settling leftover intents. */
  async finishEmptyTracking(volumeId: string, reason?: string): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const volume = await transaction
        .selectFrom('control.volumes')
        .select(['id', 'lifecycle_phase'])
        .where('id', '=', volumeId)
        .forUpdate()
        .executeTakeFirst();
      if (!volume) return;
      const remaining = await transaction
        .selectFrom('control.volume_placements')
        .select('server_id')
        .where('volume_id', '=', volumeId)
        .executeTakeFirst();
      if (remaining) return;
      const pending = await transaction
        .selectFrom('control.intents')
        .select('id')
        .where('resource_type', '=', 'volume')
        .where('resource_id', '=', volumeId)
        .where('status', '=', 'pending')
        .execute();
      for (const row of pending) {
        await this.intents.settleOne(row.id, { outcome: 'succeeded' }, transaction);
      }
      await transaction.deleteFrom('control.volumes').where('id', '=', volumeId).execute();
      this.logger.log(
        `Deleted logical volume ${volumeId} after empty tracking`
        + (reason ? ` reason=${reason}` : ''),
      );
    });
  }
}
