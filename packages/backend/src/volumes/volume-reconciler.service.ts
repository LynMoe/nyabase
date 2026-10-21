import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditAction } from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { AuditService } from '../iam/audit.service.js';
import { IncusError, type IncusClientPort } from '../incus/index.js';
import { IntentRepository, type IntentFailure, type IntentRecord } from '../reconcile/intent.repository.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
  ResourceAuthority,
} from '../reconcile/managed-reconciler.js';
import { ReconcilerRegistry } from '../reconcile/reconciler-registry.service.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import {
  VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS,
  ensureSharedCatalogOnServer,
} from './shared-volume-catalog.service.js';
import {
  asBytes,
  blockedResizeFailure,
  classifyCatalogGet,
  createCustomVolume,
  deleteCatalog,
  deleteOrphanVolume,
  destroyRetry,
  destroyRetryFromError,
  isNotFound,
  readVolumeUsage,
  scanNeedsEnsure,
  storageVolumeName,
  updateCustomVolume,
  verifyCustomVolume,
  volumeFailure,
  type StorageVolume,
  type StorageVolumeState,
} from './volume-ops.js';
import {
  VolumeReconcileStore,
  type CatalogRow,
  type VolumeAttachmentRow,
  type VolumeRecord,
  type VolumeRow,
} from './volume-reconcile.store.js';
import {
  decideVolumeResize,
  MANAGED_VOLUME_NAME,
  normalizeObservedVolumeUsage,
} from './volume-rules.js';

type Executor = { server_id: string; pool_name: string };
type ExecutorChoice =
  | { kind: 'retry'; outcome: ReconcileOutcome }
  | { kind: 'executor'; executor: Executor }
  | { kind: 'nothing-to-remove' };

type ScanPool = Awaited<ReturnType<VolumeReconcileStore['listRegisteredPools']>>[number];
type ScanVolume = Awaited<ReturnType<VolumeReconcileStore['listScanVolumes']>>[number];
type ScanPlacement = Awaited<ReturnType<VolumeReconcileStore['listPlacementsOnServer']>>[number];

/** Everything one scan compares: PG volumes and placements against what Incus lists. */
interface ScanInventory {
  pools: ScanPool[];
  rows: ScanVolume[];
  knownNames: Set<string>;
  listedByPool: Map<string, readonly (StorageVolume | string)[]>;
  listedByName: Map<string, StorageVolume | string>;
  placementByVolume: Map<string, ScanPlacement>;
}

/**
 * Drives volume intents against Incus: ensure/resize converge the custom volume
 * on one server, destroy removes it from every catalog. The steps are private
 * methods; the Incus operations are plain functions in volume-ops and all SQL
 * is in the store.
 */
@Injectable()
export class VolumeReconciler implements ManagedReconciler, OnModuleInit {
  readonly resourceType = 'volume' as const;
  private readonly logger = new Logger(VolumeReconciler.name);
  private readonly store: VolumeReconcileStore;

