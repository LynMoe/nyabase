import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { assertListScope, type Actor, requireUserId } from '../iam/actor.js';
import {
  AuditAction,
  ContainerStatus,
  UserStatus,
  zCreateHttpProxyBindingRequest,
  zPatchHttpProxyBindingRequest,
  hostnameMatchesHttpProxyWildcard,
  httpProxyWarningMessage,
  CONTAINER_DELETE_PROXY_DRAIN_MS,
  MAX_HTTP_PROXY_ROUTES,
  normalizeHttpProxyHostname,
  type HttpProxyBindingDto,
  type HttpProxyBindingStatus,
  type HttpProxyWarningReason,
  type ListScope,
  Role,
} from '@nyabase/common';
import { AuditService } from '../iam/audit.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { poolHasSafeTlsLease } from './http-proxy-certificates.js';
import {
  BINDING_CAPACITY_LOCK,
  HOSTNAME_RESERVATION_LOCK,
  ROUTE_STALE_MS,
  isUniqueConstraintViolation,
  lockHttpProxy,
  routeMatchesContainer,
  runSerializable,
  type BindingRow,
  type ContainerRow,
  type DomainPoolRow,
  type HttpExecutor,
} from './http-proxy-state.js';

const MAX_HTTP_HOSTNAME_RESERVATIONS = MAX_HTTP_PROXY_ROUTES * 2;
/** One user cannot exhaust the platform-wide binding or hostname capacity. */
export const MAX_HTTP_PROXY_BINDINGS_PER_USER = 32;
export const MAX_HTTP_HOSTNAME_RESERVATIONS_PER_USER = MAX_HTTP_PROXY_BINDINGS_PER_USER * 2;
const HOSTNAME_RESERVATION_GC_BATCH = 256;

/**
 * Claim a hostname for a binding. A released hostname stays reserved while
 * the proxy drains, so it cannot be reused before old routes expire.
 */
