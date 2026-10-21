import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditAction, Capability } from '@nyabase/common';
import { Kysely, sql } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { AuditService } from '../iam/audit.service.js';
import {
  IncusError,
  isAlreadyExistsError,
  requestAndWait,
  readAfterTimeout,
  type IncusClientPort,
  type IncusSchema,
} from '../incus/index.js';
import { IntentRepository, type IntentFailure, type IntentRecord } from '../reconcile/intent.repository.js';
import { ensureVolumeIntent } from './volume-intents.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
  ResourceAuthority,
} from '../reconcile/managed-reconciler.js';
import { ReconcilerRegistry } from '../reconcile/reconciler-registry.service.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import { listEligibleDestroyExecutors } from './eligible-destroy-executors.js';
import { ensureSharedCatalogOnServer } from './shared-catalog.js';

type StorageVolume = IncusSchema<'StorageVolume'>;
type StorageVolumeState = IncusSchema<'StorageVolumeState'>;

export interface VolumeResizeInput {
  readonly resizeFamily: 'quota_online' | 'block_backed';
  readonly currentSizeBytes: bigint;
  readonly desiredSizeBytes: bigint;
  readonly usedBytes: bigint | null;
  readonly attached: boolean;
  readonly allConsumersStopped: boolean;
}

export type VolumeResizeDecision =
  | { readonly action: 'none' | 'grow' | 'shrink'; readonly reason?: undefined }
  | { readonly action: 'blocked'; readonly reason: 'usage_floor' | 'usage_unknown' | 'detach' | 'stop' };

export function decideVolumeResize(input: VolumeResizeInput): VolumeResizeDecision {
  if (input.desiredSizeBytes === input.currentSizeBytes) return { action: 'none' };
  if (input.desiredSizeBytes > input.currentSizeBytes) return { action: 'grow' };
  if (input.resizeFamily === 'quota_online' && input.usedBytes === null) {
    return { action: 'blocked', reason: 'usage_unknown' };
  }
  if (
    input.usedBytes !== null
    && input.desiredSizeBytes < input.usedBytes
  ) {
    return { action: 'blocked', reason: 'usage_floor' };
  }
  if (input.resizeFamily === 'block_backed' && input.attached) {
    return { action: 'blocked', reason: 'detach' };
  }
  if (input.resizeFamily === 'block_backed' && !input.allConsumersStopped) {
    return { action: 'blocked', reason: 'stop' };
  }
  return { action: 'shrink' };
}

/** CephFS Incus echoes `used === size` with total missing for both empty and full. */
export function isPhantomCephfsUsage(
  usedBytes: bigint | null,
  totalBytes: bigint | null,
  currentSizeBytes: bigint,
): boolean {
  if (usedBytes === null) return false;
  const totalMissing = totalBytes === null || totalBytes === 0n;
  return totalMissing && usedBytes >= currentSizeBytes;
}

/**
 * CephFS `used === size` with total missing cannot tell empty from full, so
 * that shape is unknown. Dir/btrfs/zfs keep occupancy, including used===size.
 */
export function normalizeObservedVolumeUsage(input: {
  readonly resizeFamily: 'quota_online' | 'block_backed';
  readonly driver: VolumeRow['driver'];
  readonly usedBytes: bigint | null;
  readonly totalBytes: bigint | null;
  readonly currentSizeBytes: bigint;
}): bigint | null {
  if (input.usedBytes === null) {
    // Empty dir/btrfs/zfs quota volumes report `{ total: 0 }` without `used`.
    if (
      input.resizeFamily === 'quota_online'
      && input.driver !== 'cephfs'
      && input.totalBytes === 0n
    ) {
      return 0n;
    }
    return null;
  }
  if (input.driver !== 'cephfs') return input.usedBytes;
  if (isPhantomCephfsUsage(input.usedBytes, input.totalBytes, input.currentSizeBytes)) {
    return null;
  }
  return input.usedBytes;
}

