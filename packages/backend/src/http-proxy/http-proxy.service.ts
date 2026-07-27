import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  X509Certificate,
} from 'crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';
import {
  AuditAction,
  Capability,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  ServerStatus,
  UserStatus,
  HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  CONTAINER_DELETE_PROXY_DRAIN_MS,
  MAX_HTTP_PROXY_SNAPSHOT_BYTES,
  MAX_HTTP_PROXY_ROUTES,
  MAX_HTTP_PROXY_DOMAIN_POOLS,
  MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH,
  MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH,
  zHttpProxySnapshot,
  httpProxyWarningMessage,
  hostnameMatchesHttpProxyWildcard,
  normalizeHttpProxyHostname,
  normalizeHttpProxyWildcardDomain,
  type HttpProxyBindingStatus,
  type HttpProxySnapshot,
  type HttpProxyWarningReason,
} from '@nyabase/common';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import type { ContainerControlTable } from '../containers/container-control-database.types.js';
import type { InfrastructureServerTable } from '../infrastructure/infrastructure-database.types.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  HttpDomainPoolTable,
  HttpProxyBindingTable,
} from './http-proxy-database.types.js';

const KEY_VERSION = 'v1';
const ROUTE_STALE_MS = 120_000;
const HTTP_PROXY_ADVISORY_NAMESPACE = 1_856_214_887;
const DOMAIN_POOL_MUTATION_LOCK = 1;
const BINDING_CAPACITY_LOCK = 2;
const HOSTNAME_RESERVATION_LOCK = 3;
export const MAX_HTTP_HOSTNAME_RESERVATIONS = MAX_HTTP_PROXY_ROUTES * 2;
const HOSTNAME_RESERVATION_GC_BATCH = 256;

type HttpExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;
type DomainPoolRow = Selectable<HttpDomainPoolTable>;
type BindingRow = Selectable<HttpProxyBindingTable>;
type ContainerRow = Selectable<ContainerControlTable>;
type ServerRow = Selectable<InfrastructureServerTable>;

export interface HttpProxyBindingDto {
  id: string;
  mine: boolean;
  ownerId: string;
  ownerUsername: string;
  hostname: string;
  domainPoolId: string;
  domainPool: string;
  targetUrl: string | null;
  containerId: string;
  containerName: string | null;
  containerStatus: ContainerStatus | 'missing' | null;
  targetPort: number;
  entryHttpsEnabled: boolean;
  status: HttpProxyBindingStatus;
  warningReasons: HttpProxyWarningReason[];
  warningMessage: string;
  createdAt: string;
  updatedAt: string;
}

export interface HttpDomainPoolDto {
  id: string;
  wildcardDomain: string;
  enabled: boolean;
  httpsEnabled: boolean;
  certificateFingerprint: string | null;
  certificateNotAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class HttpProxyService {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly config: NyabaseConfigService,
    @Inject(forwardRef(() => AccessResolverService))
    private readonly accessResolver: AccessResolverService,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
    private readonly audit: AuditService,
  ) {}

  async listBindings(
    requesterId: string,
    proxyOnline: boolean,
  ): Promise<HttpProxyBindingDto[]> {
    const bindings = await this.database
      .selectFrom('interaction.http_proxy_bindings')
      .selectAll()
      .where('owner_id', '=', requesterId)
      .orderBy('hostname')
      .execute();
    return this.bindingDtos(bindings, requesterId, proxyOnline, this.database);
  }

