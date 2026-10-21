import { Capability } from '@nyabase/common';
import { sql, type Kysely } from 'kysely';
import { deriveInstanceName, IncusError } from '../incus/index.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { IntentFailure, IntentRepository } from '../reconcile/intent.repository.js';
import type { ResourceAuthority } from '../reconcile/managed-reconciler.js';
import {
  composeAuthorizedKeys,
  type ContainerAttachment,
  type ContainerRow,
  type InstanceFull,
  type InstanceState,
  type SshFileObservation,
} from './container-reconcile-support.js';

/** Every SQL statement the container reconciler issues; the Incus-facing logic never touches Kysely. */
export class ContainerReconcileStore {
  constructor(
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly intents: IntentRepository,
  ) {}

  // --- ManagedReconciler state -------------------------------------------------

  async needsAttention(containerId: string): Promise<boolean> {
    const row = await this.database
      .selectFrom('control.containers')
      .select('needs_attention')
      .where('id', '=', containerId)
      .executeTakeFirst();
    return row?.needs_attention === true;
  }

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
      .execute();
  }

  async markFailure(containerId: string, failure: IntentFailure, attention: boolean): Promise<void> {
    await this.database
      .updateTable('control.containers')
      .set({
        needs_attention: attention,
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
    const owners = new Map(rows.map((row) => [row.id, row.owner_id]));
    return new Map(containerIds.map((id) => [id, {
      ownerId: owners.get(id) ?? null,
      adminCapability: Capability.ManageContainersAny,
    }]));
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
        'c.image_id as image_id',
        'c.revision as revision',
        'c.image_fingerprint as image_fingerprint',
        'c.root_size_bytes as root_size_bytes',
        'c.cpu_millis as cpu_millis',
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

  async markCatalogPresent(volumeId: string, serverId: string): Promise<void> {
    await this.database
      .updateTable('control.volume_placements')
      .set({ catalog_state: 'present' })
      .where('volume_id', '=', volumeId)
      .where('server_id', '=', serverId)
      .execute();
    await this.database
      .updateTable('control.volumes')
      .set({ dir_ensured: true })
      .where('id', '=', volumeId)
      .execute();
  }

  // --- observation -------------------------------------------------------------

  /** Attachments that finished binding become `attached`; finished unbinds disappear. */
  async settleVolumeBinds(containerId: string, document: InstanceFull): Promise<void> {
    const devices = document.devices ?? {};
    const rows = await this.database
      .selectFrom('control.volume_attachments')
      .select(['id', 'bind_state', 'device_name'])
      .where('container_id', '=', containerId)
      .execute();
    for (const row of rows) {
      const present = Object.prototype.hasOwnProperty.call(devices, row.device_name);
      if (row.bind_state === 'attaching' && present) {
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

  async revertImpossibleRootShrink(
    containerId: string,
    actualRootBytes: bigint,
    usedBytes: bigint | null,
    failureCode: string,
  ): Promise<void> {
    await this.database
      .updateTable('control.containers')
      .set({
        root_size_bytes: actualRootBytes.toString(),
        ...(usedBytes === null ? {} : { root_used_bytes: usedBytes.toString() }),
        needs_attention: true,
        failure_code: failureCode.slice(0, 128),
      })
      .where('id', '=', containerId)
      .where('lifecycle_phase', 'not in', ['deleting', 'failed'])
      .execute();
  }

  /** Record what Incus reported after a successful reconcile pass. */
  async recordObservation(
    row: ContainerRow,
    actual: InstanceFull,
    state: InstanceState,
    quotaPending: boolean,
    ssh: SshFileObservation,
    usedBytes: bigint | null,
  ): Promise<void> {
    await this.database
      .updateTable('control.containers')
      .set({
        instance_name: actual.name ?? deriveInstanceName(row.id),
        observed_revision: row.revision,
        root_size_pending_bytes: quotaPending ? String(row.root_size_bytes) : null,
        failure_code: null,
        failure_reason: null,
        last_transition_at: sql<Date>`clock_timestamp()`,
        lifecycle_phase: row.lifecycle_phase === 'provisioning' ? 'active' : row.lifecycle_phase,
        ...(usedBytes === null ? {} : { root_used_bytes: usedBytes.toString() }),
      })
      .where('id', '=', row.id)
      .execute();
    await this.database
      .updateTable('control.container_ssh_routes')
      .set({
        instance_name: actual.name ?? deriveInstanceName(row.id),
        instance_status: state.status ?? 'unknown',
        instance_started_at: state.started_at ?? null,
        ssh_status: ssh.status,
        last_error: ssh.lastError,
        observed_at: sql<Date>`clock_timestamp()`,
      })
      .where('container_id', '=', row.id)
      .execute();
  }

  // --- deletion ----------------------------------------------------------------

  /** Normalised ids of the containers on a server that are not being deleted. */
  async listLiveContainerIds(serverId: string): Promise<string[]> {
    const rows = await this.database
      .selectFrom('control.containers')
      .select('id')
      .where('server_id', '=', serverId)
      .where('lifecycle_phase', '!=', 'deleting')
      .execute();
    return rows.map((item) => item.id);
  }

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
      request: { source: 'full_scan', idempotencyKey: 'physical:scan' },
    });
  }
}