interface VolumeRecord {
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

interface VolumeRow extends VolumeRecord {
  driver: 'dir' | 'btrfs' | 'zfs' | 'lvm' | 'lvmcluster' | 'ceph' | 'cephfs';
  resize_family: 'quota_online' | 'block_backed';
  block_filesystem: string | null;
  target_server_id: string;
  catalog_state: 'ensuring' | 'present';
  placement_pool_id: string;
  placement_pool_name: string;
}

interface VolumeAttachmentRow {
  id: string;
  container_id: string;
  power_intent: 'running' | 'stopped';
}

interface CatalogRow {
  server_id: string;
  pool_id: string;
  pool_name: string;
  catalog_state: 'ensuring' | 'present';
  server_status: 'online' | 'unreachable' | 'unknown';
}

type CatalogGetStatus = 'present' | 'missing' | 'error';

function isNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

function asBytes(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value !== 'string') return null;
  const match = /^([0-9]+)(?:\s*)(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i.exec(value.trim());
  if (!match) return null;
  const unit = (match[2] ?? 'b').toLowerCase();
  const multipliers: Record<string, bigint> = {
    b: 1n,
    kb: 1000n,
    kib: 1024n,
    mb: 1000n ** 2n,
    mib: 1024n ** 2n,
    gb: 1000n ** 3n,
    gib: 1024n ** 3n,
    tb: 1000n ** 4n,
    tib: 1024n ** 4n,
  };
  return BigInt(match[1]) * multipliers[unit];
}

function volumeFailure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): IntentFailure {
  return { code, message, details };
}

