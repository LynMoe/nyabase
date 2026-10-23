import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditAction } from '@nyabase/common';
import { AuditService } from '../iam/audit.service.js';
import { IncusError, type IncusClientPort } from '../incus/index.js';
import type { IntentFailure, IntentRecord } from '../reconcile/intent.repository.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
  ResourceAuthority,
} from '../reconcile/managed-reconciler.js';
import { intentFailure } from '../reconcile/intent-model.js';
import { failedOutcome } from '../reconcile/managed-reconciler.js';
import { ReconcilerRegistry } from '../reconcile/reconciler-registry.service.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import {
  VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS,
  ensureSharedCatalogOnServer,
} from './shared-volume-catalog.service.js';
import {
  asBytes,
  blockedResizeFailure,
  catalogChangedRetry,
  classifyCatalogGet,
  createCustomVolume,
  deleteCatalog,
  deleteOrphanVolume,
  labelledFor,
  destroyRetry,
  destroyRetryFromError,
  isNotFound,
  readVolumeUsage,
  scanNeedsEnsure,
  storageVolumeName,
  updateCustomVolume,
  verifyCustomVolume,
  type StorageVolume,
  type StorageVolumeState,
  volumeLabels,
  volumeOwnerScope,
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

  constructor(
    private readonly store: VolumeReconcileStore,
    private readonly audit: AuditService,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
    private readonly registry: ReconcilerRegistry,
  ) {}

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
      return failedOutcome('VOLUME_INTENT_UNSUPPORTED', 'Unsupported volume intent kind');
    }
    if (!context.client) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
    }
    const targetServerId = context.intent.serverId;
    if (!targetServerId) {
      return failedOutcome('VOLUME_NOT_FOUND', 'Volume intents require a server id');
    }
    const volumeExists = await this.store.readVolumeRow(context.intent.resourceId);
    if (!volumeExists) {
      return failedOutcome('VOLUME_NOT_FOUND', 'The desired volume no longer exists');
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
      return failedOutcome('VOLUME_NOT_FOUND', 'The desired volume no longer exists');
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
      // A catalog that does not exist holds no size (`recordCatalogMissing`).
      const resizeShared = context.intent.kind === 'volume.resize' && row.shared_backend_id !== null;
      if (!resizeShared) actual = await this.adoptOrCreate(context, context.client, row);
      // A container pass marked the catalog present meanwhile: look again now.
      if (!actual && !(await this.store.recordCatalogMissing(row))) {
        return catalogChangedRetry(row.id, row.target_server_id);
      }
      if (!actual && resizeShared) return { outcome: 'succeeded', observedRevision: row.revision };
      if (!actual) {
        const failure = intentFailure(
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
    return createCustomVolume(
      client,
      row.placement_pool_name,
      row.incus_name,
      row.size_bytes,
      volumeOwnerScope(row),
    );
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
        return failedOutcome(
            'VOLUME_SECURITY_SHIFTED_MISMATCH',
            'An in-use volume is missing security.shifted and cannot be rewritten',
            { volumeId: row.id },
          );
      }
      config['security.shifted'] = 'true';
    }
    // An unmapped volume bypasses the uid shift every attached container relies on.
    const unmapped = config['security.unmapped'] !== undefined;
    delete config['security.unmapped'];
    // The owner labels are what lets a later scan tell our orphans from anyone else's.
    const labels = volumeLabels(volumeOwnerScope(row));
    const unlabelled = Object.entries(labels).some(([key, value]) => config[key] !== value);
    Object.assign(config, labels);
    const currentSize = asBytes(config.size);
    const desiredSize = BigInt(row.size_bytes);
    if (currentSize === null) {
      return failedOutcome(
          'VOLUME_SIZE_UNREADABLE',
          'Incus did not return a readable volume size',
        );
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
      const current = decision.reason === 'usage_floor' || decision.reason === 'usage_unknown'
        ? await this.store.revertImpossibleShrink(row, currentSize, usedBytes, failure.code)
        : await this.store.isCurrentRevision(row.id, row.revision);
      // A resize accepted while this pass ran replaced the size: settle without
      // parking the volume, so the newer intent runs.
      return current ? { outcome: 'failed', failure } : { outcome: 'failed', failure, stale: true };
    }
    if (
      decision.action !== 'none'
      || unmapped
      || unlabelled
      || config['security.shifted'] !== actual.config?.['security.shifted']
    ) {
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
      // An executor that exists but is not online only delays the destroy;
      // finishing now would drop the row, keep the data and free the quota.
      if (await store.hasAnyDestroyExecutor(volume)) {
        return destroyRetry(
          'SERVER_UNREACHABLE',
          'No server that can destroy the volume is online',
          { volumeId: volume.id },
        );
      }
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

  /**
   * GET the volume on one daemon's catalog. Anything but a 200 or a 404 (no
   * client, an unreachable agent, a timeout) retries the whole destroy.
   */
  private async probeCatalog(
    context: ReconcileRunContext,
    catalog: Executor,
    incusName: string,
  ): Promise<{ client: IncusClientPort; status: 'present' | 'missing' } | { retry: ReconcileOutcome }> {
    let client: IncusClientPort | undefined;
    try {
      client = await this.clientFor(catalog.server_id, context);
    } catch (error) {
      return { retry: destroyRetryFromError(error, catalog.server_id) };
    }
    if (!client) {
      const details = { serverId: catalog.server_id };
      return { retry: destroyRetry('SERVER_UNREACHABLE', 'Destroy cannot reach a catalog Incus', details) };
    }
    const status = await classifyCatalogGet(client, catalog.pool_name, incusName, context.signal);
    if (status === 'error') {
      return {
        retry: destroyRetry(
          'VOLUME_DESTROY_RETRY',
          'Destroy catalog GET did not complete with only 200/404',
          { serverId: catalog.server_id },
        ),
      };
    }
    return { client, status };
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
      const probe = await this.probeCatalog(context, catalog, volume.incus_name);
      if ('retry' in probe) return probe.retry;
      if (probe.status === 'missing') continue;
      try {
        await this.deleteCatalogAudited(probe.client, context.intent, catalog.pool_name, volume.incus_name);
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
      const probe = await this.probeCatalog(context, catalog, volume.incus_name);
      if ('retry' in probe) return { kind: 'retry', outcome: probe.retry };
      if (probe.status === 'present') present.push(catalog);
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

  /**
   * RemoveAll on the executor, confirmed by a GET 404; null once the choice is
   * committed. The DELETE and the commit are not atomic (a dropped agent
   * socket, a crash or a lost lease in between), so every step accepts that an
   * earlier pass already removed the volume:
   * - a local volume lives in exactly one daemon's catalog, so a 404 there is
   *   authoritative: the data is gone (an earlier DELETE, or it vanished while
   *   the volume was parked) and the destroy commits;
   * - a shared volume that became a directory is adopted and deleted again, so
   *   a 404 on one executor never leaves backend data behind;
   * - a shared volume that never became a directory was pinned because its
   *   catalog answered 200; a 404 there says nothing about the other catalogs,
   *   so every catalog is probed again, as an unpinned destroy does.
   */
  private async removeAllOnExecutor(
    context: ReconcileRunContext,
    volume: VolumeRecord,
    catalogs: CatalogRow[],
    executor: Executor,
    eligibleCount: number,
    repicked = false,
  ): Promise<ReconcileOutcome | null> {
    const probe = await this.probeCatalog(context, executor, volume.incus_name);
    if ('retry' in probe) return probe.retry;
    const { client, status } = probe;
    if (status === 'missing' && volume.shared_backend_id && !volume.dir_ensured) {
      if (repicked) {
        return destroyRetry(
          'VOLUME_DESTROY_RETRY',
          'Destroy executor catalog vanished while it was being picked',
          { serverId: executor.server_id },
        );
      }
      return this.repickFromCatalogs(context, volume, catalogs, eligibleCount);
    }
    if (status === 'missing' && volume.shared_backend_id) {
      const adopted = await ensureSharedCatalogOnServer(client, {
        poolName: executor.pool_name,
        incusName: volume.incus_name,
        sizeBytes: volume.size_bytes,
        ownerScope: volumeOwnerScope(volume),
      });
      if (adopted === 'missing') {
        return destroyRetry(
          'VOLUME_DESTROY_RETRY',
          'Destroy adopt did not create a catalog',
          { serverId: executor.server_id },
        );
      }
    }
    // A local 404 is already the confirmed absence; DELETE only what is there
    // (or what the shared adopt just put back).
    if (status === 'present' || volume.shared_backend_id) {
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
    return this.commitRemoved(context, volume, executor.server_id, eligibleCount);
  }

  /** The pinned catalog of a never-ensured shared volume is gone: pick again among all catalogs. */
  private async repickFromCatalogs(
    context: ReconcileRunContext,
    volume: VolumeRecord,
    catalogs: CatalogRow[],
    eligibleCount: number,
  ): Promise<ReconcileOutcome | null> {
    const choice = await this.pickExecutorFromCatalogs(context, volume, catalogs);
    if (choice.kind === 'retry') return choice.outcome;
    if (choice.kind === 'nothing-to-remove') {
      return this.commitRemoved(context, volume, null, eligibleCount);
    }
    await this.store.pinRemoveAllServer(volume.id, choice.executor.server_id);
    return this.removeAllOnExecutor(context, volume, catalogs, choice.executor, eligibleCount, true);
  }

  private async commitRemoved(
    context: ReconcileRunContext,
    volume: VolumeRecord,
    executorServerId: string | null,
    eligibleCount: number,
  ): Promise<null> {
    context.lease?.assertOwned();
    await this.store.markRemoveAllCommitted(volume.id, executorServerId);
    this.logger.log(
      `volume=${volume.id} destroy pin=${executorServerId ?? 'none'} committed=true `
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
      return this.commitRemoved(context, volume, null, eligible.length);
    }
    return this.removeAllOnExecutor(context, volume, catalogs, choice.executor, eligible.length);
  }

  // --- full scan -----------------------------------------------------------------------

  async scan(serverId: string, client?: IncusClientPort, signal?: AbortSignal): Promise<void> {
    const inventory = await this.loadInventory(serverId, client, signal);
    await this.store.releaseSettledShrinkReservations(inventory.rows
      .filter((row) => row.shrink_reserved_bytes !== null).map((row) => row.id));
    await this.converge(serverId, client, inventory);
    if (!client) return;
    await this.quarantineOrphans(serverId, client, inventory, signal);
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
    // Incus first, rows second: a row always exists before its volume, so a
    // volume created while the scan runs is never mistaken for an orphan.
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
    const rows = await store.listScanVolumes(serverId, shareableBackendIds);
    const knownNames = await store.listKnownIncusNames();
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
      // A placement that has not caught up keeps a shrink reserved; a pass
      // verifies it or records its catalog missing (`recordCatalogMissing`).
      const holdsReservation = row.shrink_reserved_bytes !== null
        && placement.observed_revision !== row.revision;
      if (shared && listed === undefined) {
        logger.warn(`dangling_pg volume=${row.id} server=${serverId}`);
        if (client && holdsReservation && !row.needs_attention) {
          await store.enqueueResize(row, serverId);
        }
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
        if (listed !== undefined && (holdsReservation || scanNeedsEnsure(row, listed))) {
          await store.enqueueResize(row, serverId);
        }
        continue;
      }
      if (holdsReservation || scanNeedsEnsure(row, listed)) {
        await store.enqueueEnsure(
          row,
          serverId,
          placement.catalog_state === 'present' ? 'ensure_attachment' : 'create',
        );
      }
    }
  }

  /**
   * Incus volumes labelled as ours (this server, or this pool's shared
   * backend) that no logical volume owns and nothing uses are quarantined:
   * deleted only once the ledger has seen them for the whole quarantine.
   */
  private async quarantineOrphans(
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
    const orphans: Array<{ poolName: string; name: string }> = [];
    for (const pool of inventory.pools) {
      const scopes = new Set([serverId, pool.shared_backend_id].filter(
        (scope): scope is string => typeof scope === 'string',
      ).map((scope) => scope.toLowerCase()));
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
        if (!labelledFor(volume, scopes)) continue;
        orphans.push({ poolName: pool.incus_name, name });
      }
    }
    const { fresh, due } = await this.store.orphans.sight(serverId, 'volume', orphans);
    for (const orphan of fresh) {
      this.logger.warn(
        `Orphan volume ${orphan.poolName}/${orphan.name} on server ${serverId} has no volume row; `
        + 'deleting it after the quarantine',
      );
    }
    for (const orphan of due) {
      try {
        await deleteOrphanVolume(client, orphan.poolName, orphan.name, signal);
        await this.store.orphans.forget(serverId, 'volume', orphan);
        this.logger.warn(`Deleted orphan volume ${orphan.poolName}/${orphan.name} on server ${serverId}`);
      } catch (error) {
        this.logger.warn(`Orphan volume ${orphan.poolName}/${orphan.name} on server ${serverId}: ${String(error)}`);
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