async function reserveHostname(
  transaction: Transaction<NyabaseDatabase>,
  hostname: string,
  ownerId: string,
  bindingId: string,
): Promise<void> {
  await lockHttpProxy(transaction, HOSTNAME_RESERVATION_LOCK);
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
  // Draining hostnames count too: create/delete churn must not crowd others out.
  const owned = await transaction
    .selectFrom('interaction.http_hostname_reservations')
    .select((expression) => expression.fn.countAll<string>().as('count'))
    .where('owner_id', '=', ownerId)
    .executeTakeFirstOrThrow();
  if (Number(owned.count) >= MAX_HTTP_HOSTNAME_RESERVATIONS_PER_USER) {
    throw new ConflictException({
      code: 'HTTP_HOSTNAME_RESERVATION_USER_LIMIT_REACHED',
      message: `At most ${MAX_HTTP_HOSTNAME_RESERVATIONS_PER_USER} active or draining hostnames per user; `
        + 'released hostnames become free again after they drain',
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

/** Start draining a binding's hostname reservation. */
async function releaseHostname(
  transaction: Transaction<NyabaseDatabase>,
  binding: BindingRow,
): Promise<void> {
  await lockHttpProxy(transaction, HOSTNAME_RESERVATION_LOCK);
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

/** HTTP proxy bindings: hostnames owners point at one of their containers. */
@Injectable()
export class HttpProxyBindingsService {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly audit: AuditService,
  ) {}

  /** `scope=mine`: the caller's bindings; `scope=all`: every binding (operator). */
  async listBindings(
    actor: Actor,
    scope: ListScope,
    proxyOnline: boolean,
  ): Promise<HttpProxyBindingDto[]> {
    assertListScope(actor, scope, Role.Operator);
    let query = this.database
      .selectFrom('interaction.http_proxy_bindings')
      .selectAll()
      .orderBy('hostname');
    if (scope === 'mine') query = query.where('owner_id', '=', actor.userId);
    return this.bindingDtos(await query.execute(), requireUserId(actor), proxyOnline, this.database);
  }

  async createBinding(
    actor: Actor,
    input: unknown,
  ): Promise<HttpProxyBindingDto> {
    const requesterId = requireUserId(actor);
    const dto = zCreateHttpProxyBindingRequest.parse(input);
    const hostname = parseHttpProxyHostname(dto.hostname);
    const binding = await runSerializable(this.transactions, async (transaction) => {
      await lockHttpProxy(transaction, BINDING_CAPACITY_LOCK);
      const count = await this.bindingCount(transaction);
      if (count >= MAX_HTTP_PROXY_ROUTES) {
        throw new ConflictException({
          code: 'HTTP_PROXY_BINDING_CAPACITY_REACHED',
          message: `At most ${MAX_HTTP_PROXY_ROUTES} HTTP proxy bindings are supported`,
        });
      }
      if (await this.bindingCount(transaction, requesterId) >= MAX_HTTP_PROXY_BINDINGS_PER_USER) {
        throw new ConflictException({
          code: 'HTTP_PROXY_BINDING_USER_LIMIT_REACHED',
          message: `At most ${MAX_HTTP_PROXY_BINDINGS_PER_USER} HTTP proxy bindings per user`,
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
      await reserveHostname(transaction, hostname, requesterId, bindingId);
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
    actor: Actor,
    id: string,
    input: unknown,
  ): Promise<HttpProxyBindingDto> {
    const requesterId = requireUserId(actor);
    const dto = zPatchHttpProxyBindingRequest.parse(input);
    const saved = await runSerializable(this.transactions, async (transaction) => {
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
          await reserveHostname(transaction, nextHostname, requesterId, binding.id);
          await releaseHostname(transaction, binding);
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

  /** `scope=all` is the operator override, e.g. to clear another user's abusive bindings. */
  async deleteBinding(actor: Actor, id: string, scope: ListScope = 'mine'): Promise<void> {
    assertListScope(actor, scope, Role.Operator);
    const requesterId = requireUserId(actor);
    await runSerializable(this.transactions, async (transaction) => {
      const binding = await transaction
        .selectFrom('interaction.http_proxy_bindings')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!binding) throw new NotFoundException('Binding not found');
      if (scope === 'mine' && binding.owner_id !== requesterId) {
        throw new ForbiddenException('Only binding owner can delete it');
      }
      await this.assertRequesterActive(transaction, requesterId);
      await releaseHostname(transaction, binding);
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
        { hostname: binding.hostname, ownerId: binding.owner_id },
      );
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
          return container && routeMatchesContainer(route, container);
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
          targetUrl: route?.routed_ip
            ? `http://${route.routed_ip}:${binding.target_port}`
            : null,
          containerId: binding.container_id,
          containerName: container?.name ?? null,
          containerStatus: route?.instance_status as ContainerStatus
            ?? (container ? null : 'missing'),
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
      instance_name: string;
      routed_ip: string;
      instance_status: string;
      observed_at: Date;
    } | undefined,
    proxyOnline: boolean,
  ): HttpProxyWarningReason[] {
    const reasons: HttpProxyWarningReason[] = [];
    if (!proxyOnline) reasons.push('proxy_offline');
    if (!pool?.enabled) reasons.push('domain_pool_disabled');
    if (pool?.https_enabled && !poolHasSafeTlsLease(pool, Date.now())) {
      reasons.push('https_not_configured');
    }
    if (!container) reasons.push('container_deleted');
    if (!route || (container && route.server_id !== container.server_id)) {
      reasons.push('route_missing', 'container_instance_missing');
    } else {
      if (route.instance_status !== ContainerStatus.Running) {
        reasons.push('container_not_running');
      }
      if (!route.instance_name) reasons.push('container_instance_missing');
      if (!route.routed_ip) reasons.push('container_ip_missing');
      if (Date.now() - route.observed_at.getTime() > ROUTE_STALE_MS) {
        reasons.push('container_stale');
      }
    }
    return [...new Set(reasons)];
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

  private async bindingCount(executor: HttpExecutor, ownerId?: string): Promise<number> {
    let query = executor
      .selectFrom('interaction.http_proxy_bindings')
      .select((expression) => expression.fn.countAll<string>().as('count'));
    if (ownerId) query = query.where('owner_id', '=', ownerId);
    const row = await query.executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