function destroyRetry(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ReconcileOutcome {
  return {
    outcome: 'retry',
    failure: volumeFailure(code, message, details),
  };
}

async function auditIncusMutate(
  audit: AuditService,
  intent: IntentRecord,
  detail: {
    readonly method: string;
    readonly path: string;
    readonly instanceName?: string;
  },
): Promise<void> {
  await audit.log(
    intent.requestedBy,
    AuditAction.IncusMutate,
    intent.resourceId,
    intent.resourceType,
    {
      method: detail.method,
      path: detail.path,
      instanceName: detail.instanceName,
      serverId: intent.serverId,
      intentId: intent.id,
    },
  );
}

/** Attempts after which a volume adoption that keeps failing is given up on. */
export const VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS = 8;

@Injectable()
export class VolumeReconciler implements ManagedReconciler, OnModuleInit {
  readonly resourceType = 'volume' as const;
  private readonly logger = new Logger(VolumeReconciler.name);

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly intents: IntentRepository,
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

  async needsAttention(volumeId: string): Promise<boolean> {
    const row = await this.database
      .selectFrom('control.volumes')
      .select(['needs_attention', 'lifecycle_phase'])
      .where('id', '=', volumeId)
      .executeTakeFirst();
    return row?.needs_attention === true && row.lifecycle_phase !== 'deleting';
  }

  async markSucceeded(volumeId: string, revision: number): Promise<void> {
    await this.database
      .updateTable('control.volumes')
      .set({
        observed_revision: revision,
        needs_attention: false,
        failure_code: null,
      })
      .where('id', '=', volumeId)
      .where('lifecycle_phase', '!=', 'deleting')
      .execute();
  }

  async markFailure(
    volumeId: string,
    failure: IntentFailure,
    attention: boolean,
  ): Promise<void> {
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
    // resource is flagged either way; only a parked failure also fails the phase.
    const values = {
      needs_attention: true,
      failure_code: code,
      ...(attention ? { lifecycle_phase: 'failed' as const } : {}),
    };
    await this.database
      .updateTable('control.volumes')
      .set(values)
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
        .select(['id', 'owner_id', 'shared_backend_id'])
        .where('id', 'in', volumeIds)
        .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return new Map(volumeIds.map((id) => {
      const row = byId.get(id);
      return [id, {
        ownerId: row?.owner_id ?? null,
        adminCapability: row?.shared_backend_id != null
          ? Capability.ManageSharedVolumes
          : Capability.ManageVolumes,
      }];
    }));
  }

  async scan(serverId: string, client?: IncusClientPort, signal?: AbortSignal): Promise<void> {
    const pools = await this.database
      .selectFrom('infra.storage_pools')
      .select(['id', 'incus_name', 'shared_backend_id', 'server_id', 'registered', 'driver', 'shareable', 'resize_family'])
      .where('server_id', '=', serverId)
      .where('registered', '=', true)
      .execute();
    const shareableBackendIds = [...new Set(
      pools
        .filter((pool) => pool.driver === 'cephfs' && pool.shareable && pool.shared_backend_id)
        .map((pool) => pool.shared_backend_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )];
    let volumeQuery = this.database
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
      ]);
    volumeQuery = volumeQuery.where((expression) => {
      const clauses = [expression('v.server_id', '=', serverId)];
      if (shareableBackendIds.length > 0) {
        clauses.push(expression('v.shared_backend_id', 'in', shareableBackendIds));
      }
      return expression.or(clauses);
    });
    const rows = await volumeQuery.execute();
    const knownNameRows = await this.database
      .selectFrom('control.volumes')
      .select('incus_name')
      .execute();
    const knownNames = new Set(knownNameRows.map((row) => row.incus_name));
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
    const placements = await this.database
      .selectFrom('control.volume_placements')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute();
    const placementByVolume = new Map(placements.map((row) => [row.volume_id, row]));
    const placedNames = new Set(
      rows
        .filter((row) => placementByVolume.has(row.id))
        .map((row) => row.incus_name),
    );

    for (const row of rows) {
      if (row.lifecycle_phase === 'deleting') {
        await this.enqueueDestroy(row);
        continue;
      }
      const placement = placementByVolume.get(row.id);
      if (!placement) continue;
      const listed = listedByName.get(row.incus_name);
      const shared = row.shared_backend_id !== null;
      if (shared && listed === undefined) {
        this.logger.warn(`dangling_pg volume=${row.id} server=${serverId}`);
        continue;
      }
      if (listed !== undefined && placement.catalog_state === 'present' && client) {
        await this.observeVolumeUsage(
          client,
          poolForPlacement(pools, placement.pool_id),
          row,
        );
      }
      if (row.needs_attention) {
        continue;
      }
      if (shared) {
        if (listed !== undefined && scanNeedsEnsure(row, listed)) {
          await this.enqueueResize(row, serverId);
        }
        continue;
      }
      if (scanNeedsEnsure(row, listed)) {
        await this.enqueueEnsure(
          row,
          serverId,
          placement.catalog_state === 'present' ? 'ensure_attachment' : 'create',
        );
      }
    }

    if (!client) return;
    const managedVolumeName = /^nyv-[0-9a-f]{32}$/;
    for (const pool of pools) {
      for (const volume of listedByPool.get(pool.incus_name) ?? []) {
        const name = storageVolumeName(volume);
        if (!managedVolumeName.test(name)) continue;
        if (knownNames.has(name)) {
          if (!placedNames.has(name)) {
            this.logger.warn(
              `Listed ${name} on server ${serverId} has no catalog placement; not deleting`,
            );
          }
          continue;
        }
        if (typeof volume !== 'string' && (volume.used_by ?? []).length > 0) continue;
        await this.deleteOrphanVolume(client, pool.incus_name, name, signal);
      }
    }
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
    const volumeExists = await this.readVolumeRow(context.intent.resourceId);
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
    const row = await this.readVolume(context.intent.resourceId, targetServerId);
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
    const attachments = await this.readAttachments(row.id, row.target_server_id);
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
      actual = await this.adoptOrCreate(context, row);
      if (!actual) {
        if (context.intent.attemptCount >= VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS) {
          return {
            outcome: 'failed',
            failure: volumeFailure(
              'VOLUME_CATALOG_ADOPT_FAILED',
              'Incus did not adopt the existing CephFS directory into this daemon catalog',
              { volumeId: row.id, serverId: targetServerId },
            ),
          };
        }
        return {
          outcome: 'retry',
          failure: volumeFailure(
            'VOLUME_CATALOG_ADOPT_PENDING',
            'Incus has not adopted the existing CephFS directory into this catalog',
            { volumeId: row.id, serverId: targetServerId },
          ),
        };
      }
    }

    return this.alignSizeAndShifted(context, row, actual, attachments);
  }

  private async reconcileDestroy(context: ReconcileRunContext): Promise<ReconcileOutcome> {
    const volume = await this.readVolumeRow(context.intent.resourceId);
    if (!volume) {
      return { outcome: 'succeeded', observedRevision: context.intent.targetRevision };
    }
    if (volume.lifecycle_phase !== 'deleting') {
      return { outcome: 'succeeded', observedRevision: volume.revision };
    }
    if (await this.hasAnyAttachments(volume.id)) {
      return destroyRetry(
        'VOLUME_REQUIRES_UNBIND',
        'The volume cannot be deleted while attachments remain',
        { volumeId: volume.id },
      );
    }
    await this.lockVolumeQuota(volume);

    const catalogs = await this.listCatalogs(volume.id);
    if (!volume.dir_ensured && catalogs.length === 0) {
      await this.finishEmptyTracking(volume.id, 'never_mounted');
      return { outcome: 'succeeded', observedRevision: volume.revision };
    }

    const eligible = await this.listDestroyExecutors(volume);
    if (eligible.length === 0) {
      await this.dropAllPlacements(volume.id);
      await this.finishEmptyTracking(volume.id, 'destroy_executor_gone');
      return { outcome: 'succeeded', observedRevision: volume.revision };
    }

    if (!volume.remove_all_committed) {
      let executor: { server_id: string; pool_name: string } | null = null;
      const pin = volume.remove_all_server_id;
      const pinStillEligible = pin ? eligible.find((item) => item.server_id === pin) : undefined;
      if (pin) {
        if (pinStillEligible) {
          executor = pinStillEligible;
        } else {
          return destroyRetry(
            'VOLUME_DESTROY_RETRY',
            'Pinned destroy executor is unreachable',
            { serverId: pin },
          );
        }
      } else if (!volume.dir_ensured && catalogs.length > 0) {
        const online = catalogs.filter((catalog) => catalog.server_status === 'online');
        const present: CatalogRow[] = [];
        for (const catalog of online) {
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
          const status = await this.classifyCatalogGet(
            client,
            catalog.pool_name,
            volume.incus_name,
            context.signal,
          );
          if (status === 'error') {
            return destroyRetry(
              'VOLUME_DESTROY_RETRY',
              'Destroy tracking GET did not complete with only 200/404',
              { serverId: catalog.server_id },
            );
          }
          if (status === 'present') present.push(catalog);
        }
        if (present.length > 0) {
          present.sort((left, right) => left.server_id.localeCompare(right.server_id));
          executor = present[0]!;
          await this.pinRemoveAllServer(volume.id, executor.server_id);
        } else {
          context.lease?.assertOwned();
          await this.markRemoveAllCommitted(volume.id, null);
          volume.remove_all_committed = true;
        }
      } else {
        executor = eligible[0]!;
        await this.pinRemoveAllServer(volume.id, executor.server_id);
      }

      if (!volume.remove_all_committed && executor) {
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
        const status = await this.classifyCatalogGet(
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
            await this.deleteCatalog(
              client,
              context.intent,
              executor.pool_name,
              volume.incus_name,
            );
          } catch {
            return destroyRetry(
              'VOLUME_DESTROY_RETRY',
              'Destroy RemoveAll was not confirmed with GET 404',
              { serverId: executor.server_id },
            );
          }
        }
        context.lease?.assertOwned();
        await this.markRemoveAllCommitted(volume.id, executor.server_id);
        this.logger.log(
          `volume=${volume.id} destroy pin=${executor.server_id} committed=true `
          + `eligible=${eligible.length} dir_ensured=${volume.dir_ensured}`,
        );
      }
    }

    const stale = await this.purgeStaleCatalogs(volume, catalogs, context);
    if (stale) return stale;
    await this.dropAllPlacements(volume.id);
    await this.finishEmptyTracking(volume.id);
    return { outcome: 'succeeded', observedRevision: volume.revision };
  }

  private async adoptOrCreate(
    context: ReconcileRunContext,
    row: VolumeRow,
  ): Promise<StorageVolume | undefined> {
    await auditIncusMutate(this.audit, context.intent, {
      method: 'POST',
      path: `/1.0/storage-pools/${row.placement_pool_name}/volumes`,
      instanceName: row.incus_name,
    });
    try {
      await readAfterTimeout(
        () => requestAndWait(
          context.client!,
          (options) => context.client!.createStorageVolume(
            row.placement_pool_name,
            {
              name: row.incus_name,
              type: 'custom',
              content_type: 'filesystem',
              config: {
                size: row.size_bytes,
                'security.shifted': 'true',
              },
            },
            options,
          ),
        ),
        async () => {
          await context.client!.getStorageVolume(row.placement_pool_name, 'custom', row.incus_name);
          return undefined;
        },
      );
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    try {
      return (await context.client!.getStorageVolume(
        row.placement_pool_name,
        'custom',
        row.incus_name,
      )).metadata;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return undefined;
    }
  }

  private async alignSizeAndShifted(
    context: ReconcileRunContext,
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
    const state: StorageVolumeState = (await context.client!.getStorageVolumeState(
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
      const details = {
        volumeId: row.id,
        requestedBytes: desiredSize.toString(),
        usedBytes: usedBytes?.toString() ?? null,
        attachments: attachments.map((attachment) => ({
          attachmentId: attachment.id,
          containerId: attachment.container_id,
        })),
      };
      const failure = decision.reason === 'usage_unknown'
        ? volumeFailure('VOLUME_USAGE_UNKNOWN', 'Volume usage is unknown; shrink is not allowed until usage is observed', details)
        : decision.reason === 'usage_floor'
          ? volumeFailure('VOLUME_SHRINK_BELOW_USAGE', 'The requested size is below volume usage', details)
          : decision.reason === 'detach'
            ? volumeFailure('VOLUME_SHRINK_REQUIRES_DETACH', 'The block-backed volume must be detached before shrinking', details)
            : volumeFailure('VOLUME_SHRINK_REQUIRES_STOP', 'The block-backed volume consumers must be stopped before shrinking', details);
      if (decision.reason === 'usage_floor' || decision.reason === 'usage_unknown') {
        await this.revertImpossibleShrink(row.id, currentSize, usedBytes, failure.code);
      }
      return { outcome: 'failed', failure };
    }
    if (decision.action !== 'none' || config['security.shifted'] !== actual.config?.['security.shifted']) {
      await auditIncusMutate(this.audit, context.intent, {
        method: 'PUT',
        path: `/1.0/storage-pools/${row.placement_pool_name}/volumes/custom/${row.incus_name}`,
        instanceName: row.incus_name,
      });
      await readAfterTimeout(
        () => requestAndWait(
          context.client!,
          (options) => context.client!.updateStorageVolume(
            row.placement_pool_name,
            'custom',
            row.incus_name,
            {
              config: {
                ...config,
                size: desiredSize.toString(),
              },
              description: actual.description,
            },
            options,
          ),
        ),
        async () => {
          const after = await context.client!.getStorageVolume(
            row.placement_pool_name,
            'custom',
            row.incus_name,
          );
          const afterSize = asBytes(after.metadata.config?.size);
          if (
            afterSize === null
            || afterSize !== desiredSize
            || after.metadata.config?.['security.shifted'] !== 'true'
          ) {
            throw new Error('VOLUME_UPDATE_NOT_CONFIRMED');
          }
          return undefined;
        },
      );
    }
    const verified = (await context.client!.getStorageVolume(
      row.placement_pool_name,
      'custom',
      row.incus_name,
    )).metadata;
    const verifiedSize = asBytes(verified.config?.size);
    if (
      verifiedSize === null
      || verifiedSize !== desiredSize
      || verified.config?.['security.shifted'] !== 'true'
      || verified.content_type !== 'filesystem'
    ) {
      return {
        outcome: 'failed',
        failure: volumeFailure(
          'VOLUME_VERIFY_FAILED',
          'The volume did not match the managed specification after reconciliation',
          {
            size: verified.config?.size ?? '',
            shifted: verified.config?.['security.shifted'] ?? '',
            contentType: verified.content_type ?? '',
          },
        ),
      };
    }
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
    if (!lagging) {
      await this.database
        .updateTable('control.volumes')
        .set({
          observed_revision: row.revision,
          lifecycle_phase: row.lifecycle_phase === 'provisioning' ? 'active' : row.lifecycle_phase,
          ...(usedBytes === null
            ? {}
            : {
              used_bytes: sql<string>`case
                when used_bytes is null then ${usedBytes.toString()}::bigint
                else greatest(used_bytes, ${usedBytes.toString()}::bigint)
              end`,
            }),
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
        .set({
          used_bytes: sql<string>`case
            when used_bytes is null then ${usedBytes.toString()}::bigint
            else greatest(used_bytes, ${usedBytes.toString()}::bigint)
          end`,
        })
        .where('id', '=', row.id)
        .where('lifecycle_phase', 'not in', ['deleting', 'failed'])
        .execute();
    }
    return { outcome: 'succeeded', observedRevision: row.revision };
  }

  private async readVolumeRow(volumeId: string): Promise<VolumeRecord | undefined> {
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

  private async readVolume(
    volumeId: string,
    intentServerId: string,
  ): Promise<VolumeRow | undefined> {
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

  private readAttachments(
    volumeId: string,
    serverId: string,
  ): Promise<VolumeAttachmentRow[]> {
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

  private async hasAnyAttachments(volumeId: string): Promise<boolean> {
    const row = await this.database
      .selectFrom('control.volume_attachments')
      .select('id')
      .where('volume_id', '=', volumeId)
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }

  private listCatalogs(volumeId: string): Promise<CatalogRow[]> {
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

  private async classifyCatalogGet(
    client: IncusClientPort,
    poolName: string,
    incusName: string,
    signal?: AbortSignal,
  ): Promise<CatalogGetStatus> {
    try {
      await client.getStorageVolume(poolName, 'custom', incusName, signal ? { signal } : undefined);
      return 'present';
    } catch (error) {
      if (isNotFound(error)) return 'missing';
      return 'error';
    }
  }

  private async clientFor(
    serverId: string,
    context: ReconcileRunContext,
  ): Promise<IncusClientPort | undefined> {
    if (context.client && context.intent.serverId === serverId) return context.client;
    return this.clients.get(serverId);
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
      const status = await this.classifyCatalogGet(
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
        await this.deleteCatalog(
          client,
          context.intent,
          catalog.pool_name,
          volume.incus_name,
        );
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

  private async deleteCatalog(
    client: IncusClientPort,
    intent: IntentRecord,
    poolName: string,
    incusName: string,
  ): Promise<void> {
    await auditIncusMutate(this.audit, intent, {
      method: 'DELETE',
      path: `/1.0/storage-pools/${poolName}/volumes/custom/${incusName}`,
      instanceName: incusName,
    });
    await readAfterTimeout(
      () => requestAndWait(
        client,
        (options) => client.deleteStorageVolume(poolName, 'custom', incusName, options),
      ),
      async () => {
        try {
          await client.getStorageVolume(poolName, 'custom', incusName);
        } catch (error) {
          if (isNotFound(error)) return undefined;
          throw error;
        }
        throw new Error('VOLUME_DELETE_NOT_CONFIRMED');
      },
    );
    await this.verifyAbsent(client, poolName, incusName);
  }

  private async markRemoveAllCommitted(
    volumeId: string,
    executorServerId: string | null,
  ): Promise<void> {
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

  private async pinRemoveAllServer(volumeId: string, serverId: string): Promise<void> {
    await this.database
      .updateTable('control.volumes')
      .set({ remove_all_server_id: serverId })
      .where('id', '=', volumeId)
      .where('lifecycle_phase', '=', 'deleting')
      .where('remove_all_committed', '=', false)
      .execute();
  }

  private async dropPlacement(volumeId: string, serverId: string): Promise<void> {
    await this.database
      .deleteFrom('control.volume_placements')
      .where('volume_id', '=', volumeId)
      .where('server_id', '=', serverId)
      .execute();
  }

  private async dropAllPlacements(volumeId: string): Promise<void> {
    await this.database
      .deleteFrom('control.volume_placements')
      .where('volume_id', '=', volumeId)
      .execute();
  }

  private async lockVolumeQuota(volume: VolumeRecord): Promise<void> {
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

  private async listDestroyExecutors(
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

  private async revertImpossibleShrink(
    volumeId: string,
    actualSizeBytes: bigint,
    usedBytes: bigint | null,
    failureCode: string,
  ): Promise<void> {
    await this.database
      .updateTable('control.volumes')
      .set({
        size_bytes: actualSizeBytes.toString(),
        used_bytes: usedBytes === null ? null : usedBytes.toString(),
        needs_attention: true,
        failure_code: failureCode.slice(0, 128),
      })
      .where('id', '=', volumeId)
      .where('lifecycle_phase', 'not in', ['deleting', 'failed'])
      .execute();
  }

  private async observeVolumeUsage(
    client: IncusClientPort,
    pool: { incus_name: string; driver: string; resize_family: string } | undefined,
    row: { id: string; incus_name: string; size_bytes: string | number },
  ): Promise<void> {
    if (!pool) return;
    const resizeFamily = pool.resize_family === 'block_backed' ? 'block_backed' : 'quota_online';
    try {
      const state = (await client.getStorageVolumeState(pool.incus_name, 'custom', row.incus_name)).metadata;
      const used = normalizeObservedVolumeUsage({
        resizeFamily,
        driver: pool.driver as VolumeRow['driver'],
        usedBytes: asBytes(state.usage?.used) ?? null,
        totalBytes: asBytes(state.usage?.total) ?? null,
        currentSizeBytes: asBytes(row.size_bytes) ?? 0n,
      });
      await this.database
        .updateTable('control.volumes')
        .set({
          used_bytes: used === null ? null : used.toString(),
        })
        .where('id', '=', row.id)
        .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
        .execute();
    } catch (error) {
      if (!isNotFound(error)) {
        this.logger.warn(`volume=${row.id} used_bytes scan failed: ${String(error)}`);
      }
    }
  }

  private async finishEmptyTracking(volumeId: string, reason?: string): Promise<void> {
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

  private async verifyAbsent(
    client: IncusClientPort,
    poolName: string,
    incusName: string,
  ): Promise<void> {
    try {
      await client.getStorageVolume(poolName, 'custom', incusName);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'volume_still_present',
    });
  }

  private async deleteOrphanVolume(
    client: IncusClientPort,
    poolName: string,
    volumeName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await readAfterTimeout(
      () => requestAndWait(
        client,
        (options) => client.deleteStorageVolume(poolName, 'custom', volumeName, {
          ...options,
          signal,
        }),
      ),
      async () => {
        try {
          await client.getStorageVolume(poolName, 'custom', volumeName, { signal });
        } catch (error) {
          if (isNotFound(error)) return undefined;
          throw error;
        }
        throw new Error('VOLUME_ORPHAN_DELETE_NOT_CONFIRMED');
      },
    );
  }

  private async enqueueResize(
    row: { id: string; revision: number },
    serverId: string,
  ): Promise<void> {
    await ensureVolumeIntent(this.intents, {
      kind: 'volume.resize',
      resourceType: 'volume',
      resourceId: row.id,
      serverId,
      targetRevision: row.revision,
      reuseSettled: false,
      request: {
        source: 'full_scan',
        operation: 'resize',
        idempotencyKey: 'resize',
      },
    }, this.database);
  }

  private async enqueueEnsure(
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
      request: {
        source: 'full_scan',
        operation,
        idempotencyKey: operation,
      },
    }, this.database);
  }

  private async enqueueDestroy(row: { id: string; revision: number }): Promise<void> {
    await ensureVolumeIntent(this.intents, {
      kind: 'volume.destroy',
      resourceType: 'volume',
      resourceId: row.id,
      targetRevision: row.revision,
      reuseSettled: false,
      request: {
        source: 'full_scan',
        operation: 'destroy',
        idempotencyKey: 'destroy',
      },
    }, this.database);
  }
}

function destroyRetryFromError(error: unknown, serverId: string): ReconcileOutcome {
  if (error instanceof IncusError) {
    return destroyRetry(error.code, error.message, { serverId });
  }
  return destroyRetry(
    'SERVER_UNREACHABLE',
    'Destroy cannot reach a catalog Incus',
    { serverId },
  );
}

function scanNeedsEnsure(
  row: {
    readonly lifecycle_phase: string;
    readonly size_bytes: string | number | bigint;
  },
  listed: StorageVolume | string | undefined,
): boolean {
  if (listed === undefined) return true;
  if (typeof listed === 'string') return false;
  const actualSize = asBytes(listed.config?.size);
  const desiredSize = asBytes(row.size_bytes);
  if (listed.config?.['security.shifted'] !== 'true') return true;
  if (actualSize === null || desiredSize === null) return false;
  return actualSize !== desiredSize;
}

function poolForPlacement<T extends { id: string }>(
  pools: readonly T[],
  poolId: string,
): T | undefined {
  return pools.find((pool) => pool.id === poolId);
}

function storageVolumeName(volume: StorageVolume | string): string {
  if (typeof volume === 'string') {
    const parts = volume.split('/').filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? '';
  }
  return volume.name ?? '';
}