  constructor(
    @Inject(PG_DATABASE) database: Kysely<NyabaseDatabase>,
    intents: IntentRepository,
    private readonly audit: AuditService,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
    private readonly registry: ReconcilerRegistry,
  ) {
    this.store = new VolumeReconcileStore(database, intents, this.logger);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  supports(intent: IntentRecord): boolean {
    return intent.resourceType === this.resourceType;
  }

  needsAttention(volumeId: string): Promise<boolean> {
    return this.store.needsAttention(volumeId);
  }

  markSucceeded(volumeId: string, revision: number): Promise<void> {
    return this.store.markSucceeded(volumeId, revision);
  }

  markFailure(volumeId: string, failure: IntentFailure, attention: boolean): Promise<void> {
    return this.store.markFailure(volumeId, failure, attention);
  }

  resourceAuthorities(volumeIds: readonly string[]): Promise<Map<string, ResourceAuthority>> {
    return this.store.resourceAuthorities(volumeIds);
  }

  async reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome> {
    if (context.intent.kind === 'volume.destroy') {
      return this.reconcileDestroy(context);
    }
    if (context.intent.kind !== 'volume.ensure' && context.intent.kind !== 'volume.resize') {
      return {
        outcome: 'failed',
        failure: volumeFailure('VOLUME_INTENT_UNSUPPORTED', 'Unsupported volume intent kind'),
      };
    }
    if (!context.client) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
    }
    const targetServerId = context.intent.serverId;
    if (!targetServerId) {
      return {
        outcome: 'failed',
        failure: volumeFailure('VOLUME_NOT_FOUND', 'Volume intents require a server id'),
      };
    }
    const volumeExists = await this.store.readVolumeRow(context.intent.resourceId);
    if (!volumeExists) {
      return {
        outcome: 'failed',
        failure: volumeFailure('VOLUME_NOT_FOUND', 'The desired volume no longer exists'),
      };
    }
    if (volumeExists.lifecycle_phase === 'deleting') {
      return destroyRetry(
        'VOLUME_DESTROY_PENDING',
        'Volume destroy is in progress',
        { volumeId: volumeExists.id },
      );
    }
    const row = await this.store.readVolume(context.intent.resourceId, targetServerId);
    if (!row) {
      return {
        outcome: 'failed',
        failure: volumeFailure('VOLUME_NOT_FOUND', 'The desired volume no longer exists'),
      };
    }
    this.logger.log(
      `volume=${row.id} server=${targetServerId} catalog_state=${row.catalog_state} `
      + `phase=${row.lifecycle_phase}`,
    );
    const attachments = await this.store.readAttachments(row.id, row.target_server_id);
    let actual: StorageVolume | undefined;
    try {
      actual = (await context.client.getStorageVolume(
        row.placement_pool_name,
        'custom',
        row.incus_name,
      )).metadata;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    if (!actual) {
      if (context.intent.kind === 'volume.resize' && row.shared_backend_id) {
        return { outcome: 'succeeded', observedRevision: row.revision };
      }
      actual = await this.adoptOrCreate(context, context.client, row);
      if (!actual) {
        const failure = volumeFailure(
          context.intent.attemptCount >= VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS
            ? 'VOLUME_CATALOG_ADOPT_FAILED'
            : 'VOLUME_CATALOG_ADOPT_PENDING',
          context.intent.attemptCount >= VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS
            ? 'Incus did not adopt the existing CephFS directory into this daemon catalog'
            : 'Incus has not adopted the existing CephFS directory into this catalog',
          { volumeId: row.id, serverId: targetServerId },
        );
        return context.intent.attemptCount >= VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS
          ? { outcome: 'failed', failure }
          : { outcome: 'retry', failure };
      }
    }

    return this.alignSizeAndShifted(context, context.client, row, actual, attachments);
  }

  // --- ensure / resize -------------------------------------------------------------

  private async adoptOrCreate(
    context: ReconcileRunContext,
    client: IncusClientPort,
    row: VolumeRow,
  ): Promise<StorageVolume | undefined> {
    await this.auditMutate(
      context.intent,
      'POST',
      `/1.0/storage-pools/${row.placement_pool_name}/volumes`,
      row.incus_name,
    );
    return createCustomVolume(client, row.placement_pool_name, row.incus_name, row.size_bytes);
  }

  /** Bring size and `security.shifted` in line with the desired state, then record the placement as present. */
  private async alignSizeAndShifted(
    context: ReconcileRunContext,
    client: IncusClientPort,
    row: VolumeRow,
    actual: StorageVolume,
    attachments: VolumeAttachmentRow[],
  ): Promise<ReconcileOutcome> {
    const config = { ...(actual.config ?? {}) };
    const attached = attachments.length > 0;
    if (config['security.shifted'] !== 'true') {
      if (attached) {
        return {
          outcome: 'failed',
          failure: volumeFailure(
            'VOLUME_SECURITY_SHIFTED_MISMATCH',
            'An in-use volume is missing security.shifted and cannot be rewritten',
            { volumeId: row.id },
          ),
        };
      }
      config['security.shifted'] = 'true';
    }
    const currentSize = asBytes(config.size);
    const desiredSize = BigInt(row.size_bytes);
    if (currentSize === null) {
      return {
        outcome: 'failed',
        failure: volumeFailure(
          'VOLUME_SIZE_UNREADABLE',
          'Incus did not return a readable volume size',
        ),
      };
    }
    const state: StorageVolumeState = (await client.getStorageVolumeState(
      row.placement_pool_name,
      'custom',
      row.incus_name,
    )).metadata;
    const usedBytes = normalizeObservedVolumeUsage({
      resizeFamily: row.resize_family,
      driver: row.driver,
      usedBytes: asBytes(state.usage?.used) ?? null,
      totalBytes: asBytes(state.usage?.total) ?? null,
      currentSizeBytes: currentSize,
    });
    const decision = decideVolumeResize({
      resizeFamily: row.resize_family,
      currentSizeBytes: currentSize,
      desiredSizeBytes: desiredSize,
      usedBytes,
      attached,
      allConsumersStopped: attachments.every((item) => item.power_intent !== 'running'),
    });
    if (decision.action === 'blocked') {
      const failure = blockedResizeFailure(decision, row.id, desiredSize, usedBytes, attachments);
      if (decision.reason === 'usage_floor' || decision.reason === 'usage_unknown') {
        await this.store.revertImpossibleShrink(row.id, currentSize, usedBytes, failure.code);
      }
      return { outcome: 'failed', failure };
    }
    if (decision.action !== 'none' || config['security.shifted'] !== actual.config?.['security.shifted']) {
      await this.auditMutate(
        context.intent,
        'PUT',
        `/1.0/storage-pools/${row.placement_pool_name}/volumes/custom/${row.incus_name}`,
        row.incus_name,
      );
      await updateCustomVolume(
        client,
        row.placement_pool_name,
        row.incus_name,
        actual,
        config,
        desiredSize,
      );
    }
    const mismatch = await verifyCustomVolume(
      client,
      row.placement_pool_name,
      row.incus_name,
      desiredSize,
    );
    if (mismatch) return mismatch;
    await this.store.recordVerified(row, usedBytes);
    return { outcome: 'succeeded', observedRevision: row.revision };
  }

  // --- destroy -----------------------------------------------------------------------

  private async reconcileDestroy(context: ReconcileRunContext): Promise<ReconcileOutcome> {
    const { store } = this;
    const volume = await store.readVolumeRow(context.intent.resourceId);
    if (!volume) {
      return { outcome: 'succeeded', observedRevision: context.intent.targetRevision };
    }
    if (volume.lifecycle_phase !== 'deleting') {
      return { outcome: 'succeeded', observedRevision: volume.revision };
    }
    if (await store.hasAnyAttachments(volume.id)) {
      return destroyRetry(
        'VOLUME_REQUIRES_UNBIND',
        'The volume cannot be deleted while attachments remain',
        { volumeId: volume.id },
      );
    }
    await store.lockVolumeQuota(volume);

    const catalogs = await store.listCatalogs(volume.id);
    if (!volume.dir_ensured && catalogs.length === 0) {
      await store.finishEmptyTracking(volume.id, 'never_mounted');
      return { outcome: 'succeeded', observedRevision: volume.revision };
    }

    const eligible = await store.listDestroyExecutors(volume);
    if (eligible.length === 0) {
      await store.dropAllPlacements(volume.id);
      await store.finishEmptyTracking(volume.id, 'destroy_executor_gone');
      return { outcome: 'succeeded', observedRevision: volume.revision };
    }

    if (!volume.remove_all_committed) {
      const retry = await this.commitRemoveAll(context, volume, catalogs, eligible);
      if (retry) return retry;
    }

    const stale = await this.purgeStaleCatalogs(volume, catalogs, context);
    if (stale) return stale;
    await store.dropAllPlacements(volume.id);
    await store.finishEmptyTracking(volume.id);
    return { outcome: 'succeeded', observedRevision: volume.revision };
  }

  private async clientFor(
    serverId: string,
    context: ReconcileRunContext,
  ): Promise<IncusClientPort | undefined> {
    if (context.client && context.intent.serverId === serverId) return context.client;
    return this.clients.get(serverId);
  }

  private async deleteCatalogAudited(
    client: IncusClientPort,
    intent: IntentRecord,
    poolName: string,
    incusName: string,
  ): Promise<void> {
    await this.auditMutate(
      intent,
      'DELETE',
      `/1.0/storage-pools/${poolName}/volumes/custom/${incusName}`,
      incusName,
    );
    await deleteCatalog(client, poolName, incusName);
  }

  /**
   * RemoveAll deletes backing data on one executor. Sticky catalogs on other
   * daemons stay as Incus metadata until purged; leftover inventory treats
   * those as run-owned volumes.
   */
  private async purgeStaleCatalogs(
    volume: VolumeRecord,
    catalogs: CatalogRow[],
    context: ReconcileRunContext,
  ): Promise<ReconcileOutcome | null> {
    for (const catalog of catalogs) {
      if (catalog.server_status !== 'online') {
        this.logger.warn(
          `volume=${volume.id} skip catalog purge on ${catalog.server_id} `
          + `status=${catalog.server_status}`,
        );
        continue;
      }
      let client: IncusClientPort | undefined;
      try {
        client = await this.clientFor(catalog.server_id, context);
      } catch (error) {
        return destroyRetryFromError(error, catalog.server_id);
      }
      if (!client) {
        return destroyRetry(
          'SERVER_UNREACHABLE',
          'Destroy cannot reach a catalog Incus',
          { serverId: catalog.server_id },
        );
      }
      const status = await classifyCatalogGet(
        client,
        catalog.pool_name,
        volume.incus_name,
        context.signal,
      );
      if (status === 'error') {
        return destroyRetry(
          'VOLUME_DESTROY_RETRY',
          'Destroy catalog purge GET failed',
          { serverId: catalog.server_id },
        );
      }
      if (status === 'missing') continue;
      try {
        await this.deleteCatalogAudited(client, context.intent, catalog.pool_name, volume.incus_name);
      } catch {
        return destroyRetry(
          'VOLUME_DESTROY_RETRY',
          'Destroy catalog purge was not confirmed with GET 404',
          { serverId: catalog.server_id },
        );
      }
    }
    return null;
  }

  /**
   * A volume that never became a directory is only deleted from a server that
   * actually holds a catalog entry for it: probe every online catalog first.
   */
  private async pickExecutorFromCatalogs(
    context: ReconcileRunContext,
    volume: VolumeRecord,
    catalogs: CatalogRow[],
  ): Promise<ExecutorChoice> {
    const present: CatalogRow[] = [];
    for (const catalog of catalogs.filter((item) => item.server_status === 'online')) {
      let client: IncusClientPort | undefined;
      try {
        client = await this.clientFor(catalog.server_id, context);
      } catch (error) {
        return { kind: 'retry', outcome: destroyRetryFromError(error, catalog.server_id) };
      }
      if (!client) {
        return {
          kind: 'retry',
          outcome: destroyRetry(
            'SERVER_UNREACHABLE',
            'Destroy cannot reach a catalog Incus',
            { serverId: catalog.server_id },
          ),
        };
      }
      const status = await classifyCatalogGet(
        client,
        catalog.pool_name,
        volume.incus_name,
        context.signal,
      );
      if (status === 'error') {
        return {
          kind: 'retry',
          outcome: destroyRetry(
            'VOLUME_DESTROY_RETRY',
            'Destroy tracking GET did not complete with only 200/404',
            { serverId: catalog.server_id },
          ),
        };
      }
      if (status === 'present') present.push(catalog);
    }
    if (present.length === 0) return { kind: 'nothing-to-remove' };
    present.sort((left, right) => left.server_id.localeCompare(right.server_id));
    return { kind: 'executor', executor: present[0]! };
  }

  private async chooseExecutor(
    context: ReconcileRunContext,
    volume: VolumeRecord,
    catalogs: CatalogRow[],
    eligible: Executor[],
  ): Promise<ExecutorChoice> {
    const pin = volume.remove_all_server_id;
    if (pin) {
      const pinned = eligible.find((item) => item.server_id === pin);
      if (pinned) return { kind: 'executor', executor: pinned };
      return {
        kind: 'retry',
        outcome: destroyRetry(
          'VOLUME_DESTROY_RETRY',
          'Pinned destroy executor is unreachable',
          { serverId: pin },
        ),
      };
    }
    if (!volume.dir_ensured && catalogs.length > 0) {
      const choice = await this.pickExecutorFromCatalogs(context, volume, catalogs);
      if (choice.kind === 'executor') {
        await this.store.pinRemoveAllServer(volume.id, choice.executor.server_id);
      }
      return choice;
    }
    const executor = eligible[0]!;
    await this.store.pinRemoveAllServer(volume.id, executor.server_id);
    return { kind: 'executor', executor };
  }

  /** RemoveAll on the executor, confirmed by a GET 404; null once the choice is committed. */
  private async removeAllOnExecutor(
    context: ReconcileRunContext,
    volume: VolumeRecord,
    executor: Executor,
    eligibleCount: number,
  ): Promise<ReconcileOutcome | null> {
    let client: IncusClientPort | undefined;
    try {
      client = await this.clientFor(executor.server_id, context);
    } catch (error) {
      return destroyRetryFromError(error, executor.server_id);
    }
    if (!client) {
      return destroyRetry(
        'SERVER_UNREACHABLE',
        'Destroy cannot reach the pinned executor',
        { serverId: executor.server_id },
      );
    }
    const status = await classifyCatalogGet(
      client,
      executor.pool_name,
      volume.incus_name,
      context.signal,
    );
    if (status === 'error') {
      return destroyRetry(
        'VOLUME_DESTROY_RETRY',
        'Destroy executor GET failed',
        { serverId: executor.server_id },
      );
    }
    if (status === 'missing' && volume.dir_ensured && volume.shared_backend_id) {
      const adopted = await ensureSharedCatalogOnServer(client, {
        poolName: executor.pool_name,
        incusName: volume.incus_name,
        sizeBytes: volume.size_bytes,
      });
      if (adopted === 'missing') {
        return destroyRetry(
          'VOLUME_DESTROY_RETRY',
          'Destroy adopt did not create a catalog',
          { serverId: executor.server_id },
        );
      }
    } else if (status === 'missing' && !volume.dir_ensured) {
      return destroyRetry(
        'VOLUME_DESTROY_RETRY',
        'Destroy must not commit from a single executor 404',
        { serverId: executor.server_id },
      );
    }
    if (status === 'present' || (status === 'missing' && volume.dir_ensured)) {
      try {
        await this.deleteCatalogAudited(client, context.intent, executor.pool_name, volume.incus_name);
      } catch {
        return destroyRetry(
          'VOLUME_DESTROY_RETRY',
          'Destroy RemoveAll was not confirmed with GET 404',
          { serverId: executor.server_id },
        );
      }
    }
    context.lease?.assertOwned();
    await this.store.markRemoveAllCommitted(volume.id, executor.server_id);
    this.logger.log(
      `volume=${volume.id} destroy pin=${executor.server_id} committed=true `
      + `eligible=${eligibleCount} dir_ensured=${volume.dir_ensured}`,
    );
    return null;
  }

  /** Run the RemoveAll commit protocol once; a returned outcome means "retry later". */
  private async commitRemoveAll(
    context: ReconcileRunContext,
    volume: VolumeRecord,
    catalogs: CatalogRow[],
    eligible: Executor[],
  ): Promise<ReconcileOutcome | null> {
    const choice = await this.chooseExecutor(context, volume, catalogs, eligible);
    if (choice.kind === 'retry') return choice.outcome;
    if (choice.kind === 'nothing-to-remove') {
      context.lease?.assertOwned();
      await this.store.markRemoveAllCommitted(volume.id, null);
      return null;
    }
    return this.removeAllOnExecutor(context, volume, choice.executor, eligible.length);
  }

  // --- full scan -----------------------------------------------------------------------

  async scan(serverId: string, client?: IncusClientPort, signal?: AbortSignal): Promise<void> {
    const inventory = await this.loadInventory(serverId, client, signal);
    await this.converge(serverId, client, inventory);
    if (!client) return;
    await this.deleteOrphans(serverId, client, inventory, signal);
  }

  private async loadInventory(
    serverId: string,
    client: IncusClientPort | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ScanInventory> {
    const { store } = this;
    const pools = await store.listRegisteredPools(serverId);
    const shareableBackendIds = [...new Set(
      pools
        .filter((pool) => pool.driver === 'cephfs' && pool.shareable && pool.shared_backend_id)
        .map((pool) => pool.shared_backend_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )];
    const rows = await store.listScanVolumes(serverId, shareableBackendIds);
    const knownNames = await store.listKnownIncusNames();
    const listedByPool = new Map<string, readonly (StorageVolume | string)[]>();
    const listedByName = new Map<string, StorageVolume | string>();
    if (client) {
      for (const pool of pools) {
        const listed = await client.listStorageVolumes(pool.incus_name, 'custom', 1, { signal });
        listedByPool.set(pool.incus_name, listed.metadata);
        for (const volume of listed.metadata) {
          listedByName.set(storageVolumeName(volume), volume);
        }
      }
    }
    const placements = await store.listPlacementsOnServer(serverId);
    const placementByVolume = new Map(placements.map((row) => [row.volume_id, row]));
    return { pools, rows, knownNames, listedByPool, listedByName, placementByVolume };
  }

  /** Refresh `used_bytes` from the live volume state; a vanished volume is not an error. */
  private async observeVolumeUsage(
    client: IncusClientPort,
    pool: ScanPool | undefined,
    row: { id: string; incus_name: string; size_bytes: string | number },
  ): Promise<void> {
    if (!pool) return;
    try {
      const used = await readVolumeUsage(client, pool, row.incus_name, asBytes(row.size_bytes) ?? 0n);
      await this.store.recordObservedUsage(row.id, used);
    } catch (error) {
      if (!isNotFound(error)) {
        this.logger.warn(`volume=${row.id} used_bytes scan failed: ${String(error)}`);
      }
    }
  }

  /** Queue whatever intent each tracked volume on this server still needs. */
  private async converge(
    serverId: string,
    client: IncusClientPort | undefined,
    inventory: ScanInventory,
  ): Promise<void> {
    const { store, logger } = this;
    for (const row of inventory.rows) {
      if (row.lifecycle_phase === 'deleting') {
        await store.enqueueDestroy(row);
        continue;
      }
      const placement = inventory.placementByVolume.get(row.id);
      if (!placement) continue;
      const listed = inventory.listedByName.get(row.incus_name);
      const shared = row.shared_backend_id !== null;
      if (shared && listed === undefined) {
        logger.warn(`dangling_pg volume=${row.id} server=${serverId}`);
        continue;
      }
      if (listed !== undefined && placement.catalog_state === 'present' && client) {
        await this.observeVolumeUsage(
          client,
          inventory.pools.find((pool) => pool.id === placement.pool_id),
          row,
        );
      }
      if (row.needs_attention) {
        continue;
      }
      if (shared) {
        if (listed !== undefined && scanNeedsEnsure(row, listed)) {
          await store.enqueueResize(row, serverId);
        }
        continue;
      }
      if (scanNeedsEnsure(row, listed)) {
        await store.enqueueEnsure(
          row,
          serverId,
          placement.catalog_state === 'present' ? 'ensure_attachment' : 'create',
        );
      }
    }
  }

  /** Delete Incus volumes that follow our naming but that no logical volume owns. */
  private async deleteOrphans(
    serverId: string,
    client: IncusClientPort,
    inventory: ScanInventory,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const placedNames = new Set(
      inventory.rows
        .filter((row) => inventory.placementByVolume.has(row.id))
        .map((row) => row.incus_name),
    );
    for (const pool of inventory.pools) {
      for (const volume of inventory.listedByPool.get(pool.incus_name) ?? []) {
        const name = storageVolumeName(volume);
        if (!MANAGED_VOLUME_NAME.test(name)) continue;
        if (inventory.knownNames.has(name)) {
          if (!placedNames.has(name)) {
            this.logger.warn(
              `Listed ${name} on server ${serverId} has no catalog placement; not deleting`,
            );
          }
          continue;
        }
        if (typeof volume !== 'string' && (volume.used_by ?? []).length > 0) continue;
        await deleteOrphanVolume(client, pool.incus_name, name, signal);
      }
    }
  }

  private async auditMutate(
    intent: IntentRecord,
    method: string,
    path: string,
    instanceName: string,
  ): Promise<void> {
    await this.audit.log(
      intent.requestedBy,
      AuditAction.IncusMutate,
      intent.resourceId,
      intent.resourceType,
      { method, path, instanceName, serverId: intent.serverId, intentId: intent.id },
    );
  }
}
