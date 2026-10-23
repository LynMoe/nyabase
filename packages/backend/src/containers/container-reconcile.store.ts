import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { deriveInstanceName, IncusError, type IncusSchema } from '../incus/index.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import {
  IntentRepository,
  type IntentFailure,
  type IntentRecord,
  type PhysicalSettlement,
} from '../reconcile/intent.repository.js';
import type { ResourceAuthority } from '../reconcile/managed-reconciler.js';
import { OrphanSightingsStore } from '../reconcile/orphan-sightings.store.js';
import { settleContainerIntent } from './container-rules.js';

/** The desired container joined with its server, root pool, image and network claim. */
export interface ContainerRow {
  id: string;
  server_id: string;
  owner_id: string;
  /** The user-facing name; the host certificate is issued for it. */
  name: string;
  image_id: string;
  revision: number;
  image_fingerprint: string;
  root_size_bytes: string | number;
  mem_bytes: string | number;
  /** CPU set last applied to the instance. */
  cpu_set: number[] | null;
  gpu_enabled: boolean;
  gpu_state: unknown;
  nesting: boolean;
  syscall_intercept: boolean;
  power_intent: 'running' | 'stopped';
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  root_pool_name: string;
  root_resize_family: 'quota_online' | 'block_backed';
  parent_interface: string | null;
  routed_ip: string | null;
  network_key: string | null;
  gateway: string | null;
  dns_servers: string[];
  login_user: string;
  ssh_public_key: string | null;
}
export interface ContainerAttachment {
  id: string;
  container_path: string;
  read_only: boolean;
  volume_id: string;
  incus_name: string;
  pool_name: string;
  size_bytes: string;
  shared: boolean;
  /** The owning shared backend of a shared volume (its catalog label). */
  shared_backend_id?: string | null;
  bind_state: 'attaching' | 'attached' | 'detaching';
}

export interface SshFileObservation {
  readonly status: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown';
  readonly lastError: string | null;
}

/** How long a scan intent that failed waits before the full scan queues it again. */
const SCAN_FAILED_RETRY_AFTER_MS = {
  'container.update': 60 * 60_000,
  'container.delete': 15 * 60_000,
} as const;

