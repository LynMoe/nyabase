import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AuditAction } from '@nyabase/common';
import { Kysely, sql } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import {
  IncusError,
  isAlreadyExistsError,
  requestAndWait,
  readAfterTimeout,
  type IncusClientPort,
  type IncusSchema,
} from '../incus/index.js';
import { IntentRepository, type IntentFailure, type IntentRecord } from './intent.repository.js';
import {
  INCUS_CLIENT_FACTORY,
  type IncusClientFactory,
  type ManagedReconciler,
  type ReconcileOutcome,
  type ReconcileRunContext,
} from './reconcile-worker.service.js';
import {
  VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS,
  placementServersToDesire,
} from '../volumes/volume-placement.js';

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
  | { readonly action: 'blocked'; readonly reason: 'usage_floor' | 'detach' | 'stop' };

export function decideVolumeResize(input: VolumeResizeInput): VolumeResizeDecision {
  if (input.desiredSizeBytes === input.currentSizeBytes) return { action: 'none' };
  if (input.desiredSizeBytes > input.currentSizeBytes) return { action: 'grow' };
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

/**
 * CephFS / quota_online volumes often report `usage.used === config.size` with
 * `usage.total` missing or zero even when empty, which falsely blocks shrink.
 * Treat that phantom as unused for floor checks and persistence.
 */
export function normalizeObservedVolumeUsage(input: {
  readonly resizeFamily: 'quota_online' | 'block_backed';
  readonly driver: VolumeRow['driver'];
  readonly usedBytes: bigint | null;
  readonly totalBytes: bigint | null;
  readonly currentSizeBytes: bigint;
}): bigint | null {
  if (input.usedBytes === null) return null;
  const applies = input.resizeFamily === 'quota_online' || input.driver === 'cephfs';
  if (!applies) return input.usedBytes;
  const totalMissing = input.totalBytes === null || input.totalBytes === 0n;
  if (totalMissing && input.usedBytes >= input.currentSizeBytes) {
    return 0n;
  }
  return input.usedBytes;
}

export function capacityScope(
  volume: Pick<{ server_id: string | null; shared_backend_id: string | null }, 'server_id' | 'shared_backend_id'>,
): { readonly kind: 'server' | 'shared_backend'; readonly id: string } {
  if (volume.shared_backend_id) {
    return { kind: 'shared_backend', id: volume.shared_backend_id };
  }
  if (!volume.server_id) throw new Error('A local volume must have a server id');
  return { kind: 'server', id: volume.server_id };
}

interface VolumeRow {
  id: string;
  pool_id: string;
  pool_server_id: string;
  server_id: string | null;
  shared_backend_id: string | null;
  incus_name: string;
  size_bytes: string;
  generation: number;
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  needs_attention: boolean;
  pool_name: string;
  driver: 'dir' | 'btrfs' | 'zfs' | 'lvm' | 'lvmcluster' | 'ceph' | 'cephfs';
  resize_family: 'quota_online' | 'block_backed';
  block_filesystem: string | null;
  target_server_id: string;
  desired_present: boolean;
  unused_confirmed_at: Date | string | null;
  placement_pool_id: string;
  placement_pool_name: string;
}

interface VolumeAttachmentRow {
  id: string;
  container_id: string;
  detach_drained_at: Date | string | null;
  power_intent: 'running' | 'stopped';
}

interface PlacementPeer {
  server_id: string;
  pool_id: string;
  unused_confirmed_at: Date | string | null;
}

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

async function auditIncusMutate(
  audit: AuditService | undefined,
  intent: IntentRecord,
  detail: {
    readonly method: string;
    readonly path: string;
    readonly instanceName?: string;
  },
): Promise<void> {
  if (!audit) return;
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

@Injectable()
export class VolumeReconciler implements ManagedReconciler {
  private readonly logger = new Logger(VolumeReconciler.name);

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Optional() private readonly intents?: IntentRepository,
    @Optional() private readonly audit?: AuditService,
    @Optional() @Inject(INCUS_CLIENT_FACTORY) private readonly clients?: IncusClientFactory,
  ) {}

  supports(intent: IntentRecord): boolean {
    return intent.resourceType === 'volume';
  }

  async scan(serverId: string, client?: IncusClientPort, signal?: AbortSignal): Promise<void> {
    if (!this.intents) return;
    const rows = await this.database
      .selectFrom('control.volumes as v')
      .innerJoin('infra.storage_pools as home_pool', 'home_pool.id', 'v.pool_id')
      .select([
        'v.id as id',
        'v.generation as generation',
        'v.server_id as server_id',
        'v.shared_backend_id as shared_backend_id',
        'v.lifecycle_phase as lifecycle_phase',
        'v.needs_attention as needs_attention',
        'v.incus_name as incus_name',
        'v.size_bytes as size_bytes',
        'v.pool_id as pool_id',
        'home_pool.server_id as home_server_id',
      ])
      .execute();
    const pools = await this.database
      .selectFrom('infra.storage_pools')
      .select(['id', 'incus_name', 'shared_backend_id', 'server_id', 'registered'])
      .where('server_id', '=', serverId)
      .where('registered', '=', true)
      .execute();
    const sharedBackendsHere = new Set(
      pools
        .map((pool) => pool.shared_backend_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
    const knownNames = new Set<string>();
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
    for (const row of rows) {
      const localHere = row.server_id === serverId;
      const sharedHere = row.shared_backend_id !== null
        && sharedBackendsHere.has(row.shared_backend_id);
      if (localHere || sharedHere) knownNames.add(row.incus_name);
    }
    const placements = await this.database
      .selectFrom('control.volume_placements')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute();
    const placementByVolume = new Map(placements.map((row) => [row.volume_id, row]));
    const liveServersByVolume = await this.liveAttachmentServers(
      rows.map((row) => row.id),
    );

    for (const row of rows) {
      const localHere = row.server_id === serverId;
      const sharedHere = row.shared_backend_id !== null
        && sharedBackendsHere.has(row.shared_backend_id);
      if (!localHere && !sharedHere) continue;
      const desiredServers = placementServersToDesire({
        lifecyclePhase: row.lifecycle_phase,
        serverId: row.server_id,
        homeServerId: row.home_server_id,
        liveAttachmentServerIds: liveServersByVolume.get(row.id) ?? [],
      });
      const placement = placementByVolume.get(row.id);
      if (!placement && desiredServers.has(serverId)
        && !row.needs_attention
        && row.lifecycle_phase !== 'failed'
        && row.lifecycle_phase !== 'deleting') {
        const pool = this.poolForVolumeOnServer(row, pools, serverId);
        if (pool) {
          await this.upsertPlacement(row.id, serverId, pool.id, true);
          await this.enqueueEnsure(row, serverId, row.home_server_id === serverId ? 'create' : 'ensure_attachment');
        }
        continue;
      }
      if (!placement) continue;
      const listed = listedByName.get(row.incus_name);
      if (row.lifecycle_phase === 'deleting') {
        await this.enqueueEnsure(row, serverId, 'delete');
        continue;
      }
      if (placement.desired_present) {
        if (!row.needs_attention && scanNeedsEnsure(row, listed)) {
          await this.enqueueEnsure(
            row,
            serverId,
            row.home_server_id === serverId ? 'create' : 'ensure_attachment',
          );
        }
        continue;
      }
      await this.database
        .updateTable('control.volume_placements')
        .set({ observed_present: listed !== undefined })
        .where('volume_id', '=', row.id)
        .where('server_id', '=', serverId)
        .execute();
    }

    if (!client) return;
    const managedVolumeName = /^nyv-[0-9a-f]{32}$/;
    for (const pool of pools) {
      for (const volume of listedByPool.get(pool.incus_name) ?? []) {
        const name = storageVolumeName(volume);
        if (!managedVolumeName.test(name) || knownNames.has(name)) continue;
        if (typeof volume !== 'string' && (volume.used_by ?? []).length > 0) continue;
        await this.deleteOrphanVolume(client, pool.incus_name, name, signal);
      }
    }
  }

  async reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome> {
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
    const volumeExists = await this.database
      .selectFrom('control.volumes')
      .select(['id', 'lifecycle_phase'])
      .where('id', '=', context.intent.resourceId)
      .executeTakeFirst();
    if (!volumeExists) {
      return {
        outcome: 'failed',
        failure: volumeFailure('VOLUME_NOT_FOUND', 'The desired volume no longer exists'),
      };
    }
    const row = await this.readVolume(context.intent.resourceId, targetServerId);
    if (!row) {
      if (volumeExists.lifecycle_phase === 'deleting') {
        return { outcome: 'succeeded', observedGeneration: context.intent.targetGeneration };
      }
      return {
        outcome: 'failed',
        failure: volumeFailure('VOLUME_NOT_FOUND', 'The desired volume no longer exists'),
      };
    }
    this.logger.log(
      `volume=${row.id} server=${targetServerId} desired_present=${row.desired_present} `
      + `phase=${row.lifecycle_phase} destroyer=${row.pool_server_id === targetServerId}`,
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

    if (row.lifecycle_phase === 'deleting') {
      return this.reconcileDelete(context, row, actual, attachments);
    }

    if (!row.desired_present) {
      if (row.shared_backend_id) {
        await this.database
          .updateTable('control.volume_placements')
          .set({ observed_present: actual !== undefined })
          .where('volume_id', '=', row.id)
          .where('server_id', '=', targetServerId)
          .execute();
        return { outcome: 'succeeded', observedGeneration: row.generation };
      }
    }

    if (!actual) {
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

  private async reconcileDelete(
    context: ReconcileRunContext,
    row: VolumeRow,
    actual: StorageVolume | undefined,
    attachments: VolumeAttachmentRow[],
  ): Promise<ReconcileOutcome> {
    const drain = await this.database
      .selectFrom('control.volume_detach_drains')
      .selectAll()
      .where('volume_id', '=', row.id)
      .executeTakeFirst();
    if (drain && new Date(drain.drained_at).getTime() > Date.now()) {
      return {
        outcome: 'retry',
        failure: volumeFailure('VOLUME_DETACH_DRAINING', 'Volume detach drain has not expired'),
        retryAfterMs: Math.max(1_000, new Date(drain.drained_at).getTime() - Date.now()),
      };
    }
    if (attachments.some((item) => !item.detach_drained_at) || (actual?.used_by ?? []).length > 0) {
      return {
        outcome: 'retry',
        failure: volumeFailure(
          'VOLUME_REQUIRES_DETACH',
          'The volume cannot be deleted while it is attached or in use',
        ),
      };
    }
    await this.database
      .updateTable('control.volume_placements')
      .set({ unused_confirmed_at: sql<Date>`coalesce(unused_confirmed_at, clock_timestamp())` })
      .where('volume_id', '=', row.id)
      .where('server_id', '=', row.target_server_id)
      .execute();

    const isHome = row.pool_server_id === row.target_server_id;
    if (isHome) {
      const peers = await this.listPlacementPeers(row.id);
      for (const peer of peers) {
        const peerClient = peer.server_id === row.target_server_id
          ? context.client!
          : await this.clients?.get(peer.server_id);
        if (!peerClient) {
          return {
            outcome: 'retry',
            failure: volumeFailure(
              'VOLUME_DELETE_WAITING_IDLE',
              'Home delete is waiting to inspect a peer catalog',
              { serverId: peer.server_id },
            ),
          };
        }
        const peerPool = peer.server_id === row.target_server_id
          ? row.placement_pool_name
          : await this.poolName(peer.pool_id);
        let peerActual: StorageVolume | undefined;
        try {
          peerActual = (await peerClient.getStorageVolume(peerPool, 'custom', row.incus_name)).metadata;
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        if ((peerActual?.used_by ?? []).length > 0) {
          return {
            outcome: 'retry',
            failure: volumeFailure(
              'VOLUME_REQUIRES_DETACH',
              'A tracked catalog still reports volume consumers',
              { serverId: peer.server_id },
            ),
          };
        }
        if (peer.unused_confirmed_at == null && peer.server_id !== row.target_server_id) {
          return {
            outcome: 'retry',
            failure: volumeFailure(
              'VOLUME_DELETE_WAITING_IDLE',
              'Home delete is waiting for every tracked catalog to confirm idle',
              { serverId: peer.server_id },
            ),
          };
        }
      }
      if (actual) {
        await this.deleteCatalog(context, row);
      }
      await this.dropPlacementAndMaybeVolume(row.id, row.target_server_id);
      return { outcome: 'succeeded', observedGeneration: row.generation };
    }

    const homePlacement = await this.database
      .selectFrom('control.volume_placements')
      .select(['server_id', 'pool_id'])
      .where('volume_id', '=', row.id)
      .where('server_id', '=', row.pool_server_id)
      .executeTakeFirst();
    if (homePlacement) {
      return {
        outcome: 'retry',
        failure: volumeFailure(
          'VOLUME_DELETE_WAITING_HOME',
          'Non-home catalog cleanup is waiting for home RemoveAll',
        ),
      };
    }
    const homePoolName = await this.poolName(row.pool_id);
    const homeClient = await this.clients?.get(row.pool_server_id);
    if (!homeClient) {
      return {
        outcome: 'retry',
        failure: volumeFailure(
          'VOLUME_DELETE_WAITING_HOME',
          'Non-home catalog cleanup cannot reach the home Incus',
        ),
      };
    }
    try {
      await homeClient.getStorageVolume(homePoolName, 'custom', row.incus_name);
      return {
        outcome: 'retry',
        failure: volumeFailure(
          'VOLUME_DELETE_WAITING_HOME',
          'Home catalog is still present after the placement row was dropped',
        ),
      };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (actual) {
      await this.deleteCatalog(context, row);
    }
    await this.dropPlacementAndMaybeVolume(row.id, row.target_server_id);
    return { outcome: 'succeeded', observedGeneration: row.generation };
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
    const attached = attachments.some((item) => !item.detach_drained_at);
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
      attached: attachments.some((item) => !item.detach_drained_at),
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
      return {
        outcome: 'failed',
        failure: decision.reason === 'usage_floor'
          ? volumeFailure('VOLUME_SHRINK_BELOW_USAGE', 'The requested size is below volume usage', details)
          : decision.reason === 'detach'
            ? volumeFailure('VOLUME_SHRINK_REQUIRES_DETACH', 'The block-backed volume must be detached before shrinking', details)
            : volumeFailure('VOLUME_SHRINK_REQUIRES_STOP', 'The block-backed volume consumers must be stopped before shrinking', details),
      };
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
        observed_present: true,
        observed_generation: row.generation,
      })
      .where('volume_id', '=', row.id)
      .where('server_id', '=', row.target_server_id)
      .execute();
    const lagging = await this.database
      .selectFrom('control.volume_placements')
      .select('server_id')
      .where('volume_id', '=', row.id)
      .where('desired_present', '=', true)
      .where((expression) => expression.or([
        expression('observed_generation', 'is', null),
        expression('observed_generation', '!=', row.generation),
      ]))
      .executeTakeFirst();
    if (!lagging) {
      const homeUsed = row.pool_server_id === row.target_server_id ? usedBytes : undefined;
      await this.database
        .updateTable('control.volumes')
        .set({
          observed_generation: row.generation,
          lifecycle_phase: row.lifecycle_phase === 'provisioning' ? 'active' : row.lifecycle_phase,
          ...(homeUsed === undefined
            ? {}
            : { used_bytes: homeUsed === null ? null : homeUsed.toString() }),
          failure_code: null,
          needs_attention: false,
        })
        .where('id', '=', row.id)
        .where('generation', '=', row.generation)
        .where('lifecycle_phase', 'not in', ['deleting', 'failed'])
        .execute();
    }
    return { outcome: 'succeeded', observedGeneration: row.generation };
  }

  private async readVolume(
    volumeId: string,
    intentServerId: string,
  ): Promise<VolumeRow | undefined> {
    const volume = await this.database
      .selectFrom('control.volumes as v')
      .innerJoin('infra.storage_pools as p', 'p.id', 'v.pool_id')
      .select([
        'v.id as id',
        'v.pool_id as pool_id',
        'p.server_id as pool_server_id',
        'v.server_id as server_id',
        'v.shared_backend_id as shared_backend_id',
        'v.incus_name as incus_name',
        'v.size_bytes as size_bytes',
        'v.generation as generation',
        'v.lifecycle_phase as lifecycle_phase',
        'v.needs_attention as needs_attention',
        'p.incus_name as pool_name',
        'p.driver as driver',
        'p.resize_family as resize_family',
        'p.block_filesystem as block_filesystem',
      ])
      .where('v.id', '=', volumeId)
      .executeTakeFirst();
    if (!volume) return undefined;
    const placement = await this.database
      .selectFrom('control.volume_placements as pl')
      .innerJoin('infra.storage_pools as pp', 'pp.id', 'pl.pool_id')
      .select([
        'pl.desired_present as desired_present',
        'pl.unused_confirmed_at as unused_confirmed_at',
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
    if (!volume.shared_backend_id && volume.pool_server_id !== intentServerId) {
      throw new IncusError('MISSING_STORAGE_POOL', 'managed_failure', {
        poolId: volume.pool_id,
        serverId: intentServerId,
      });
    }
    return {
      ...volume,
      driver: placement.driver,
      resize_family: placement.resize_family,
      block_filesystem: placement.block_filesystem,
      size_bytes: String(volume.size_bytes),
      target_server_id: intentServerId,
      desired_present: placement.desired_present,
      unused_confirmed_at: placement.unused_confirmed_at,
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
        'a.detach_drained_at as detach_drained_at',
        'c.power_intent as power_intent',
      ])
      .where('a.volume_id', '=', volumeId)
      .where('c.server_id', '=', serverId)
      .execute();
  }

  private async deleteCatalog(context: ReconcileRunContext, row: VolumeRow): Promise<void> {
    await auditIncusMutate(this.audit, context.intent, {
      method: 'DELETE',
      path: `/1.0/storage-pools/${row.placement_pool_name}/volumes/custom/${row.incus_name}`,
      instanceName: row.incus_name,
    });
    await readAfterTimeout(
      () => requestAndWait(
        context.client!,
        (options) => context.client!.deleteStorageVolume(
          row.placement_pool_name,
          'custom',
          row.incus_name,
          options,
        ),
      ),
      async () => {
        try {
          await context.client!.getStorageVolume(
            row.placement_pool_name,
            'custom',
            row.incus_name,
          );
        } catch (error) {
          if (isNotFound(error)) return undefined;
          throw error;
        }
        throw new Error('VOLUME_DELETE_NOT_CONFIRMED');
      },
    );
    await this.verifyAbsent(context.client!, row);
  }

  private async dropPlacementAndMaybeVolume(volumeId: string, serverId: string): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const volume = await transaction
        .selectFrom('control.volumes')
        .select(['id', 'lifecycle_phase'])
        .where('id', '=', volumeId)
        .forUpdate()
        .executeTakeFirst();
      if (!volume) return;
      await transaction
        .deleteFrom('control.volume_placements')
        .where('volume_id', '=', volumeId)
        .where('server_id', '=', serverId)
        .execute();
      if (volume.lifecycle_phase !== 'deleting') return;
      const remaining = await transaction
        .selectFrom('control.volume_placements')
        .select('server_id')
        .where('volume_id', '=', volumeId)
        .executeTakeFirst();
      if (remaining) return;
      await transaction.deleteFrom('control.volumes').where('id', '=', volumeId).execute();
      this.logger.log(`Deleted logical volume ${volumeId} after last placement dropped`);
    });
  }

  private async verifyAbsent(client: IncusClientPort, row: VolumeRow): Promise<void> {
    try {
      await client.getStorageVolume(row.placement_pool_name, 'custom', row.incus_name);
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

  private async enqueueEnsure(
    row: { id: string; generation: number },
    serverId: string,
    operation: 'create' | 'ensure_attachment' | 'delete',
  ): Promise<void> {
    if (!this.intents) return;
    await this.intents.ensurePending({
      kind: 'volume.ensure',
      resourceType: 'volume',
      resourceId: row.id,
      serverId,
      targetGeneration: row.generation,
      reuseSettled: false,
      request: {
        source: 'full_scan',
        operation,
        idempotencyKey: operation,
      },
    });
  }

  private async upsertPlacement(
    volumeId: string,
    serverId: string,
    poolId: string,
    desiredPresent: boolean,
  ): Promise<void> {
    await this.database
      .insertInto('control.volume_placements')
      .values({
        volume_id: volumeId,
        server_id: serverId,
        pool_id: poolId,
        desired_present: desiredPresent,
        observed_present: false,
        observed_generation: null,
        unused_confirmed_at: null,
      })
      .onConflict((conflict) => conflict
        .columns(['volume_id', 'server_id'])
        .doUpdateSet({ desired_present: desiredPresent, pool_id: poolId }))
      .execute();
  }

  private poolForVolumeOnServer(
    row: { pool_id: string; shared_backend_id: string | null },
    pools: ReadonlyArray<{ id: string; shared_backend_id: string | null }>,
    _serverId: string,
  ): { id: string } | undefined {
    if (!row.shared_backend_id) {
      return pools.find((pool) => pool.id === row.pool_id);
    }
    return pools.find((pool) => pool.shared_backend_id === row.shared_backend_id);
  }

  private async liveAttachmentServers(volumeIds: readonly string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (volumeIds.length === 0) return result;
    const rows = await this.database
      .selectFrom('control.volume_attachments as a')
      .innerJoin('control.containers as c', 'c.id', 'a.container_id')
      .select(['a.volume_id as volume_id', 'c.server_id as server_id'])
      .where('a.volume_id', 'in', [...volumeIds])
      .where('a.detach_drained_at', 'is', null)
      .where('c.lifecycle_phase', 'not in', ['failed', 'deleting'])
      .execute();
    for (const row of rows) {
      const list = result.get(row.volume_id) ?? [];
      if (!list.includes(row.server_id)) list.push(row.server_id);
      result.set(row.volume_id, list);
    }
    return result;
  }

  private listPlacementPeers(volumeId: string): Promise<PlacementPeer[]> {
    return this.database
      .selectFrom('control.volume_placements')
      .select(['server_id', 'pool_id', 'unused_confirmed_at'])
      .where('volume_id', '=', volumeId)
      .execute();
  }

  private async poolName(poolId: string): Promise<string> {
    const pool = await this.database
      .selectFrom('infra.storage_pools')
      .select('incus_name')
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();
    return pool.incus_name;
  }
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

function storageVolumeName(volume: StorageVolume | string): string {
  if (typeof volume === 'string') {
    const parts = volume.split('/').filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? '';
  }
  return volume.name ?? '';
}
