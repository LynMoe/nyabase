import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AuditAction,
  MAX_PLATFORM_SERVERS,
  NodeMetricsStatus,
  PreflightStatus,
  ServerStatus,
  type CreateServerRequest,
  type CreatedServerDto,
  type ListScope,
  type PatchServerRequest,
  type ServerDto,
  type UserServerDto,
  Role,
} from '@nyabase/common';
import { allocatableCpus } from '../cpu/cpu-allocation.js';
import { AgentRegistry } from '../incus/agent-registry.service.js';
import { afterCommit } from '../platform/post-commit.js';
import { ReconcileWakeService } from '../reconcile/reconcile-wake.service.js';
import { AgentEnrollmentService } from './agent-enrollment.service.js';
import type { InfrastructureServerTable } from '../platform/persistence-pg/infrastructure-database.types.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { AuditService } from '../iam/audit.service.js';
import { assertListScope, type Actor, requireUserId } from '../iam/actor.js';
import { numberValue, isoDate, poolLabel } from '../platform/domain-utils.js';
import { lockServerOnboarding } from '../platform/persistence-pg/advisory-locks.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { VOLUME_DESTROY_PLACEMENT_ID } from '../reconcile/reconcile-claim.repository.js';
import { listEligibleDestroyExecutors } from '../volumes/volumes.repository.js';
import { assertActorRole } from '../iam/administration.js';

type ServerRow = Selectable<InfrastructureServerTable>;