  async createBinding(
    requesterId: string,
    input: unknown,
  ): Promise<HttpProxyBindingDto> {
    const dto = parseBindingInput(input, false);
    const hostname = parseHttpProxyHostname(dto.hostname);
    const binding = await this.runSerializable(async (transaction) => {
      await this.lock(transaction, BINDING_CAPACITY_LOCK);
      const count = await this.bindingCount(transaction);
      if (count >= MAX_HTTP_PROXY_ROUTES) {
        throw new ConflictException({
          code: 'HTTP_PROXY_BINDING_CAPACITY_REACHED',
          message: `At most ${MAX_HTTP_PROXY_ROUTES} HTTP proxy bindings are supported`,
        });
      }
      const pool = await this.enabledPoolForHostname(transaction, hostname);
      const container = await this.findContainer(transaction, dto.containerId);
      if (!container) throw new NotFoundException('Container not found');
      if (container.owner_id !== requesterId) {
        throw new ForbiddenException('Container is not owned by current user');
      }
      await this.assertRequesterActive(transaction, requesterId);
      const bindingId = randomUUID();
      await this.reserveHostname(transaction, hostname, requesterId, bindingId);
      try {
        const row = await transaction
          .insertInto('interaction.http_proxy_bindings')
          .values({
            id: bindingId,
            hostname,
            domain_pool_id: pool.id,
            owner_id: requesterId,
            container_id: container.id,
            target_port: dto.targetPort,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit.append(
          transaction,
          requesterId,
          AuditAction.CreateHttpProxyBinding,
          row.id,
          'http_proxy_binding',
          {
            hostname: row.hostname,
            containerId: row.container_id,
            targetPort: row.target_port,
          },
        );
        return row;
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new ConflictException('Hostname is already occupied or draining');
        }
        throw error;
      }
    });
    return (await this.bindingDtos([binding], requesterId, false, this.database))[0]!;
  }

  async updateBinding(
    requesterId: string,
    id: string,
    input: unknown,
  ): Promise<HttpProxyBindingDto> {
    const dto = parseBindingInput(input, true);
    const saved = await this.runSerializable(async (transaction) => {
      const binding = await transaction
        .selectFrom('interaction.http_proxy_bindings')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!binding) throw new NotFoundException('Binding not found');
      if (binding.owner_id !== requesterId) {
        throw new ForbiddenException('Only binding owner can edit it');
      }
      await this.assertRequesterActive(transaction, requesterId);
      let hostname = binding.hostname;
      let domainPoolId = binding.domain_pool_id;
      if (dto.hostname !== undefined) {
        const nextHostname = parseHttpProxyHostname(dto.hostname);
        const pool = await this.enabledPoolForHostname(transaction, nextHostname);
        if (nextHostname !== binding.hostname) {
          await this.reserveHostname(transaction, nextHostname, requesterId, binding.id);
          await this.releaseHostname(transaction, binding);
          hostname = nextHostname;
          domainPoolId = pool.id;
        }
      }
      let containerId = binding.container_id;
      if (dto.containerId !== undefined) {
        const container = await this.findContainer(transaction, dto.containerId);
        if (!container) throw new NotFoundException('Container not found');
        if (container.owner_id !== requesterId) {
          throw new ForbiddenException('Container is not owned by current user');
        }
        containerId = container.id;
      }
      try {
        const row = await transaction
          .updateTable('interaction.http_proxy_bindings')
          .set({
            hostname,
            domain_pool_id: domainPoolId,
            container_id: containerId,
            target_port: dto.targetPort ?? binding.target_port,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit.append(
          transaction,
          requesterId,
          AuditAction.UpdateHttpProxyBinding,
          row.id,
          'http_proxy_binding',
          {
            hostname: row.hostname,
            containerId: row.container_id,
            targetPort: row.target_port,
          },
        );
        return row;
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new ConflictException('Hostname is already occupied or draining');
        }
        throw error;
      }
    });
    return (await this.bindingDtos([saved], requesterId, false, this.database))[0]!;
  }

  async deleteBinding(requesterId: string, id: string): Promise<void> {
    await this.runSerializable(async (transaction) => {
      const binding = await transaction
        .selectFrom('interaction.http_proxy_bindings')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!binding) throw new NotFoundException('Binding not found');
      if (binding.owner_id !== requesterId) {
        throw new ForbiddenException('Only binding owner can delete it');
      }
      await this.assertRequesterActive(transaction, requesterId);
      await this.releaseHostname(transaction, binding);
      await transaction
        .deleteFrom('interaction.http_proxy_bindings')
        .where('id', '=', id)
        .execute();
      await this.audit.append(
        transaction,
        requesterId,
        AuditAction.DeleteHttpProxyBinding,
        id,
        'http_proxy_binding',
      );
    });
  }

  async listDomainPools(): Promise<HttpDomainPoolDto[]> {
    const rows = await this.database
      .selectFrom('interaction.http_domain_pools')
      .selectAll()
      .orderBy('wildcard_domain')
      .execute();
    return rows.map((row) => this.domainPoolDto(row));
  }

