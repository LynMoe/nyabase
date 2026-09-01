import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AuditAction,
  Capability,
  GpuGrantMode,
  MAX_PLATFORM_SERVERS,
  NodeMetricsStatus,
  PreflightStatus,
  ServerStatus,
  type CreateServerRequest,
  type PatchServerRequest,
  type ServerDto,
  type ServerGpuDto,
  type UserServerDto,
} from '@nyabase/common';
import type { InfrastructureServerTable } from '../infrastructure/infrastructure-database.types.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { numberValue, isoDate, poolLabel } from '../domain/domain-utils.js';
import {
  InfrastructureRepository,
  lockServerOnboarding,
} from '../infrastructure/infrastructure.repository.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { VOLUME_DESTROY_PLACEMENT_ID } from '../runtime/reconcile-claim.repository.js';
import { listEligibleDestroyExecutors } from '../volumes/eligible-destroy-executors.js';
import { sql } from 'kysely';
import {
  INCUS_CLIENT_FACTORY,
  type IncusClientFactory,
} from '../runtime/reconcile-worker.service.js';
import {
  NODE_METRICS_PULL,
  type NodeMetricsPullPort,
} from '../runtime/server-preflight-reconciler.service.js';
import {
  applyNvidiaSmiIndexes,
  filterGpuInventoryByGrant,
  nvidiaGpuInventoryFromResources,
  nvidiaSmiIndexByPciFromSamples,
} from './gpu-inventory.js';

type ServerRow = Selectable<InfrastructureServerTable>;