/** Build guest authorized_keys from platform user public keys only (T3 jump). */
function composeAuthorizedKeys(
  userKeys: string | null | undefined,
): string | null {
  if (!userKeys) return null;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const line of userKeys.split('\n')) {
    const key = line.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    lines.push(key);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Every SQL statement the container reconciler issues; the Incus-facing logic never touches Kysely. */
@Injectable()
export class ContainerReconcileStore {
  /** Quarantine ledger of instances no row owns (full scan). */
  readonly orphans: OrphanSightingsStore;

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly intents: IntentRepository,
  ) {
    this.orphans = new OrphanSightingsStore(database);
  }

  // --- ManagedReconciler state -------------------------------------------------

  settleIntent(
    intent: IntentRecord,
    observedRevision: number,
    settlement: PhysicalSettlement,
  ): Promise<void> {
    return settleContainerIntent(this.intents, intent, observedRevision, settlement);
  }

  async needsAttention(containerId: string): Promise<boolean> {
    const row = await this.database
      .selectFrom('control.containers')
      .select('needs_attention')
      .where('id', '=', containerId)
      .executeTakeFirst();
    return row?.needs_attention === true;
  }

  /** Only the current revision's success clears status; a stale pass leaves newer state alone. */
  async markSucceeded(containerId: string, revision: number): Promise<void> {
    await this.database
      .updateTable('control.containers')
      .set({
        observed_revision: revision,
        needs_attention: false,
        failure_code: null,
        failure_reason: null,
        last_transition_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', containerId)
      .where('revision', '=', revision)
      .execute();
  }

  /** `attention` parks the container; a plain failure never un-parks it (only success or a retry does). */
  async markFailure(containerId: string, failure: IntentFailure, attention: boolean): Promise<void> {
    await this.database
      .updateTable('control.containers')
      .set({
        ...(attention ? { needs_attention: true } : {}),
        failure_code: failure.code.slice(0, 128),
        failure_reason: failure.message.slice(0, 4096),
        last_transition_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', containerId)
      .execute();
  }

  async resourceAuthorities(
    containerIds: readonly string[],
  ): Promise<Map<string, ResourceAuthority>> {
    const rows = containerIds.length === 0
      ? []
      : await this.database
        .selectFrom('control.containers')
        .select(['id', 'owner_id'])
        .where('id', 'in', containerIds)
        .execute();
    // A deleted container has no entry (see ResourceAuthority).
    return new Map(rows.map((row) => [row.id, { ownerId: row.owner_id }]));
  }

  // --- desired state -----------------------------------------------------------

  async readContainer(id: string): Promise<ContainerRow | undefined> {
    const row = await this.database
      .selectFrom('control.containers as c')
      .innerJoin('infra.servers as s', 's.id', 'c.server_id')
      .innerJoin('infra.storage_pools as p', 'p.id', 'c.root_pool_id')
      .innerJoin('infra.images as i', 'i.id', 'c.image_id')
      .select([
        'c.id as id',
        'c.server_id as server_id',
        'c.owner_id as owner_id',
        'c.name as name',
        'c.image_id as image_id',
        'c.revision as revision',
        'c.image_fingerprint as image_fingerprint',
        'c.root_size_bytes as root_size_bytes',
        'c.cpu_set as cpu_set',
        'c.mem_bytes as mem_bytes',
        'c.gpu_state as gpu_state',
        's.gpu_enabled as gpu_enabled',
        'c.nesting as nesting',
        'c.syscall_intercept as syscall_intercept',
        'c.power_intent as power_intent',
        'c.lifecycle_phase as lifecycle_phase',
        'p.incus_name as root_pool_name',
        'p.resize_family as root_resize_family',
        's.parent_interface as parent_interface',
        's.dns_servers as dns_servers',
        'i.login_user as login_user',
      ])
      .select((expression) => expression
        .selectFrom('iam.ssh_public_keys as user_keys')
        .select(sql<string | null>`
          string_agg(user_keys.key_text, E'\n' order by user_keys.created_at asc, user_keys.id asc)
        `.as('keys'))
        .whereRef('user_keys.user_id', '=', 'c.owner_id')
        .as('user_ssh_public_keys'))
      .select((expression) => expression
        .selectFrom('control.container_network_claims as n')
        .select('n.address')
        .whereRef('n.container_id', '=', 'c.id')
        .whereRef('n.server_id', '=', 'c.server_id')
        .where('n.state', '=', 'active')
        .orderBy('n.id')
        .limit(1)
        .as('routed_ip'))
      .select(sql<string | null>`(
          SELECT n.network_key::text
          FROM control.container_network_claims AS n
          WHERE n.container_id = c.id
            AND n.server_id = c.server_id
            AND n.state = 'active'
          ORDER BY n.id
          LIMIT 1
        )`.as('network_key'))
      .select(sql<string | null>`(
          SELECT host(pool.gateway)
          FROM control.container_network_claims AS n
          INNER JOIN infra.ip_pools AS pool ON pool.cidr = n.network_key
          WHERE n.container_id = c.id
            AND n.server_id = c.server_id
            AND n.state = 'active'
          ORDER BY n.id
          LIMIT 1
        )`.as('gateway'))
      .where('c.id', '=', id)
      .executeTakeFirst();
    return row
      ? {
        ...row,
        root_size_bytes: String(row.root_size_bytes),
        mem_bytes: String(row.mem_bytes),
        routed_ip: row.routed_ip ?? null,
        network_key: row.network_key ?? null,
        gateway: row.gateway ?? null,
        dns_servers: Array.isArray(row.dns_servers)
          ? row.dns_servers.filter((entry): entry is string => typeof entry === 'string')
          : [],
        parent_interface: row.parent_interface ?? null,
        ssh_public_key: composeAuthorizedKeys(row.user_ssh_public_keys),
      }
      : undefined;
  }

  async readAttachments(containerId: string, serverId: string): Promise<ContainerAttachment[]> {
    const rows = await this.database
      .selectFrom('control.volume_attachments as a')
      .innerJoin('control.volumes as v', 'v.id', 'a.volume_id')
      .leftJoin('control.volume_placements as pl', (join) => join
        .onRef('pl.volume_id', '=', 'a.volume_id')
        .on('pl.server_id', '=', serverId))
      .leftJoin('infra.storage_pools as pp', 'pp.id', 'pl.pool_id')
      .select([
        'a.id as id',
        'a.container_path as container_path',
        'a.read_only as read_only',
        'a.bind_state as bind_state',
        'a.volume_id as volume_id',
        'v.incus_name as incus_name',
        'v.size_bytes as size_bytes',
        'v.pool_id as volume_pool_id',
        'v.server_id as volume_server_id',
        'v.shared_backend_id as shared_backend_id',
        'pl.pool_id as placement_pool_id',
        'pp.incus_name as placement_pool_name',
      ])
      .where('a.container_id', '=', containerId)
      .orderBy('a.id')
      .execute();
    const result: ContainerAttachment[] = [];
    for (const row of rows) {
      const shared = row.shared_backend_id !== null;
      const base = {
        id: row.id,
        container_path: row.container_path,
        read_only: row.read_only,
        volume_id: row.volume_id,
        incus_name: row.incus_name,
        size_bytes: String(row.size_bytes),
        shared,
        shared_backend_id: row.shared_backend_id,
        bind_state: row.bind_state ?? 'attached',
      };
      if (row.bind_state === 'detaching') {
        result.push({ ...base, pool_name: '' });
        continue;
      }
      let poolName: string | undefined;
      if (shared) {
        if (!row.placement_pool_id || !row.placement_pool_name) {
          throw new IncusError('VOLUME_PLACEMENT_PENDING', 'retry', {
            volumeId: row.volume_id,
            serverId,
          });
        }
        poolName = row.placement_pool_name;
      } else {
        const pool = await this.database
          .selectFrom('infra.storage_pools')
          .select('incus_name')
          .where('id', '=', row.volume_pool_id)
          .where('server_id', '=', serverId)
          .where('registered', '=', true)
          .executeTakeFirst();
        if (!pool) {
          throw new IncusError('MISSING_STORAGE_POOL', 'managed_failure', {
            volumeId: row.volume_id,
            serverId,
          });
        }
        poolName = pool.incus_name;
      }
      result.push({ ...base, pool_name: poolName });
    }
    return result;
  }

  /** Re-read the attachments that should exist, and whether a newer revision has superseded the intent. */
  async rereadDesired(
    containerId: string,
    serverId: string,
    targetRevision: number,
  ): Promise<{ stale: boolean; desired: ContainerAttachment[] }> {
    const current = await this.database
      .selectFrom('control.containers')
      .select('revision')
      .where('id', '=', containerId)
      .executeTakeFirst();
    const attachments = await this.readAttachments(containerId, serverId);
    const desired = attachments.filter((attachment) => attachment.bind_state !== 'detaching');
    return {
      stale: (current?.revision ?? targetRevision) > targetRevision,
      desired,
    };
  }

  /** Device names of the attachments being removed from the container. */
  async readDetachingDevices(containerId: string): Promise<string[]> {
    const rows = await this.database
      .selectFrom('control.volume_attachments')
      .select('device_name')
      .where('container_id', '=', containerId)
      .where('bind_state', '=', 'detaching')
      .orderBy('id')
      .execute();
    return rows.map((row) => row.device_name);
  }

  /**
   * A catalog that was not known present appears without a verified size (it
   * may have been created at a size read before a shrink): it drops the
   * observed revision, so it counts as not caught up
   * (`releaseSettledShrinkReservations`) until a volume pass verifies it.
   */
  async markCatalogPresent(volumeId: string, serverId: string): Promise<void> {
    await this.database
      .updateTable('control.volume_placements')
      .set({
        catalog_state: 'present',
        observed_revision: sql<number | null>`case when catalog_state = 'present' then observed_revision end`,
      })
      .where('volume_id', '=', volumeId)
      .where('server_id', '=', serverId)
      .execute();
    await this.database
      .updateTable('control.volumes')
      .set({ dir_ensured: true })
      .where('id', '=', volumeId)
      .execute();
  }

  /**
   * This pass created a shared volume's catalog at `postedBytes`, a size it
   * read before the POST. When the volume's size moved since, or it still
   * holds a shrink reservation (which only a verified catalog releases), a
   * resize for this server is queued and woken now instead of waiting for
   * the full scan. Its own idempotency key keeps a resize already running
   * for the revision (one that found the catalog missing) from absorbing it.
   */
  async requeueResizeAfterCatalogPost(
    volumeId: string,
    serverId: string,
    postedBytes: string | number,
  ): Promise<void> {
    const volume = await this.database
      .selectFrom('control.volumes as v')
      .innerJoin('control.volume_placements as pl', 'pl.volume_id', 'v.id')
      .select(['v.revision', 'v.size_bytes', 'v.shrink_reserved_bytes'])
      .where('v.id', '=', volumeId)
      .where('pl.server_id', '=', serverId)
      .where('v.shared_backend_id', 'is not', null)
      .where('v.lifecycle_phase', '!=', 'deleting')
      .where('v.needs_attention', '=', false)
      .executeTakeFirst();
    if (!volume) return;
    if (String(volume.size_bytes) === String(postedBytes) && volume.shrink_reserved_bytes === null) return;
    await this.intents.ensurePending({
      kind: 'volume.resize',
      resourceType: 'volume',
      resourceId: volumeId,
      serverId,
      targetRevision: volume.revision,
      reuseSettled: false,
      request: { source: 'catalog_posted', operation: 'resize', idempotencyKey: 'resize:catalog_posted' },
    });
  }

  // --- observation -------------------------------------------------------------

  /**
   * Attachments that finished binding become `attached`; finished unbinds
   * disappear. `detachedOnly` settles only the unbinds.
   */
  async settleVolumeBinds(
    containerId: string,
    document: Pick<IncusSchema<'InstanceFull'>, 'devices'>,
    detachedOnly = false,
  ): Promise<void> {
    const devices = document.devices ?? {};
    const rows = await this.database
      .selectFrom('control.volume_attachments')
      .select(['id', 'bind_state', 'device_name'])
      .where('container_id', '=', containerId)
      .execute();
    for (const row of rows) {
      const present = Object.prototype.hasOwnProperty.call(devices, row.device_name);
      if (row.bind_state === 'attaching' && present && !detachedOnly) {
        await this.database
          .updateTable('control.volume_attachments')
          .set({ bind_state: 'attached' })
          .where('id', '=', row.id)
          .where('bind_state', '=', 'attaching')
          .execute();
      } else if (row.bind_state === 'detaching' && !present) {
        await this.database
          .deleteFrom('control.volume_attachments')
          .where('id', '=', row.id)
          .where('bind_state', '=', 'detaching')
          .execute();
      }
    }
  }

  async setInstanceName(containerId: string, instanceName: string): Promise<void> {
    await this.database
      .updateTable('control.containers')
      .set({ instance_name: instanceName })
      .where('id', '=', containerId)
      .execute();
  }

  /**
   * Undo a shrink the instance cannot take, unless a newer revision already
   * replaced it. The actual size is within the reservation the shrink kept, so
   * the revert exceeds no grant or pool capacity; the reservation is released.
   */
  async revertImpossibleRootShrink(
    containerId: string,
    revision: number,
    actualRootBytes: bigint,
    usedBytes: bigint | null,
    failureCode: string,
  ): Promise<void> {
    await this.database
      .updateTable('control.containers')
      .set({
        root_size_bytes: actualRootBytes.toString(),
        root_shrink_reserved_bytes: null,
        ...(usedBytes === null ? {} : { root_used_bytes: usedBytes.toString() }),
        needs_attention: true,
        failure_code: failureCode.slice(0, 128),
      })
      .where('id', '=', containerId)
      .where('revision', '=', revision)
      .where('lifecycle_phase', 'not in', ['deleting', 'failed'])
      .execute();
  }

  /** Record what Incus reported after a successful reconcile pass. */
  async recordObservation(
    row: ContainerRow,
    actual: IncusSchema<'InstanceFull'>,
    state: IncusSchema<'InstanceState'>,
    quotaPending: boolean,
    ssh: SshFileObservation,
    usedBytes: bigint | null,
  ): Promise<void> {
    // Guarded on the revision this pass reconciled and a live phase: a delete
    // (or any newer revision) accepted meanwhile is never overwritten, and the
    // only phase transition here is provisioning -> active. A shrink's
    // reservation is released once Incus has applied the verified size, not
    // while the quota is still pending (it applies at the next start).
    await this.database
      .updateTable('control.containers')
      .set({
        instance_name: actual.name ?? deriveInstanceName(row.id),
        observed_revision: row.revision,
        root_size_pending_bytes: quotaPending ? String(row.root_size_bytes) : null,
        ...(quotaPending ? {} : { root_shrink_reserved_bytes: null }),
        failure_code: null,
        failure_reason: null,
        last_transition_at: sql<Date>`clock_timestamp()`,
        lifecycle_phase: 'active',
      })
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .where('lifecycle_phase', 'in', ['provisioning', 'active'])
      .execute();
    if (usedBytes !== null) await this.recordRootUsage(row.id, usedBytes);
    await this.database
      .updateTable('control.container_ssh_routes')
      .set({
        instance_name: actual.name ?? deriveInstanceName(row.id),
        // Incus reports `Running`; routes store the ContainerStatus form (`running`).
        instance_status: (state.status ?? 'unknown').toLowerCase(),
        instance_started_at: state.started_at ?? null,
        ssh_status: ssh.status,
        last_error: ssh.lastError,
        observed_at: sql<Date>`clock_timestamp()`,
      })
      .where('container_id', '=', row.id)
      .execute();
  }

  // --- deletion ----------------------------------------------------------------

  /** The instance is gone: park its address for reuse and drop the container row. */
  async releaseContainerState(row: ContainerRow): Promise<void> {
    await this.database
      .updateTable('control.container_network_claims')
      .set({
        container_id: null,
        state: 'releasing',
        reusable_at: sql<Date>`clock_timestamp() + interval '360 seconds'`,
        owner_kind: 'runtime_cleanup',
        cleanup_payload_json: JSON.stringify({
          resourceType: 'container',
          resourceId: row.id,
          serverId: row.server_id,
        }),
      })
      .where('container_id', '=', row.id)
      .execute();
    await this.database
      .deleteFrom('control.containers')
      .where('id', '=', row.id)
      .execute();
  }

  // --- full scan ---------------------------------------------------------------

  listScanContainers(serverId: string) {
    return this.database
      .selectFrom('control.containers')
      .select([
        'id',
        'revision',
        'server_id',
        'lifecycle_phase',
        'needs_attention',
        'power_intent',
      ])
      .where('server_id', '=', serverId)
      .execute();
  }

  async recordRootUsage(containerId: string, usage: bigint): Promise<void> {
    await this.database
      .updateTable('control.containers')
      .set({ root_used_bytes: usage.toString() })
      .where('id', '=', containerId)
      .where('lifecycle_phase', '!=', 'deleting')
      .execute();
  }

  /** Record the CPU set the instance is now pinned to. */
  async recordCpuSet(containerId: string, cpus: readonly number[]): Promise<void> {
    await this.database
      .updateTable('control.containers')
      .set({ cpu_set: [...cpus] })
      .where('id', '=', containerId)
      .execute();
  }

  async enqueueScanIntent(
    desired: { readonly id: string; readonly revision: number; readonly server_id: string },
    kind: 'container.delete' | 'container.update',
  ): Promise<void> {
    await this.intents.ensurePending({
      kind,
      resourceType: 'container',
      resourceId: desired.id,
      serverId: desired.server_id,
      targetRevision: desired.revision,
      reuseSettled: false,
      // A scan intent that failed for this revision is not re-queued by every
      // 60 s scan (each pass would also audit the drift and the Incus PUT
      // again); a newer revision or a user retry runs it at once, and the scan
      // itself tries again only after a back-off, so transient failures still heal.
      reuseFailed: true,
      reuseFailedSettledAfter: new Date(Date.now() - SCAN_FAILED_RETRY_AFTER_MS[kind]),
      request: { source: 'full_scan', idempotencyKey: 'physical:scan' },
    });
  }
}