  async createDomainPool(
    actorId: string,
    input: unknown,
  ): Promise<HttpDomainPoolDto> {
    const dto = parseDomainPoolInput(input, false);
    const wildcardDomain = parseHttpProxyWildcardDomain(dto.wildcardDomain);
    const certificate = this.certFields(
      dto.certificatePem,
      dto.privateKeyPem,
      wildcardDomain,
    );
    if (dto.httpsEnabled && !certificate.certificate_pem) {
      throw new BadRequestException('HTTPS requires a valid certificate and private key');
    }
    try {
      const row = await this.runSerializable(async (transaction) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageSystemSettings],
        );
        await this.lock(transaction, DOMAIN_POOL_MUTATION_LOCK);
        const existing = await transaction
          .selectFrom('interaction.http_domain_pools')
          .select('id')
          .where('wildcard_domain', '=', wildcardDomain)
          .executeTakeFirst();
        if (existing) throw duplicateDomainPoolConflict();
        const count = await this.domainPoolCount(transaction);
        if (count >= MAX_HTTP_PROXY_DOMAIN_POOLS) {
          throw new ConflictException({
            code: 'HTTP_PROXY_DOMAIN_POOL_CAPACITY_REACHED',
            message: `At most ${MAX_HTTP_PROXY_DOMAIN_POOLS} HTTP domain pools are supported`,
          });
        }
        const row = await transaction
          .insertInto('interaction.http_domain_pools')
          .values({
            id: randomUUID(),
            wildcard_domain: wildcardDomain,
            enabled: dto.enabled ?? true,
            https_enabled: dto.httpsEnabled ?? false,
            ...certificate,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.CreateHttpDomainPool,
          row.id,
          'http_domain_pool',
          this.domainPoolAuditDetails(row),
        );
        return row;
      });
      return this.domainPoolDto(row);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw duplicateDomainPoolConflict();
      throw error;
    }
  }

  async updateDomainPool(
    actorId: string,
    id: string,
    input: unknown,
  ): Promise<HttpDomainPoolDto> {
    const dto = parseDomainPoolInput(input, true);
    try {
      const row = await this.runSerializable(async (transaction) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageSystemSettings],
        );
        await this.lock(transaction, DOMAIN_POOL_MUTATION_LOCK);
        const current = await transaction
          .selectFrom('interaction.http_domain_pools')
          .selectAll()
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!current) throw new NotFoundException('Domain pool not found');

        let wildcardDomain = current.wildcard_domain;
        if (dto.wildcardDomain !== undefined) {
          const nextWildcard = parseHttpProxyWildcardDomain(dto.wildcardDomain);
          if (nextWildcard !== current.wildcard_domain) {
            const owner = await transaction
              .selectFrom('interaction.http_domain_pools')
              .select('id')
              .where('wildcard_domain', '=', nextWildcard)
              .executeTakeFirst();
            if (owner && owner.id !== current.id) throw duplicateDomainPoolConflict();
            const binding = await transaction
              .selectFrom('interaction.http_proxy_bindings')
              .select('id')
              .where('domain_pool_id', '=', id)
              .limit(1)
              .executeTakeFirst();
            if (binding) {
              throw new ConflictException(
                'Domain pool wildcard cannot change while bindings exist',
              );
            }
            wildcardDomain = nextWildcard;
          }
        }

        let certificate = {
          certificate_pem: current.certificate_pem,
          encrypted_private_key_pem: current.encrypted_private_key_pem,
          certificate_fingerprint: current.certificate_fingerprint,
          certificate_not_after: current.certificate_not_after,
        };
        if (dto.certificatePem !== undefined || dto.privateKeyPem !== undefined) {
          if (dto.certificatePem === undefined || dto.privateKeyPem === undefined) {
            throw new BadRequestException(
              'certificatePem and privateKeyPem must be updated together',
            );
          }
          certificate = this.certFields(
            dto.certificatePem,
            dto.privateKeyPem,
            wildcardDomain,
          );
        } else if (current.certificate_pem) {
          this.validateCertificate(current.certificate_pem, wildcardDomain);
        }
        const httpsEnabled = dto.httpsEnabled ?? current.https_enabled;
        if (
          httpsEnabled
          && (!certificate.certificate_pem || !certificate.encrypted_private_key_pem)
        ) {
          throw new BadRequestException('HTTPS requires a valid certificate and private key');
        }
        const row = await transaction
          .updateTable('interaction.http_domain_pools')
          .set({
            wildcard_domain: wildcardDomain,
            enabled: dto.enabled ?? current.enabled,
            https_enabled: httpsEnabled,
            ...certificate,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.UpdateHttpDomainPool,
          row.id,
          'http_domain_pool',
          this.domainPoolAuditDetails(row),
        );
        return row;
      });
      return this.domainPoolDto(row);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw duplicateDomainPoolConflict();
      throw error;
    }
  }

  async deleteDomainPool(actorId: string, id: string): Promise<void> {
    await this.runSerializable(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageSystemSettings],
      );
      await this.lock(transaction, DOMAIN_POOL_MUTATION_LOCK);
      const row = await transaction
        .selectFrom('interaction.http_domain_pools')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Domain pool not found');
      const binding = await transaction
        .selectFrom('interaction.http_proxy_bindings')
        .select('id')
        .where('domain_pool_id', '=', id)
        .limit(1)
        .executeTakeFirst();
      if (binding) throw new ConflictException('Domain pool still has bindings');
      await transaction
        .deleteFrom('interaction.http_domain_pools')
        .where('id', '=', id)
        .execute();
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.DeleteHttpDomainPool,
        id,
        'http_domain_pool',
      );
    });
  }

  buildSnapshot(): Promise<HttpProxySnapshot> {
    return this.runSerializable(async (transaction) => {
      const state = await transaction
        .selectFrom('interaction.http_proxy_snapshot_state')
        .selectAll()
        .where('singleton', '=', true)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const now = await this.databaseNow(transaction);
      const [
        bindings,
        pools,
        containers,
        routes,
        users,
        servers,
        runtimeReadyServers,
        addressClaims,
        containerMounts,
        remoteAssignments,
      ] = await Promise.all([
        transaction.selectFrom('interaction.http_proxy_bindings').selectAll().execute(),
        transaction.selectFrom('interaction.http_domain_pools').selectAll().execute(),
        transaction.selectFrom('control.containers').selectAll().execute(),
        transaction.selectFrom('control.container_ssh_routes').selectAll().execute(),
        transaction.selectFrom('iam.users')
          .select(['id', 'status'])
          .where('status', '=', UserStatus.Active)
          .execute(),
        transaction.selectFrom('infra.servers').selectAll().execute(),
        transaction
          .selectFrom('workflow.agent_runtime_projections as projection')
          .innerJoin(
            'workflow.agent_sessions as session',
            'session.id',
            'projection.session_id',
          )
          .select('projection.server_id')
          .where('projection.runtime_ready', '=', true)
          .where('session.state', '=', 'ready')
          .where('session.lease_expires_at', '>', sql<Date>`clock_timestamp()`)
          .whereRef('session.generation', '=', 'projection.session_generation')
          .whereRef('session.gateway_id', '=', 'projection.gateway_id')
          .execute(),
        transaction.selectFrom('control.container_network_claims')
          .selectAll()
          .where('state', '=', 'active')
          .execute(),
        transaction.selectFrom('control.container_mounts')
          .selectAll()
          .where('source_kind', '=', 'remote')
          .execute(),
        transaction.selectFrom('infra.remote_fs_server_assignments').selectAll().execute(),
      ]);
      const poolsById = new Map(pools.map((row) => [row.id, row]));
      const containersById = new Map(containers.map((row) => [row.id, row]));
      const claimsByAddress = new Map<string, typeof addressClaims>();
      for (const claim of addressClaims) {
        const claims = claimsByAddress.get(claim.address) ?? [];
        claims.push(claim);
        claimsByAddress.set(claim.address, claims);
      }
      const activeRemoteAssignments = new Set(
        remoteAssignments
          .filter((assignment) => assignment.desired_state === 'active')
          .map((assignment) =>
            `${assignment.server_id}|${assignment.remote_fs_mount_id}`),
      );
      const unsafeRemoteConsumerIds = new Set(
        containerMounts
          .filter((mount) =>
            !activeRemoteAssignments.has(`${mount.server_id}|${mount.source_id}`))
          .map((mount) => mount.container_id),
      );
      const runtimeReadyServerIds = new Set(
        runtimeReadyServers.map((row) => row.server_id),
      );
      const onlineServerIds = new Set(
        servers
          .filter((server) =>
            runtimeReadyServerIds.has(server.id)
            && this.serverCanProxy(server))
          .map((server) => server.id),
      );
      const activeUserIds = new Set(users.map((user) => user.id));
      const routesByContainerId = new Map(
        routes
          .filter((route) => {
            const container = containersById.get(route.container_id);
            return container && this.routeMatchesContainer(route, container);
          })
          .map((route) => [route.container_id, route]),
      );
      const createdAtMs = now.getTime();
      const routable = bindings.flatMap((binding) => {
        const pool = poolsById.get(binding.domain_pool_id);
        const container = containersById.get(binding.container_id);
        const route = routesByContainerId.get(binding.container_id);
        if (
          !pool?.enabled
          || !container
          || !route
          || unsafeRemoteConsumerIds.has(container.id)
          || !activeUserIds.has(binding.owner_id)
          || !onlineServerIds.has(container.server_id)
        ) return [];
        if (container.owner_id !== binding.owner_id) return [];
        if (route.server_id !== container.server_id) return [];
        if (!hostnameMatchesHttpProxyWildcard(
          binding.hostname,
          pool.wildcard_domain,
        )) return [];
        if (
          pool.https_enabled
          && (!pool.certificate_pem || !pool.encrypted_private_key_pem)
        ) return [];
        if (!route.macvlan_ip || route.runtime_status !== ContainerStatus.Running) {
          return [];
        }
        const claimsForAddress = claimsByAddress.get(route.macvlan_ip) ?? [];
        const exactClaim = claimsForAddress.find((claim) =>
          claim.owner_kind === 'container'
          && claim.owner_id === container.id
          && claim.server_id === container.server_id);
        if (claimsForAddress.length !== 1 || !exactClaim) return [];
        const routeAge = createdAtMs - route.observed_at.getTime();
        if (routeAge < 0 || routeAge > ROUTE_STALE_MS) return [];
        return [{
          bindingId: binding.id,
          hostname: binding.hostname,
          domainPoolId: pool.id,
          targetIp: route.macvlan_ip,
          targetPort: binding.target_port,
          ownerId: binding.owner_id,
          containerId: container.id,
          containerName: container.name,
          runtimeId: route.runtime_id,
          runtimeStatus: route.runtime_status,
        }];
      });
      const nextGeneration = safeGeneration(state.generation) + 1;
      const snapshot = zHttpProxySnapshot.parse({
        generation: nextGeneration,
        createdAt: now.toISOString(),
        staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        validUntil: createdAtMs + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        routes: routable,
        domainPools: pools
          .filter((pool) =>
            pool.enabled
            && pool.https_enabled
            && this.poolHasSafeTlsLease(pool, createdAtMs))
          .map((pool) => ({
            id: pool.id,
            wildcardDomain: pool.wildcard_domain,
            enabled: pool.enabled,
            httpsEnabled: pool.https_enabled,
            certificatePem: pool.certificate_pem,
            privateKeyPem: this.decrypt(pool.encrypted_private_key_pem!),
            certificateFingerprint: pool.certificate_fingerprint,
            certificateNotAfter: pool.certificate_not_after?.toISOString() ?? null,
          })),
      });
      const wireEnvelope = JSON.stringify({
        ts: Number.MAX_SAFE_INTEGER,
        kind: 'snapshot',
        payload: snapshot,
      });
      const encodedBytes = Buffer.byteLength(wireEnvelope);
      if (encodedBytes > MAX_HTTP_PROXY_SNAPSHOT_BYTES) {
        throw new Error(
          `HTTP proxy snapshot is ${encodedBytes} bytes; maximum is ${MAX_HTTP_PROXY_SNAPSHOT_BYTES}`,
        );
      }
      await transaction
        .updateTable('interaction.http_proxy_snapshot_state')
        .set({
          generation: nextGeneration,
          lease_issued_at: now,
          lease_valid_until: new Date(
            createdAtMs + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
          ),
          payload_sha256: createHash('sha256')
            .update(JSON.stringify(snapshot))
            .digest('hex'),
          updated_at: now,
        })
        .where('singleton', '=', true)
        .executeTakeFirstOrThrow();
      return snapshot;
    });
  }

  private async enabledPoolForHostname(
    executor: HttpExecutor,
    hostname: string,
  ): Promise<DomainPoolRow> {
    const pools = await executor
      .selectFrom('interaction.http_domain_pools')
      .selectAll()
      .where('enabled', '=', true)
      .orderBy('wildcard_domain')
      .execute();
    const pool = pools.find((row) =>
      hostnameMatchesHttpProxyWildcard(hostname, row.wildcard_domain));
    if (!pool) {
      throw new BadRequestException(
        'Hostname is not under an enabled wildcard domain pool',
      );
    }
    return pool;
  }

  private async reserveHostname(
    transaction: Transaction<NyabaseDatabase>,
    hostname: string,
    ownerId: string,
    bindingId: string,
  ): Promise<void> {
    await this.lock(transaction, HOSTNAME_RESERVATION_LOCK);
    const expired = await transaction
      .selectFrom('interaction.http_hostname_reservations')
      .select('hostname')
      .where('state', '=', 'releasing')
      .where('reusable_at', '<=', sql<Date>`clock_timestamp()`)
      .orderBy('reusable_at')
      .orderBy('hostname')
      .limit(HOSTNAME_RESERVATION_GC_BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    if (expired.length > 0) {
      await transaction
        .deleteFrom('interaction.http_hostname_reservations')
        .where('hostname', 'in', expired.map((row) => row.hostname))
        .where('state', '=', 'releasing')
        .where('reusable_at', '<=', sql<Date>`clock_timestamp()`)
        .execute();
    }
    const [existingBinding, reservation] = await Promise.all([
      transaction
        .selectFrom('interaction.http_proxy_bindings')
        .select('id')
        .where('hostname', '=', hostname)
        .executeTakeFirst(),
      transaction
        .selectFrom('interaction.http_hostname_reservations')
        .select('hostname')
        .where('hostname', '=', hostname)
        .executeTakeFirst(),
    ]);
    if (existingBinding || reservation) {
      throw new ConflictException('Hostname is already occupied or draining');
    }
    const count = await transaction
      .selectFrom('interaction.http_hostname_reservations')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    if (Number(count.count) >= MAX_HTTP_HOSTNAME_RESERVATIONS) {
      throw new ConflictException({
        code: 'HTTP_HOSTNAME_RESERVATION_CAPACITY_REACHED',
        message: `At most ${MAX_HTTP_HOSTNAME_RESERVATIONS} active or draining hostnames are supported`,
      });
    }
    try {
      await transaction
        .insertInto('interaction.http_hostname_reservations')
        .values({
          hostname,
          owner_id: ownerId,
          binding_id: bindingId,
          state: 'active',
          reusable_at: null,
          release_generation: 0,
        })
        .execute();
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException('Hostname is already occupied or draining');
      }
      throw error;
    }
  }

  private async releaseHostname(
    transaction: Transaction<NyabaseDatabase>,
    binding: BindingRow,
  ): Promise<void> {
    await this.lock(transaction, HOSTNAME_RESERVATION_LOCK);
    const result = await transaction
      .updateTable('interaction.http_hostname_reservations')
      .set({
        state: 'releasing',
        binding_id: null,
        reusable_at: sql<Date>`
          clock_timestamp()
            + (${CONTAINER_DELETE_PROXY_DRAIN_MS} * interval '1 millisecond')
        `,
        release_generation: sql`release_generation + 1`,
      })
      .where('hostname', '=', binding.hostname)
      .where('owner_id', '=', binding.owner_id)
      .where('binding_id', '=', binding.id)
      .where('state', '=', 'active')
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new ConflictException(
        'Hostname reservation identity is missing or inconsistent',
      );
    }
  }

  private async bindingDtos(
    bindings: readonly BindingRow[],
    requesterId: string,
    proxyOnline: boolean,
    executor: HttpExecutor,
  ): Promise<HttpProxyBindingDto[]> {
    if (bindings.length === 0) return [];
    const poolIds = [...new Set(bindings.map((row) => row.domain_pool_id))];
    const containerIds = [...new Set(bindings.map((row) => row.container_id))];
    const ownerIds = [...new Set(bindings.map((row) => row.owner_id))];
    const [pools, containers, routes, users] = await Promise.all([
      executor.selectFrom('interaction.http_domain_pools')
        .selectAll()
        .where('id', 'in', poolIds)
        .execute(),
      executor.selectFrom('control.containers')
        .selectAll()
        .where('id', 'in', containerIds)
        .execute(),
      executor.selectFrom('control.container_ssh_routes')
        .selectAll()
        .where('container_id', 'in', containerIds)
        .execute(),
      executor.selectFrom('iam.users')
        .select(['id', 'username', 'status'])
        .where('id', 'in', ownerIds)
        .execute(),
    ]);
    const poolsById = new Map(pools.map((row) => [row.id, row]));
    const containersById = new Map(containers.map((row) => [row.id, row]));
    const routesByContainerId = new Map(
      routes
        .filter((route) => {
          const container = containersById.get(route.container_id);
          return container && this.routeMatchesContainer(route, container);
        })
        .map((row) => [row.container_id, row]),
    );
    const usersById = new Map(users.map((row) => [row.id, row]));
    return bindings
      .filter((binding) =>
        usersById.get(binding.owner_id)?.status === UserStatus.Active)
      .map((binding) => {
        const pool = poolsById.get(binding.domain_pool_id);
        const container = containersById.get(binding.container_id);
        const route = routesByContainerId.get(binding.container_id);
        const reasons = this.warningReasons(pool, container, route, proxyOnline);
        const status: HttpProxyBindingStatus = pool?.enabled === false
          ? 'disabled'
          : reasons.length > 0
            ? 'warning'
            : 'ready';
        return {
          id: binding.id,
          mine: binding.owner_id === requesterId,
          ownerId: binding.owner_id,
          ownerUsername: usersById.get(binding.owner_id)?.username ?? binding.owner_id,
          hostname: binding.hostname,
          domainPoolId: binding.domain_pool_id,
          domainPool: pool?.wildcard_domain ?? binding.domain_pool_id,
          targetUrl: route?.macvlan_ip
            ? `http://${route.macvlan_ip}:${binding.target_port}`
            : null,
          containerId: binding.container_id,
          containerName: container?.name ?? null,
          containerStatus: route?.runtime_status ?? (container ? null : 'missing'),
          targetPort: binding.target_port,
          entryHttpsEnabled: Boolean(pool?.https_enabled),
          status,
          warningReasons: reasons,
          warningMessage: httpProxyWarningMessage(reasons),
          createdAt: binding.created_at.toISOString(),
          updatedAt: binding.updated_at.toISOString(),
        };
      });
  }

  private warningReasons(
    pool: DomainPoolRow | undefined,
    container: ContainerRow | undefined,
    route: {
      server_id: string;
      runtime_id: string;
      macvlan_ip: string | null;
      runtime_status: ContainerStatus;
      observed_at: Date;
    } | undefined,
    proxyOnline: boolean,
  ): HttpProxyWarningReason[] {
    const reasons: HttpProxyWarningReason[] = [];
    if (!proxyOnline) reasons.push('proxy_offline');
    if (!pool?.enabled) reasons.push('domain_pool_disabled');
    if (pool?.https_enabled && !this.poolHasSafeTlsLease(pool, Date.now())) {
      reasons.push('https_not_configured');
    }
    if (!container) reasons.push('container_deleted');
    if (!route || (container && route.server_id !== container.server_id)) {
      reasons.push('route_missing', 'container_runtime_missing');
    } else {
      if (route.runtime_status !== ContainerStatus.Running) {
        reasons.push('container_not_running');
      }
      if (!route.runtime_id) reasons.push('container_runtime_missing');
      if (!route.macvlan_ip) reasons.push('container_ip_missing');
      if (Date.now() - route.observed_at.getTime() > ROUTE_STALE_MS) {
        reasons.push('container_runtime_stale');
      }
    }
    return [...new Set(reasons)];
  }

  private routeMatchesContainer(
    route: {
      runtime_id: string;
    },
    container: ContainerRow,
  ): boolean {
    return container.lifecycle_phase === ContainerPhase.Active
      && container.active_task_id === null
      && container.bound_runtime_id === route.runtime_id
      && container.power_intent === ContainerPowerIntent.Running;
  }

  private serverCanProxy(server: ServerRow): boolean {
    return server.status === ServerStatus.Online
      && Boolean(server.macvlan_cidr);
  }

  private poolHasSafeTlsLease(pool: DomainPoolRow, now: number): boolean {
    return Boolean(
      pool.certificate_pem
      && pool.encrypted_private_key_pem
      && pool.certificate_not_after
      && pool.certificate_not_after.getTime() > now
        + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS
        + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
    );
  }

  private domainPoolDto(row: DomainPoolRow): HttpDomainPoolDto {
    return {
      id: row.id,
      wildcardDomain: row.wildcard_domain,
      enabled: row.enabled,
      httpsEnabled: row.https_enabled,
      certificateFingerprint: row.certificate_fingerprint,
      certificateNotAfter: row.certificate_not_after?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private domainPoolAuditDetails(row: DomainPoolRow) {
    return {
      wildcardDomain: row.wildcard_domain,
      enabled: row.enabled,
      httpsEnabled: row.https_enabled,
      certificateFingerprint: row.certificate_fingerprint,
    };
  }

  private certFields(
    certificatePem: string | null | undefined,
    privateKeyPem: string | null | undefined,
    wildcardDomain: string,
  ): {
    certificate_pem: string | null;
    encrypted_private_key_pem: string | null;
    certificate_fingerprint: string | null;
    certificate_not_after: Date | null;
  } {
    if (!certificatePem && !privateKeyPem) {
      return {
        certificate_pem: null,
        encrypted_private_key_pem: null,
        certificate_fingerprint: null,
        certificate_not_after: null,
      };
    }
    if (!certificatePem || !privateKeyPem) {
      throw new BadRequestException(
        'Both certificatePem and privateKeyPem are required when configuring HTTPS',
      );
    }
    const cert = this.validateCertificate(certificatePem, wildcardDomain);
    try {
      const privateKey = createPrivateKey(privateKeyPem);
      if (!cert.checkPrivateKey(privateKey)) {
        throw new BadRequestException('Certificate and private key do not match');
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Invalid private key PEM');
    }
    return {
      certificate_pem: certificatePem,
      encrypted_private_key_pem: this.encrypt(privateKeyPem),
      certificate_fingerprint: cert.fingerprint256,
      certificate_not_after: new Date(cert.validTo),
    };
  }

  private validateCertificate(
    certificatePem: string,
    wildcardDomain: string,
  ): X509Certificate {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(certificatePem);
    } catch {
      throw new BadRequestException('Invalid certificate PEM');
    }
    const validFrom = Date.parse(cert.validFrom);
    const validTo = Date.parse(cert.validTo);
    const now = Date.now();
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > now) {
      throw new BadRequestException('Certificate is not currently valid');
    }
    const minimumValidTo = now
      + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS
      + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS;
    if (validTo <= minimumValidTo) {
      throw new BadRequestException(
        'Certificate expires before the proxy snapshot lease can safely drain',
      );
    }
    if (cert.checkHost(wildcardDomain) !== wildcardDomain) {
      throw new BadRequestException(
        `Certificate does not cover wildcard domain ${wildcardDomain}`,
      );
    }
    return cert;
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      KEY_VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  private decrypt(value: string): string {
    const [version, ivRaw, tagRaw, ciphertextRaw] = value.split('.');
    if (version !== KEY_VERSION || !ivRaw || !tagRaw || !ciphertextRaw) {
      throw new Error('Unsupported encrypted HTTP proxy key format');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(ivRaw, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private key(): Buffer {
    const secret = this.config.get<string>('ssh.keyEncryptionSecret')
      || this.config.get<string>('auth.jwtSecret');
    return createHash('sha256').update(secret).digest();
  }

  private async assertRequesterActive(
    transaction: Transaction<NyabaseDatabase>,
    requesterId: string,
  ): Promise<void> {
    const requester = await transaction
      .selectFrom('iam.users')
      .select('id')
      .where('id', '=', requesterId)
      .where('status', '=', UserStatus.Active)
      .forKeyShare()
      .executeTakeFirst();
    if (!requester) {
      throw new ForbiddenException('Current user is no longer active');
    }
  }

  private findContainer(
    executor: HttpExecutor,
    id: string,
  ): Promise<ContainerRow | undefined> {
    return executor
      .selectFrom('control.containers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  private async bindingCount(executor: HttpExecutor): Promise<number> {
    const row = await executor
      .selectFrom('interaction.http_proxy_bindings')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  private async domainPoolCount(executor: HttpExecutor): Promise<number> {
    const row = await executor
      .selectFrom('interaction.http_domain_pools')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  private async lock(
    transaction: Transaction<NyabaseDatabase>,
    key: number,
  ): Promise<void> {
    await sql`select pg_advisory_xact_lock(
      ${HTTP_PROXY_ADVISORY_NAMESPACE},
      ${key}
    )`.execute(transaction);
  }

  private async databaseNow(
    executor: HttpExecutor,
  ): Promise<Date> {
    const result = await sql<{ now: Date }>`
      select clock_timestamp() as now
    `.execute(executor);
    return result.rows[0]!.now;
  }

  private runSerializable<T>(
    work: (transaction: Transaction<NyabaseDatabase>) => Promise<T>,
  ): Promise<T> {
    return this.transactions.run(work, {
      isolationLevel: 'serializable',
      maxAttempts: 5,
    });
  }
}

function safeGeneration(value: string | number | bigint): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('HTTP proxy snapshot generation exceeds the safe application range');
  }
  return generation;
}

function parseBindingInput(input: unknown, partial: boolean) {
  const record = objectInput(input);
  assertExactKeys(record, ['hostname', 'containerId', 'targetPort']);
  const parsed: {
    hostname?: string;
    containerId?: string;
    targetPort?: number;
  } = {};
  if (!partial || record.hostname !== undefined) {
    parsed.hostname = stringField(record.hostname, 'hostname');
  }
  if (!partial || record.containerId !== undefined) {
    parsed.containerId = stringField(record.containerId, 'containerId');
  }
  if (!partial || record.targetPort !== undefined) {
    parsed.targetPort = portField(record.targetPort);
  }
  if (partial && Object.keys(parsed).length === 0) {
    throw new BadRequestException('At least one binding field must be updated');
  }
  return parsed as typeof parsed & {
    hostname: string;
    containerId: string;
    targetPort: number;
  };
}

function parseDomainPoolInput(input: unknown, partial: boolean) {
  const record = objectInput(input);
  assertExactKeys(record, [
    'wildcardDomain',
    'enabled',
    'httpsEnabled',
    'certificatePem',
    'privateKeyPem',
  ]);
  const parsed: {
    wildcardDomain?: string;
    enabled?: boolean;
    httpsEnabled?: boolean;
    certificatePem?: string | null;
    privateKeyPem?: string | null;
  } = {};
  if (!partial || record.wildcardDomain !== undefined) {
    parsed.wildcardDomain = stringField(record.wildcardDomain, 'wildcardDomain');
  }
  if (record.enabled !== undefined) {
    parsed.enabled = booleanField(record.enabled, 'enabled');
  }
  if (record.httpsEnabled !== undefined) {
    parsed.httpsEnabled = booleanField(record.httpsEnabled, 'httpsEnabled');
  }
  if (record.certificatePem !== undefined) {
    parsed.certificatePem = nullableBoundedStringField(
      record.certificatePem,
      'certificatePem',
      MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH,
    );
  }
  if (record.privateKeyPem !== undefined) {
    parsed.privateKeyPem = nullableBoundedStringField(
      record.privateKeyPem,
      'privateKeyPem',
      MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH,
    );
  }
  if (partial && Object.keys(parsed).length === 0) {
    throw new BadRequestException('At least one domain pool field must be updated');
  }
  return parsed as typeof parsed & { wildcardDomain: string };
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new BadRequestException(`Unknown request field: ${unknown.sort()[0]}`);
  }
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('Request body must be an object');
  }
  return input as Record<string, unknown>;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${name} is required`);
  }
  return value.trim();
}

function nullableStringField(value: unknown, name: string): string | null {
  if (value === null || value === '') return null;
  return stringField(value, name);
}

function nullableBoundedStringField(
  value: unknown,
  name: string,
  maxLength: number,
): string | null {
  const parsed = nullableStringField(value, name);
  if (parsed !== null && parsed.length > maxLength) {
    throw new BadRequestException(
      `${name} must not exceed ${maxLength} characters`,
    );
  }
  return parsed;
}

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${name} must be boolean`);
  }
  return value;
}

function portField(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 1
    || value > 65535
  ) {
    throw new BadRequestException(
      'targetPort must be an integer between 1 and 65535',
    );
  }
  return value;
}

function parseHttpProxyHostname(value: string): string {
  try {
    return normalizeHttpProxyHostname(value);
  } catch {
    throw new BadRequestException({
      code: 'INVALID_HTTP_PROXY_HOSTNAME',
      message: 'hostname must be a valid ASCII DNS hostname without a wildcard',
    });
  }
}

function parseHttpProxyWildcardDomain(value: string): string {
  try {
    return normalizeHttpProxyWildcardDomain(value);
  } catch {
    throw new BadRequestException({
      code: 'INVALID_HTTP_PROXY_WILDCARD_DOMAIN',
      message: 'wildcardDomain must be a valid ASCII DNS wildcard domain',
    });
  }
}

function duplicateDomainPoolConflict(): ConflictException {
  return new ConflictException({
    code: 'HTTP_PROXY_DOMAIN_POOL_EXISTS',
    message: 'A domain pool already owns this wildcard domain',
  });
}

function isUniqueConstraintViolation(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === '23505') return true;
    current = record.cause;
  }
  return false;
}