@Injectable()
export class ServersService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly access: AccessResolverService,
    private readonly audit: AuditService,
    @Optional() private readonly config?: NyabaseConfigService,
    @Optional() private readonly infrastructure?: InfrastructureRepository,
    @Optional() private readonly proxySnapshots?: ProxySnapshotNotifierService,
    @Optional() @Inject(INCUS_CLIENT_FACTORY) private readonly clients?: IncusClientFactory,
    @Optional() @Inject(NODE_METRICS_PULL) private readonly nodeMetrics?: NodeMetricsPullPort,
  ) {}

  async create(actorId: string, input: CreateServerRequest): Promise<ServerDto> {
    const row = await this.transactions.run(async (transaction) => {
      await this.access.assertActorCapabilitiesInTransaction(transaction, actorId, [
        Capability.ManageServers,
      ]);
      if (this.infrastructure) {
        await this.infrastructure.lockServerCapacity(transaction);
      } else {
        await lockServerOnboarding(transaction);
      }
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
          api_endpoint: input.apiEndpoint,
          server_cert_fingerprint: null,
          incus_version: null,
          api_extensions: [],
          system_pool_id: null,
          storage_overcommit_ratio: 1,
          parent_interface: input.parentInterface,
          dns_servers: input.dnsServers,
          gpu_runtime_available: false,
          status: ServerStatus.Unknown,
          last_seen_at: null,
          last_error: null,
          revision: 1,
          node_metrics_endpoint: input.nodeMetrics?.endpoint ?? null,
          node_metrics_server_cert_fingerprint: input.nodeMetrics?.serverCertFingerprint ?? null,
          node_metrics_token_ciphertext: input.nodeMetrics
            ? this.encryptNodeMetricsToken(input.nodeMetrics.token)
            : null,
          node_metrics_token_fingerprint: input.nodeMetrics
            ? this.nodeMetricsTokenFingerprint(input.nodeMetrics.token)
            : null,
          node_metrics_status: input.nodeMetrics
            ? NodeMetricsStatus.Unknown
            : NodeMetricsStatus.Unconfigured,
          node_metrics_last_success_at: null,
          node_metrics_outage_since: null,
          node_metrics_last_error: null,
          preflight_status: PreflightStatus.NotRun,
          preflight_checked_at: null,
          preflight_report: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.append(transaction, actorId, AuditAction.CreateServer, server.id, 'server', {
        name: server.name,
        slug: server.slug,
      });
      return server;
    });
    return (await this.toDtos([row]))[0]!;
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

  async findDtosByIds(ids: string[]): Promise<ServerDto[]> {
    return this.toDtos(await this.findByIds(ids));
  }

  async findUserDtosByIds(ids: string[]): Promise<UserServerDto[]> {
    return (await this.findByIds(ids)).map((row) => this.toUserDto(row));
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

  async prepareConnection(serverId: string, expectedFingerprint: string): Promise<number> {
    const normalized = expectedFingerprint.replace(/[:-\s]/g, '').toLowerCase();
    const row = await this.transactions.run(async (transaction) => {
      const server = await transaction
        .selectFrom('infra.servers')
        .select(['server_cert_fingerprint', 'revision'])
        .where('id', '=', serverId)
        .forUpdate()
        .executeTakeFirst();
      if (!server) throw new NotFoundException('Server not found');
      if (
        server.server_cert_fingerprint &&
        server.server_cert_fingerprint.replace(/[:-\s]/g, '').toLowerCase() !== normalized
      ) {
        throw new ConflictException({
          code: 'PREFLIGHT_IDENTITY_MISMATCH',
          message: 'Expected server certificate fingerprint does not match the registered server',
        });
      }
      if (server.server_cert_fingerprint) return numberValue(server.revision);
      // The expected fingerprint is an admission hint, not a TOFU pin.
      // Only the mTLS transport may persist the fingerprint it observes.
      return numberValue(server.revision);
    });
    return numberValue(row);
  }

  async findUserDtoById(id: string): Promise<UserServerDto> {
    return this.toUserDto(await this.findById(id));
  }

  async listGpus(serverId: string): Promise<ServerGpuDto[]> {
    const server = await this.findById(serverId);
    if (!this.clients) {
      throw new NotFoundException('Server GPU inventory is unavailable');
    }
    const resources = await this.clients.get(serverId).then((client) => client.getResources());
    const cards = nvidiaGpuInventoryFromResources(resources.metadata);
    return applyNvidiaSmiIndexes(cards, await this.nvidiaSmiIndexByPci(server));
  }

  async listGpusForUser(userId: string, serverId: string): Promise<ServerGpuDto[]> {
    const grant = await this.access.resolveServer(userId, serverId);
    if (!grant || grant.accessPhase !== 'live') {
      throw new NotFoundException('Server not found');
    }
    if (grant.gpu.mode === GpuGrantMode.None) {
      return [];
    }
    const items = await this.listGpus(serverId);
    return filterGpuInventoryByGrant(items, {
      mode: grant.gpu.mode,
      pciAddresses: grant.gpu.pciAddresses,
    });
  }

  private async nvidiaSmiIndexByPci(server: ServerRow): Promise<ReadonlyMap<string, number>> {
    if (
      !this.nodeMetrics
      || !server.node_metrics_endpoint
      || !server.node_metrics_token_ciphertext
    ) {
      return new Map();
    }
    try {
      const result = await this.nodeMetrics.pull(
        server.id,
        server.node_metrics_endpoint,
        server.node_metrics_token_ciphertext,
      );
      return nvidiaSmiIndexByPciFromSamples(result.report?.samples ?? []);
    } catch {
      return new Map();
    }
  }

  async update(actorId: string, id: string, input: PatchServerRequest): Promise<ServerDto> {
    const row = await this.transactions.run(async (transaction) => {
      await this.access.assertActorCapabilitiesInTransaction(transaction, actorId, [
        Capability.ManageServers,
      ]);
      const current = await transaction
        .selectFrom('infra.servers')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundException('Server not found');
      const nodeMetrics = input.nodeMetrics;
      const nodeMetricsPatch =
        nodeMetrics === undefined
          ? {}
          : nodeMetrics === null
            ? {
                node_metrics_endpoint: null,
                node_metrics_server_cert_fingerprint: null,
                node_metrics_token_ciphertext: null,
                node_metrics_token_fingerprint: null,
                node_metrics_status: NodeMetricsStatus.Unconfigured,
                node_metrics_last_success_at: null,
                node_metrics_outage_since: null,
                node_metrics_last_error: null,
              }
            : {
                node_metrics_endpoint: nodeMetrics.endpoint,
                node_metrics_server_cert_fingerprint: nodeMetrics.serverCertFingerprint,
                ...(nodeMetrics.token === undefined
                  ? current.node_metrics_token_ciphertext
                    ? {
                        node_metrics_token_ciphertext: current.node_metrics_token_ciphertext,
                        node_metrics_token_fingerprint: current.node_metrics_token_fingerprint,
                      }
                    : (() => {
                        throw new ConflictException({
                          code: 'NODE_METRICS_TOKEN_REQUIRED',
                          message: 'A node metrics token is required for first-time configuration',
                        });
                      })()
                  : {
                      node_metrics_token_ciphertext: this.encryptNodeMetricsToken(
                        nodeMetrics.token,
                      ),
                      node_metrics_token_fingerprint: this.nodeMetricsTokenFingerprint(
                        nodeMetrics.token,
                      ),
                    }),
                node_metrics_status: NodeMetricsStatus.Unknown,
                node_metrics_last_success_at: null,
                node_metrics_outage_since: null,
                node_metrics_last_error: null,
              };
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
          ...nodeMetricsPatch,
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
        auditServerPatch(input),
      );
      return updated;
    });
    return (await this.toDtos([row]))[0]!;
  }

  async delete(actorId: string, id: string, expectedRevision?: number): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await this.access.assertActorCapabilitiesInTransaction(transaction, actorId, [
        Capability.ManageServers,
      ]);
      const server = await this.findById(id, transaction);
      if (expectedRevision !== undefined && Number(server.revision) !== expectedRevision) {
        throw new ConflictException({ code: 'REVISION_CONFLICT' });
      }
      await this.purgeServerControlPlane(id, transaction);
      await this.audit.append(transaction, actorId, AuditAction.DeleteServer, id, 'server', {
        name: server.name,
      });
    });
    this.proxySnapshots?.forgetServer(id, 'server_deleted');
  }

  private async purgeServerControlPlane(
    serverId: string,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
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
    const localVolumes = await transaction
      .selectFrom('control.volumes')
      .select('id')
      .where('server_id', '=', serverId)
      .execute();
    for (const volume of localVolumes) {
      await transaction.deleteFrom('control.volume_placements').where('volume_id', '=', volume.id).execute();
      await transaction.deleteFrom('control.volumes').where('id', '=', volume.id).execute();
    }
    const placementsOnS = await transaction
      .selectFrom('control.volume_placements as pl')
      .innerJoin('control.volumes as v', 'v.id', 'pl.volume_id')
      .select('pl.volume_id as volume_id')
      .where('pl.server_id', '=', serverId)
      .where('v.shared_backend_id', 'is not', null)
      .execute();
    const volumeIdsLostPlacement = new Set(placementsOnS.map((row) => row.volume_id));
    await transaction.deleteFrom('control.volume_placements').where('server_id', '=', serverId).execute();
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
      await this.audit.append(transaction, null, AuditAction.DeleteVolume, volume.id, 'volume', {
        reason,
      });
    }
    await transaction
      .deleteFrom('control.authorization_dependencies')
      .where('server_id', '=', serverId)
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
    await transaction.deleteFrom('system.incus_client_certificate_trusts').where('server_id', '=', serverId).execute();
    await transaction.deleteFrom('control.grant_expiry_enforcement').where('server_id', '=', serverId).execute();
    await transaction
      .updateTable('infra.servers')
      .set({ system_pool_id: null })
      .where('id', '=', serverId)
      .execute();
    await transaction.deleteFrom('infra.storage_pools').where('server_id', '=', serverId).execute();
    await transaction.deleteFrom('infra.servers').where('id', '=', serverId).execute();
  }

  private async serverReferences(
    serverId: string,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<string[]> {
    const [
      authorizationDependency,
      serverGrant,
      storagePool,
      imageAssignment,
      containerNetworkClaim,
      containerGpuClaim,
      containerSshRoute,
      intent,
      certificateTrust,
      ipPoolMembership,
    ] = await Promise.all([
      transaction
        .selectFrom('control.authorization_dependencies')
        .select('id')
        .where('server_id', '=', serverId)
        .limit(1)
        .executeTakeFirst(),
      transaction
        .selectFrom('iam.server_grants')
        .select('id')
        .where('server_id', '=', serverId)
        .limit(1)
        .executeTakeFirst(),
      transaction
        .selectFrom('infra.storage_pools')
        .select('id')
        .where('server_id', '=', serverId)
        .limit(1)
        .executeTakeFirst(),
      transaction
        .selectFrom('infra.image_server_assignments')
        .select('id')
        .where('server_id', '=', serverId)
        .limit(1)
        .executeTakeFirst(),
      transaction
        .selectFrom('control.container_network_claims')
        .select('id')
        .where('server_id', '=', serverId)
        .limit(1)
        .executeTakeFirst(),
      transaction
        .selectFrom('control.container_gpu_claims')
        .select('id')
        .where('server_id', '=', serverId)
        .limit(1)
        .executeTakeFirst(),
      transaction
        .selectFrom('control.container_ssh_routes')
        .select('container_id')
        .where('server_id', '=', serverId)
        .limit(1)
        .executeTakeFirst(),
      transaction
        .selectFrom('control.intents')
        .select('id')
        .where('server_id', '=', serverId)
        .limit(1)
        .executeTakeFirst(),
      transaction
        .selectFrom('system.incus_client_certificate_trusts')
        .select('certificate_id')
        .where('server_id', '=', serverId)
        .limit(1)
        .executeTakeFirst(),
      transaction
        .selectFrom('infra.ip_pool_servers')
        .select('pool_id')
        .where('server_id', '=', serverId)
        .limit(1)
        .executeTakeFirst(),
    ]);
    return [
      authorizationDependency && 'authorization_dependencies',
      serverGrant && 'server_grants',
      storagePool && 'storage_pools',
      imageAssignment && 'image_server_assignments',
      containerNetworkClaim && 'container_network_claims',
      containerGpuClaim && 'container_gpu_claims',
      containerSshRoute && 'container_ssh_routes',
      intent && 'intents',
      certificateTrust && 'incus_client_certificate_trusts',
      ipPoolMembership && 'ip_pool_servers',
    ].filter((value): value is string => Boolean(value));
  }

  private encryptNodeMetricsToken(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.nodeMetricsKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [
      'rfs-v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  private nodeMetricsTokenFingerprint(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private nodeMetricsKey(): Buffer {
    const secret = this.config
      ? this.config.keyEncryptionSecret()
      : process.env.JWT_SECRET || 'nyabase-node-metrics';
    return createHash('sha256').update(secret).digest();
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

  private toDto(row: ServerRow, systemPoolName: string | null = null): ServerDto {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      apiEndpoint: row.api_endpoint,
      serverCertFingerprint: row.server_cert_fingerprint,
      incusVersion: row.incus_version,
      apiExtensions: row.api_extensions,
      systemPoolId: row.system_pool_id,
      systemPoolName,
      storageOvercommitRatio: numberValue(row.storage_overcommit_ratio),
      parentInterface: row.parent_interface ?? '',
      dnsServers: row.dns_servers,
      gpuRuntimeAvailable: row.gpu_runtime_available,
      status: row.status as ServerStatus,
      lastSeenAt: isoDate(row.last_seen_at),
      lastError: row.last_error,
      revision: numberValue(row.revision),
      preflightStatus: row.preflight_status as PreflightStatus,
      preflightCheckedAt: isoDate(row.preflight_checked_at),
      preflightReport: row.preflight_report as ServerDto['preflightReport'],
      nodeMetrics: {
        endpoint: row.node_metrics_endpoint,
        serverCertFingerprint: row.node_metrics_server_cert_fingerprint,
        tokenFingerprint: row.node_metrics_token_fingerprint,
        health: {
          status: row.node_metrics_status as NodeMetricsStatus,
          lastSuccessAt: isoDate(row.node_metrics_last_success_at),
          outageSince: isoDate(row.node_metrics_outage_since),
          lastError: row.node_metrics_last_error,
        },
      },
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private toUserDto(row: ServerRow): UserServerDto {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status as ServerStatus,
      lastSeenAt: isoDate(row.last_seen_at),
      preflightStatus: row.preflight_status as PreflightStatus,
    };
  }
}

function auditServerPatch(input: PatchServerRequest): Record<string, unknown> {
  const { nodeMetrics, ...rest } = input;
  if (nodeMetrics === undefined) return rest;
  return {
    ...rest,
    nodeMetrics:
      nodeMetrics === null
        ? null
        : {
            endpoint: nodeMetrics.endpoint,
            serverCertFingerprint: nodeMetrics.serverCertFingerprint,
            ...(nodeMetrics.token === undefined ? {} : { tokenConfigured: true }),
          },
  };
}
