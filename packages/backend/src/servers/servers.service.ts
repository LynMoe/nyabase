import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AuditAction,
  Capability,
  MAX_PLATFORM_SERVERS,
  NodeMetricsStatus,
  PreflightStatus,
  ServerStatus,
  type CreateServerRequest,
  type ListScope,
  type PatchServerRequest,
  type ServerDto,
  type UserServerDto,
} from '@nyabase/common';
import type { InfrastructureServerTable } from '../platform/persistence-pg/infrastructure-database.types.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { AuditService } from '../iam/audit.service.js';
import { assertListScope, type Actor } from '../iam/actor.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { numberValue, isoDate, poolLabel } from '../platform/domain-utils.js';
import { lockServerOnboarding } from '../platform/persistence-pg/advisory-locks.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { purgeServerControlPlane } from './server-cascade-delete.js';

type ServerRow = Selectable<InfrastructureServerTable>;

@Injectable()
export class ServersService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly access: AccessResolverService,
    private readonly audit: AuditService,
    private readonly config: NyabaseConfigService,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
  ) {}

  async create(actorId: string, input: CreateServerRequest): Promise<ServerDto> {
    const row = await this.transactions.run(async (transaction) => {
      await this.access.assertActorCapabilitiesInTransaction(transaction, actorId, [
        Capability.ManageServers,
      ]);
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
          api_endpoint: input.apiEndpoint,
          server_cert_fingerprint: null,
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
          gpu_enabled: false,
          gpu_enabled_by: null,
          gpu_health: {},
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

  /**
   * `scope=mine`: the servers the caller holds a grant for, as user DTOs.
   * `scope=all`: every server, as full DTOs (`ManageServers` or `ManageGrants`).
   */
  async list(actor: Actor, scope: ListScope): Promise<ServerDto[] | UserServerDto[]> {
    assertListScope(actor, scope, Capability.ManageServers, Capability.ManageGrants);
    if (scope === 'all') return this.findAllDtos();
    return this.findUserDtosByIds(await this.access.listAccessibleServers(actor.userId));
  }

  /** `scope=mine` needs a grant (404 otherwise); `scope=all` needs `ManageServers`. */
  async get(actor: Actor, id: string, scope: ListScope): Promise<ServerDto | UserServerDto> {
    assertListScope(actor, scope, Capability.ManageServers);
    if (scope === 'all') return this.findDtoById(id);
    if (!(await this.access.listAccessibleServers(actor.userId)).includes(id)) {
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
    return (await this.toUserDtos([await this.findById(id)]))[0]!;
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
      await purgeServerControlPlane(transaction, this.audit, id);
      await this.audit.append(transaction, actorId, AuditAction.DeleteServer, id, 'server', {
        name: server.name,
      });
    });
    this.proxySnapshots.invalidate('server_deleted');
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
    return createHash('sha256').update(this.config.keyEncryptionSecret()).digest();
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
      apiEndpoint: row.api_endpoint,
      serverCertFingerprint: row.server_cert_fingerprint,
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