@Injectable()
export class ServersService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly access: AccessResolverService,
    private readonly audit: AuditService,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
    private readonly agents: AgentRegistry,
    private readonly enrollment: AgentEnrollmentService,
    private readonly wake: ReconcileWakeService,
  ) {}

  async create(actorId: string, input: CreateServerRequest): Promise<CreatedServerDto> {
    const { row, enrollment } = await this.transactions.run(async (transaction) => {
      await assertActorRole(transaction, actorId, Role.Operator);
      await lockServerOnboarding(transaction);
      const count = await transaction
        .selectFrom('infra.servers')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= MAX_PLATFORM_SERVERS) {
        throw new ConflictException({ code: 'SERVER_CAPACITY_REACHED' });
      }
      const server = await transaction
        .insertInto('infra.servers')
        .values({
          id: randomUUID(),
          name: input.name,
          slug: input.slug,
          incus_version: null,
          api_extensions: [],
          system_pool_id: null,
          storage_overcommit_ratio: 1,
          parent_interface: input.parentInterface,
          dns_servers: input.dnsServers,
          status: ServerStatus.Unknown,
          last_seen_at: null,
          last_error: null,
          revision: 1,
          agent_credential_hash: null,
          agent_enrollment_token_hash: null,
          agent_enrollment_expires_at: null,
          agent_version: null,
          agent_hostname: null,
          agent_connected_at: null,
          reserved_cpus: input.reservedCpus,
          cpu_topology: null,
          node_metrics_status: NodeMetricsStatus.Unknown,
          node_metrics_last_success_at: null,
          node_metrics_outage_since: null,
          node_metrics_last_error: null,
          preflight_status: PreflightStatus.NotRun,
          preflight_checked_at: null,
          preflight_report: null,
          gpu_enabled: false,
          gpu_enabled_by: null,
          gpu_health: {},
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.append(transaction, actorId, AuditAction.CreateServer, server.id, 'server', {
        name: server.name,
        slug: server.slug,
        reservedCpus: input.reservedCpus,
      });
      return { row: server, enrollment: await this.enrollment.issueInTransaction(transaction, server.id) };
    });
    return { ...(await this.toDtos([row]))[0]!, enrollment };
  }

  /**
   * `scope=mine`: the servers the caller holds a grant for, as user DTOs.
   * `scope=all`: every server, as full DTOs (`ManageServers` or `ManageGrants`).
   */
  async list(actor: Actor, scope: ListScope): Promise<ServerDto[] | UserServerDto[]> {
    assertListScope(actor, scope, Role.Operator);
    if (scope === 'all') return this.findAllDtos();
    return this.findUserDtosByIds(await this.access.listAccessibleServers(requireUserId(actor)));
  }

  /** `scope=mine` needs a grant (404 otherwise); `scope=all` needs `ManageServers`. */
  async get(actor: Actor, id: string, scope: ListScope): Promise<ServerDto | UserServerDto> {
    assertListScope(actor, scope, Role.Operator);
    if (scope === 'all') return this.findDtoById(id);
    if (!(await this.access.listAccessibleServers(requireUserId(actor))).includes(id)) {
      throw new NotFoundException('Server not found');
    }
    return this.findUserDtoById(id);
  }

  async findAll(): Promise<ServerRow[]> {
    return this.database.selectFrom('infra.servers').selectAll().orderBy('name').execute();
  }

  async findAllDtos(): Promise<ServerDto[]> {
    return this.toDtos(await this.findAll());
  }

  async findByIds(ids: string[]): Promise<ServerRow[]> {
    if (ids.length === 0) return [];
    return this.database
      .selectFrom('infra.servers')
      .selectAll()
      .where('id', 'in', ids)
      .orderBy('name')
      .execute();
  }

  async findUserDtosByIds(ids: string[]): Promise<UserServerDto[]> {
    return this.toUserDtos(await this.findByIds(ids));
  }

  async findById(
    id: string,
    executor: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase> = this.database,
  ) {
    const row = await executor
      .selectFrom('infra.servers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Server not found');
    return row;
  }

  async findDtoById(id: string): Promise<ServerDto> {
    return (await this.toDtos([await this.findById(id)]))[0]!;
  }

  async findUserDtoById(id: string): Promise<UserServerDto> {
    return (await this.toUserDtos([await this.findById(id)]))[0]!;
  }

  async update(actorId: string, id: string, input: PatchServerRequest): Promise<ServerDto> {
    const row = await this.transactions.run(async (transaction) => {
      await assertActorRole(transaction, actorId, Role.Operator);
      const current = await transaction
        .selectFrom('infra.servers')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundException('Server not found');
      if (input.reservedCpus !== undefined) assertReservedCpus(current, input.reservedCpus);
      const updated = await transaction
        .updateTable('infra.servers')
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.slug === undefined ? {} : { slug: input.slug }),
          ...(input.parentInterface === undefined
            ? {}
            : { parent_interface: input.parentInterface }),
          ...(input.dnsServers === undefined ? {} : { dns_servers: input.dnsServers }),
          ...(input.systemPoolId === undefined ? {} : { system_pool_id: input.systemPoolId }),
          ...(input.storageOvercommitRatio === undefined
            ? {}
            : { storage_overcommit_ratio: input.storageOvercommitRatio }),
          ...(input.reservedCpus === undefined ? {} : { reserved_cpus: input.reservedCpus }),
          revision: Number(input.expectedRevision) + 1,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .where('revision', '=', String(input.expectedRevision))
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new ConflictException({ code: 'REVISION_CONFLICT' });
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.UpdateServer,
        id,
        'server',
        input,
      );
      // Containers on this server move off newly reserved CPUs (and onto freed ones).
      if (input.reservedCpus !== undefined) afterCommit(transaction, () => this.wake.wake({ reason: 'scan' }));
      return updated;
    });
    return (await this.toDtos([row]))[0]!;
  }

  async delete(actorId: string, id: string, expectedRevision?: number): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await assertActorRole(transaction, actorId, Role.Operator);
      const server = await this.findById(id, transaction);
      if (expectedRevision !== undefined && Number(server.revision) !== expectedRevision) {
        throw new ConflictException({ code: 'REVISION_CONFLICT' });
      }
      await purgeServerControlPlane(transaction, this.audit, id);
      await this.audit.append(transaction, actorId, AuditAction.DeleteServer, id, 'server', {
        name: server.name,
      });
    });
    this.agents.disconnect(id, undefined, 'server deleted');
    this.proxySnapshots.invalidate('server_deleted');
  }

  private async toDtos(rows: ServerRow[]): Promise<ServerDto[]> {
    const ids = [...new Set(
      rows
        .map((row) => row.system_pool_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const pools = await this.database
        .selectFrom('infra.storage_pools')
        .select(['id', 'display_name', 'incus_name'])
        .where('id', 'in', ids)
        .execute();
      for (const pool of pools) {
        names.set(pool.id, poolLabel(pool.display_name, pool.incus_name));
      }
    }
    return rows.map((row) => this.toDto(
      row,
      row.system_pool_id ? names.get(row.system_pool_id) ?? null : null,
    ));
  }

  private toDto(
    row: ServerRow,
    systemPoolName: string | null = null,
  ): ServerDto {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      incusVersion: row.incus_version,
      apiExtensions: row.api_extensions,
      systemPoolId: row.system_pool_id,
      systemPoolName,
      storageOvercommitRatio: numberValue(row.storage_overcommit_ratio),
      parentInterface: row.parent_interface ?? '',
      dnsServers: row.dns_servers,
      gpuEnabled: row.gpu_enabled,
      gpuHealth: row.gpu_health as ServerDto['gpuHealth'],
      status: row.status as ServerStatus,
      lastSeenAt: isoDate(row.last_seen_at),
      lastError: row.last_error,
      revision: numberValue(row.revision),
      preflightStatus: row.preflight_status as PreflightStatus,
      preflightCheckedAt: isoDate(row.preflight_checked_at),
      preflightReport: row.preflight_report as ServerDto['preflightReport'],
      agent: {
        connected: this.agents.isConnected(row.id),
        enrolled: row.agent_credential_hash !== null,
        version: row.agent_version,
        hostname: row.agent_hostname,
        connectedAt: isoDate(row.agent_connected_at),
        enrollmentExpiresAt: isoDate(row.agent_enrollment_expires_at),
      },
      metricsHealth: {
        status: row.node_metrics_status as NodeMetricsStatus,
        lastSuccessAt: isoDate(row.node_metrics_last_success_at),
        outageSince: isoDate(row.node_metrics_outage_since),
        lastError: row.node_metrics_last_error,
      },
      reservedCpus: [...row.reserved_cpus].sort((left, right) => left - right),
      cpuTopology: row.cpu_topology,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private async toUserDtos(rows: ServerRow[]): Promise<UserServerDto[]> {
    return rows.map((row) => this.toUserDto(row));
  }

  private toUserDto(row: ServerRow): UserServerDto {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status as ServerStatus,
      lastSeenAt: isoDate(row.last_seen_at),
      preflightStatus: row.preflight_status as PreflightStatus,
      gpuEnabled: row.gpu_enabled,
    };
  }
}

/** Reserved CPUs must exist (once the topology is known) and leave at least one CPU for containers. */
function assertReservedCpus(server: ServerRow, reserved: readonly number[]): void {
  const topology = server.cpu_topology;
  if (!topology || topology.length === 0) return;
  const known = new Set(topology.map((entry) => entry.id));
  const unknown = reserved.filter((cpu) => !known.has(cpu));
  if (unknown.length > 0) {
    throw new ConflictException({
      code: 'RESERVED_CPU_UNKNOWN',
      message: 'Reserved CPUs must exist on the server',
      details: { unknown },
    });
  }
  if (allocatableCpus(topology, reserved).length === 0) {
    throw new ConflictException({
      code: 'RESERVED_CPUS_EXHAUST_SERVER',
      message: 'At least one CPU must stay available to containers',
    });
  }
}

type Tx = Transaction<NyabaseDatabase>;

/** Drop the server's claims, intents, containers and their volume attachments. */
async function purgeContainers(transaction: Tx, serverId: string): Promise<Set<string>> {
  await transaction
    .deleteFrom('control.reconcile_claims')
    .where((expression) => expression.or([
      expression('server_id', '=', serverId),
      expression('placement_server_id', '=', serverId),
    ]))
    .execute();
  await transaction.deleteFrom('control.intents').where('server_id', '=', serverId).execute();
  const attachmentsOnS = await transaction
    .selectFrom('control.volume_attachments')
    .select('volume_id')
    .where('container_id', 'in', transaction
      .selectFrom('control.containers')
      .select('id')
      .where('server_id', '=', serverId))
    .execute();
  const volumeIdsLostAttachment = new Set(attachmentsOnS.map((row) => row.volume_id));
  await transaction
    .deleteFrom('control.volume_attachments')
    .where('container_id', 'in', transaction
      .selectFrom('control.containers')
      .select('id')
      .where('server_id', '=', serverId))
    .execute();
  await transaction.deleteFrom('control.containers').where('server_id', '=', serverId).execute();
  return volumeIdsLostAttachment;
}

/** Local volumes live on one server and go with it. */
async function purgeLocalVolumes(transaction: Tx, serverId: string): Promise<void> {
  const localVolumes = await transaction
    .selectFrom('control.volumes')
    .select('id')
    .where('server_id', '=', serverId)
    .execute();
  for (const volume of localVolumes) {
    await transaction.deleteFrom('control.volume_placements').where('volume_id', '=', volume.id).execute();
    await transaction.deleteFrom('control.volumes').where('id', '=', volume.id).execute();
  }
}

/** Remove the server's placements of shared volumes; returns the volumes that lost one. */
async function dropSharedPlacements(transaction: Tx, serverId: string): Promise<Set<string>> {
  const placementsOnS = await transaction
    .selectFrom('control.volume_placements as pl')
    .innerJoin('control.volumes as v', 'v.id', 'pl.volume_id')
    .select('pl.volume_id as volume_id')
    .where('pl.server_id', '=', serverId)
    .where('v.shared_backend_id', 'is not', null)
    .execute();
  const volumeIdsLostPlacement = new Set(placementsOnS.map((row) => row.volume_id));
  await transaction.deleteFrom('control.volume_placements').where('server_id', '=', serverId).execute();
  return volumeIdsLostPlacement;
}

/**
 * Shared volumes with no placement left: when this server was the last way to
 * reach them, drop their tracking (and any pending destroy) with the server.
 */
async function dropEmptiedSharedVolumes(
  transaction: Tx,
  audit: AuditService,
  serverId: string,
  volumeIdsLostPlacement: ReadonlySet<string>,
  volumeIdsLostAttachment: ReadonlySet<string>,
): Promise<void> {
  const emptyShared = await transaction
    .selectFrom('control.volumes')
    .select(['id', 'shared_backend_id', 'server_id', 'pool_id', 'dir_ensured'])
    .where('server_id', 'is', null)
    .where('shared_backend_id', 'is not', null)
    .execute();
  for (const volume of emptyShared) {
    const attachment = await transaction
      .selectFrom('control.volume_attachments')
      .select('id')
      .where('volume_id', '=', volume.id)
      .executeTakeFirst();
    const placement = await transaction
      .selectFrom('control.volume_placements')
      .select('server_id')
      .where('volume_id', '=', volume.id)
      .executeTakeFirst();
    const eligible = volume.shared_backend_id
      ? await listEligibleDestroyExecutors(transaction, volume.shared_backend_id, {
        excludeServerId: serverId,
        // An unreachable server is still a way to reach the data later.
        includeOffline: true,
      })
      : [];
    const claimed = await transaction
      .selectFrom('control.reconcile_claims')
      .select('resource_id')
      .where('resource_type', '=', 'volume')
      .where('resource_id', '=', volume.id)
      .where('placement_server_id', '=', VOLUME_DESTROY_PLACEMENT_ID)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    const sWasEligible = volume.shared_backend_id
      ? Boolean(await transaction
        .selectFrom('infra.storage_pools')
        .select('id')
        .where('server_id', '=', serverId)
        .where('shared_backend_id', '=', volume.shared_backend_id)
        .where('driver', '=', 'cephfs')
        .where('shareable', '=', true)
        .where('registered', '=', true)
        .executeTakeFirst())
      : false;
    const touchedByS = volumeIdsLostPlacement.has(volume.id)
      || volumeIdsLostAttachment.has(volume.id);
    const executorGone = eligible.length === 0 && sWasEligible;
    if (!touchedByS && !(executorGone && (claimed || volume.dir_ensured))) continue;
    if (attachment) continue;
    if (placement && eligible.length > 0) continue;
    if (claimed && eligible.length > 0) continue;
    const reason = claimed && eligible.length === 0
      ? 'destroy_executor_gone'
      : 'server_cascade_empty_tracking';
    if (volume.shared_backend_id) {
      await transaction
        .selectFrom('infra.shared_backends')
        .select('id')
        .where('id', '=', volume.shared_backend_id)
        .forUpdate()
        .execute();
    }
    await transaction
      .deleteFrom('control.reconcile_claims')
      .where('resource_type', '=', 'volume')
      .where('resource_id', '=', volume.id)
      .execute();
    await transaction
      .deleteFrom('control.intents')
      .where('resource_type', '=', 'volume')
      .where('resource_id', '=', volume.id)
      .execute();
    await transaction.deleteFrom('control.volume_placements').where('volume_id', '=', volume.id).execute();
    await transaction.deleteFrom('control.volumes').where('id', '=', volume.id).execute();
    await audit.append(transaction, null, AuditAction.DeleteVolume, volume.id, 'volume', {
      reason,
    });
  }
}

/** Grants, lapses, assignments, addresses, pools and finally the server row. */
async function purgeGrantsAndInventory(transaction: Tx, serverId: string): Promise<void> {
  await transaction
    .deleteFrom('control.access_lapses')
    .where((expression) => expression.or([
      expression.and([
        expression('resource_kind', '=', 'server'),
        expression('resource_id', '=', serverId),
      ]),
      expression.and([
        expression('resource_kind', '=', 'storage_pool'),
        expression('resource_id', 'in', transaction
          .selectFrom('infra.storage_pools')
          .select('id')
          .where('server_id', '=', serverId)),
      ]),
    ]))
    .execute();
  await transaction.deleteFrom('iam.server_grants').where('server_id', '=', serverId).execute();
  await transaction
    .deleteFrom('iam.storage_pool_grants')
    .where('pool_id', 'in', transaction
      .selectFrom('infra.storage_pools')
      .select('id')
      .where('server_id', '=', serverId))
    .execute();
  await transaction.deleteFrom('infra.image_server_assignments').where('server_id', '=', serverId).execute();
  await transaction.deleteFrom('control.container_network_claims').where('server_id', '=', serverId).execute();
  await transaction.deleteFrom('infra.ip_pool_servers').where('server_id', '=', serverId).execute();
  await transaction
    .updateTable('infra.servers')
    .set({ system_pool_id: null })
    .where('id', '=', serverId)
    .execute();
  await transaction.deleteFrom('infra.storage_pools').where('server_id', '=', serverId).execute();
  await transaction.deleteFrom('infra.servers').where('id', '=', serverId).execute();
}

/** Remove every control-plane row that depends on a server, in dependency order. */
async function purgeServerControlPlane(
  transaction: Tx,
  audit: AuditService,
  serverId: string,
): Promise<void> {
  const volumeIdsLostAttachment = await purgeContainers(transaction, serverId);
  await purgeLocalVolumes(transaction, serverId);
  const volumeIdsLostPlacement = await dropSharedPlacements(transaction, serverId);
  await dropEmptiedSharedVolumes(
    transaction,
    audit,
    serverId,
    volumeIdsLostPlacement,
    volumeIdsLostAttachment,
  );
  await purgeGrantsAndInventory(transaction, serverId);
}
