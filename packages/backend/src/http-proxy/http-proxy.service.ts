import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  X509Certificate,
} from 'crypto';
import { DataSource, EntityManager, In, LessThanOrEqual, Repository } from 'typeorm';
import {
  ContainerStatus,
  ContainerPhase,
  ContainerPowerIntent,
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
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { HttpDomainPoolEntity } from '../entities/http-domain-pool.entity.js';
import { HttpProxyBindingEntity } from '../entities/http-proxy-binding.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { HttpHostnameReservationEntity } from '../entities/http-hostname-reservation.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import {
  hostnameReuseKey,
  monotonicReuseGuard,
} from '../common/monotonic-reuse-guard.js';

const KEY_VERSION = 'v1';
const ROUTE_STALE_MS = 120_000;
export const MAX_HTTP_HOSTNAME_RESERVATIONS = MAX_HTTP_PROXY_ROUTES * 2;
const HOSTNAME_RESERVATION_GC_BATCH = 256;

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
  private generation = 0;
  private snapshotBuildTail: Promise<void> = Promise.resolve();

  constructor(
    @InjectRepository(HttpDomainPoolEntity)
    private domainPoolsRepo: Repository<HttpDomainPoolEntity>,
    @InjectRepository(HttpProxyBindingEntity)
    private bindingsRepo: Repository<HttpProxyBindingEntity>,
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
    @InjectRepository(ContainerLifecycleEntity)
    private lifecyclesRepo: Repository<ContainerLifecycleEntity>,
    @InjectRepository(ContainerDesiredSpecEntity)
    private desiredSpecsRepo: Repository<ContainerDesiredSpecEntity>,
    @InjectRepository(ContainerSshRouteEntity)
    private routesRepo: Repository<ContainerSshRouteEntity>,
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    private config: NyabaseConfigService,
    private dataSource: DataSource,
    private proxySnapshots: ProxySnapshotNotifierService = {
      isServerBlocked: () => false,
    } as unknown as ProxySnapshotNotifierService,
  ) {}

  async listBindings(requesterId: string, proxyOnline: boolean): Promise<HttpProxyBindingDto[]> {
    const bindings = await this.bindingsRepo.find({
      where: { ownerId: requesterId },
      order: { hostname: 'ASC' },
    });
    return this.bindingDtos(bindings.filter((binding) => binding.ownerId === requesterId), requesterId, proxyOnline);
  }

  async createBinding(requesterId: string, input: unknown): Promise<HttpProxyBindingDto> {
    const dto = parseBindingInput(input, false);
    const hostname = normalizeHttpProxyHostname(dto.hostname);
    const binding = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (await manager.count(HttpProxyBindingEntity) >= MAX_HTTP_PROXY_ROUTES) {
        throw new ConflictException({
          code: 'HTTP_PROXY_BINDING_CAPACITY_REACHED',
          message: `At most ${MAX_HTTP_PROXY_ROUTES} HTTP proxy bindings are supported`,
        });
      }
      const pool = await this.enabledPoolForHostname(manager, hostname);
      const container = await manager.findOneBy(ContainerEntity, { id: dto.containerId });
      if (!container) throw new NotFoundException('Container not found');
      if (container.ownerId !== requesterId) {
        throw new ForbiddenException('Container is not owned by current user');
      }
      const bindingId = randomUUID();
      await this.reserveHostname(manager, hostname, requesterId, bindingId);
      return manager.save(HttpProxyBindingEntity, manager.create(HttpProxyBindingEntity, {
        id: bindingId,
        hostname,
        domainPoolId: pool.id,
        ownerId: requesterId,
        containerId: container.id,
        targetPort: dto.targetPort,
      }));
    });
    return (await this.bindingDtos([binding], requesterId, false))[0]!;
  }

  async updateBinding(requesterId: string, id: string, input: unknown): Promise<HttpProxyBindingDto> {
    const dto = parseBindingInput(input, true);
    const saved = await runSerializedTransaction(this.dataSource, async (manager) => {
      const binding = await manager.findOneBy(HttpProxyBindingEntity, { id });
      if (!binding) throw new NotFoundException('Binding not found');
      if (binding.ownerId !== requesterId) {
        throw new ForbiddenException('Only binding owner can edit it');
      }
      if (dto.hostname !== undefined) {
        const hostname = normalizeHttpProxyHostname(dto.hostname);
        const pool = await this.enabledPoolForHostname(manager, hostname);
        if (hostname !== binding.hostname) {
          await this.reserveHostname(manager, hostname, requesterId, binding.id);
          await this.releaseHostname(manager, binding);
          binding.hostname = hostname;
          binding.domainPoolId = pool.id;
        }
      }
      if (dto.containerId !== undefined) {
        const container = await manager.findOneBy(ContainerEntity, { id: dto.containerId });
        if (!container) throw new NotFoundException('Container not found');
        if (container.ownerId !== requesterId) {
          throw new ForbiddenException('Container is not owned by current user');
        }
        binding.containerId = container.id;
      }
      if (dto.targetPort !== undefined) binding.targetPort = dto.targetPort;
      return manager.save(HttpProxyBindingEntity, binding);
    });
    return (await this.bindingDtos([saved], requesterId, false))[0]!;
  }

  async deleteBinding(requesterId: string, id: string): Promise<void> {
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const binding = await manager.findOneBy(HttpProxyBindingEntity, { id });
      if (!binding) throw new NotFoundException('Binding not found');
      if (binding.ownerId !== requesterId) {
        throw new ForbiddenException('Only binding owner can delete it');
      }
      await this.releaseHostname(manager, binding);
      await manager.delete(HttpProxyBindingEntity, { id });
    });
  }

  async listDomainPools(): Promise<HttpDomainPoolDto[]> {
    const rows = await this.domainPoolsRepo.find({ order: { wildcardDomain: 'ASC' } });
    return rows.map((row) => this.domainPoolDto(row));
  }

  async createDomainPool(input: unknown): Promise<HttpDomainPoolDto> {
    const dto = parseDomainPoolInput(input, false);
    const wildcardDomain = normalizeHttpProxyWildcardDomain(dto.wildcardDomain);
    const certificate = this.certFields(
      dto.certificatePem,
      dto.privateKeyPem,
      wildcardDomain,
    );
    if (dto.httpsEnabled && !certificate.certificatePem) {
      throw new BadRequestException('HTTPS requires a valid certificate and private key');
    }
    const row = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (await manager.count(HttpDomainPoolEntity) >= MAX_HTTP_PROXY_DOMAIN_POOLS) {
        throw new ConflictException({
          code: 'HTTP_PROXY_DOMAIN_POOL_CAPACITY_REACHED',
          message: `At most ${MAX_HTTP_PROXY_DOMAIN_POOLS} HTTP domain pools are supported`,
        });
      }
      return manager.save(HttpDomainPoolEntity, manager.create(HttpDomainPoolEntity, {
        id: randomUUID(),
        wildcardDomain,
        enabled: dto.enabled ?? true,
        httpsEnabled: dto.httpsEnabled ?? false,
        ...certificate,
      }));
    });
    return this.domainPoolDto(row);
  }

  async updateDomainPool(id: string, input: unknown): Promise<HttpDomainPoolDto> {
    const dto = parseDomainPoolInput(input, true);
    const row = await runSerializedTransaction(this.dataSource, async (manager) => {
      const current = await manager.findOneBy(HttpDomainPoolEntity, { id });
      if (!current) throw new NotFoundException('Domain pool not found');
      if (dto.wildcardDomain !== undefined) {
        const wildcardDomain = normalizeHttpProxyWildcardDomain(dto.wildcardDomain);
        if (wildcardDomain !== current.wildcardDomain) {
          const bindingCount = await manager.count(HttpProxyBindingEntity, {
            where: { domainPoolId: id },
          });
          if (bindingCount > 0) {
            throw new ConflictException('Domain pool wildcard cannot change while bindings exist');
          }
          current.wildcardDomain = wildcardDomain;
        }
      }
      if (dto.enabled !== undefined) current.enabled = dto.enabled;
      if (dto.httpsEnabled !== undefined) current.httpsEnabled = dto.httpsEnabled;
      if (dto.certificatePem !== undefined || dto.privateKeyPem !== undefined) {
        if (dto.certificatePem === undefined || dto.privateKeyPem === undefined) {
          throw new BadRequestException(
            'certificatePem and privateKeyPem must be updated together',
          );
        }
        Object.assign(
          current,
          this.certFields(dto.certificatePem, dto.privateKeyPem, current.wildcardDomain),
        );
      } else if (current.certificatePem) {
        this.validateCertificate(current.certificatePem, current.wildcardDomain);
      }
      if (current.httpsEnabled && (!current.certificatePem || !current.encryptedPrivateKeyPem)) {
        throw new BadRequestException('HTTPS requires a valid certificate and private key');
      }
      return manager.save(HttpDomainPoolEntity, current);
    });
    return this.domainPoolDto(row);
  }

  async deleteDomainPool(id: string): Promise<void> {
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const row = await manager.findOneBy(HttpDomainPoolEntity, { id });
      if (!row) throw new NotFoundException('Domain pool not found');
      const count = await manager.count(HttpProxyBindingEntity, { where: { domainPoolId: id } });
      if (count > 0) throw new ConflictException('Domain pool still has bindings');
      await manager.delete(HttpDomainPoolEntity, { id });
    });
  }

  buildSnapshot(): Promise<HttpProxySnapshot> {
    const build = this.snapshotBuildTail.then(() => this.buildSnapshotNow());
    this.snapshotBuildTail = build.then(() => undefined, () => undefined);
    return build;
  }

  private async buildSnapshotNow(): Promise<HttpProxySnapshot> {
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const routes = await manager.find(ContainerSshRouteEntity);
      const routeIps = [...new Set(routes
        .map((route) => route.macvlanIp)
        .filter((ip): ip is string => Boolean(ip)))];
      const [
        bindings, pools, containers, lifecycles, desiredSpecs, users, servers,
        addressClaims, containerMounts, remoteAssignments,
      ] = await Promise.all([
        manager.find(HttpProxyBindingEntity),
        manager.find(HttpDomainPoolEntity),
        manager.find(ContainerEntity),
        manager.find(ContainerLifecycleEntity),
        manager.find(ContainerDesiredSpecEntity),
        manager.find(UserEntity, { where: { status: UserStatus.Active } }),
        manager.find(ServerEntity),
        routeIps.length === 0
          ? Promise.resolve([])
          : manager.find(NetworkAddressClaimEntity, {
            where: { state: 'active', address: In(routeIps) },
          }),
        manager.find(ContainerMountEntity, { where: { sourceKind: 'remote' } }),
        manager.find(RemoteFsServerAssignmentEntity),
      ]);
      const poolsById = new Map(pools.map((row) => [row.id, row]));
      const containersById = new Map(containers.map((row) => [row.id, row]));
      const lifecycleByContainerId = new Map(lifecycles.map((row) => [row.containerId, row]));
      const desiredByContainerId = new Map(desiredSpecs.map((row) => [row.containerId, row]));
      const claimsByAddress = new Map<string, NetworkAddressClaimEntity[]>();
      for (const claim of addressClaims) {
        const claims = claimsByAddress.get(claim.address) ?? [];
        claims.push(claim);
        claimsByAddress.set(claim.address, claims);
      }
      const activeRemoteAssignments = new Set(remoteAssignments
        .filter((assignment) => assignment.desiredState === 'active')
        .map((assignment) => `${assignment.serverId}|${assignment.remoteFsMountId}`));
      const unsafeRemoteConsumerIds = new Set(containerMounts
        .filter((mount) => !activeRemoteAssignments.has(`${mount.serverId}|${mount.sourceId}`))
        .map((mount) => mount.containerId));
      const onlineServerIds = new Set(servers
        .filter((server) =>
          server.status === ServerStatus.Online
          && !this.proxySnapshots.isServerBlocked(server.id)
          && Boolean(server.macvlanCidr))
        .map((server) => server.id));
      const activeUserIds = new Set(users.map((user) => user.id));
      const routesByContainerId = new Map(routes
        .filter((route) => this.routeMatchesLifecycle(
          route,
          lifecycleByContainerId.get(route.containerId),
          desiredByContainerId.get(route.containerId),
        ))
        .map((row) => [row.containerId, row]));
      const createdAtMs = Date.now();
      const routable = bindings.flatMap((binding) => {
        const pool = poolsById.get(binding.domainPoolId);
        const container = containersById.get(binding.containerId);
        const route = routesByContainerId.get(binding.containerId);
        if (
          !pool?.enabled
          || !container
          || !route
          || unsafeRemoteConsumerIds.has(container.id)
          || !activeUserIds.has(binding.ownerId)
          || !onlineServerIds.has(container.serverId)
        ) return [];
        if (container.ownerId !== binding.ownerId) return [];
        if (route.serverId !== container.serverId) return [];
        if (!hostnameMatchesHttpProxyWildcard(binding.hostname, pool.wildcardDomain)) return [];
        if (pool.httpsEnabled && (!pool.certificatePem || !pool.encryptedPrivateKeyPem)) return [];
        if (!route.macvlanIp || route.runtimeStatus !== ContainerStatus.Running) return [];
        const claimsForAddress = claimsByAddress.get(route.macvlanIp) ?? [];
        const exactClaim = claimsForAddress.find((claim) =>
          claim.ownerKind === 'container'
          && claim.ownerId === container.id
          && claim.serverId === container.serverId);
        if (claimsForAddress.length !== 1 || !exactClaim) return [];
        const routeAge = createdAtMs - route.observedAt.getTime();
        if (routeAge < 0 || routeAge > ROUTE_STALE_MS) return [];
        return [{
          bindingId: binding.id,
          hostname: binding.hostname,
          domainPoolId: pool.id,
          targetIp: route.macvlanIp,
          targetPort: binding.targetPort,
          ownerId: binding.ownerId,
          containerId: container.id,
          containerName: container.name,
          runtimeId: route.runtimeId,
          runtimeStatus: route.runtimeStatus,
        }];
      });
      const nextGeneration = this.generation + 1;
      const snapshot = zHttpProxySnapshot.parse({
        generation: nextGeneration,
        createdAt: new Date(createdAtMs).toISOString(),
        staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        validUntil: createdAtMs + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
        routes: routable,
        domainPools: pools
          .filter((pool) => pool.enabled
            && pool.httpsEnabled
            && this.poolHasSafeTlsLease(pool, createdAtMs))
          .map((pool) => ({
            id: pool.id,
            wildcardDomain: pool.wildcardDomain,
            enabled: pool.enabled,
            httpsEnabled: pool.httpsEnabled,
            certificatePem: pool.certificatePem,
            privateKeyPem: this.decrypt(pool.encryptedPrivateKeyPem!),
            certificateFingerprint: pool.certificateFingerprint,
            certificateNotAfter: pool.certificateNotAfter?.toISOString() ?? null,
          })),
      });
      const encodedBytes = Buffer.byteLength(JSON.stringify({
        ts: Number.MAX_SAFE_INTEGER,
        kind: 'snapshot',
        payload: snapshot,
      }));
      if (encodedBytes > MAX_HTTP_PROXY_SNAPSHOT_BYTES) {
        throw new Error(
          `HTTP proxy snapshot is ${encodedBytes} bytes; maximum is ${MAX_HTTP_PROXY_SNAPSHOT_BYTES}`,
        );
      }
      this.generation = nextGeneration;
      return snapshot;
    });
  }

  private async enabledPoolForHostname(
    manager: EntityManager,
    hostname: string,
  ): Promise<HttpDomainPoolEntity> {
    const pools = await manager.find(HttpDomainPoolEntity, { where: { enabled: true } });
    const pool = pools.find((row) => hostnameMatchesHttpProxyWildcard(hostname, row.wildcardDomain));
    if (!pool) throw new BadRequestException('Hostname is not under an enabled wildcard domain pool');
    return pool;
  }

  private async reserveHostname(
    manager: EntityManager,
    hostname: string,
    ownerId: string,
    bindingId: string,
  ): Promise<void> {
    const now = new Date();
    const expired = await manager.find(HttpHostnameReservationEntity, {
      where: { state: 'releasing', reusableAt: LessThanOrEqual(now) },
      order: { reusableAt: 'ASC', hostname: 'ASC' },
      take: HOSTNAME_RESERVATION_GC_BATCH,
    });
    const reusableHostnames = expired
      .filter((reservation) => monotonicReuseGuard.mayReuse(
        hostnameReuseKey(reservation.hostname),
        reservation.reusableAt,
        now.getTime(),
      ))
      .map((reservation) => reservation.hostname);
    if (reusableHostnames.length > 0) {
      await manager.delete(HttpHostnameReservationEntity, {
        hostname: In(reusableHostnames),
      });
    }
    const draining = await manager.findOneBy(HttpHostnameReservationEntity, {
      hostname,
      state: 'releasing',
    });
    if (
      draining
      && monotonicReuseGuard.mayReuse(
        hostnameReuseKey(hostname),
        draining.reusableAt,
      )
    ) {
      await manager.delete(HttpHostnameReservationEntity, { hostname });
    }
    const [existingBinding, reservation] = await Promise.all([
      manager.findOneBy(HttpProxyBindingEntity, { hostname }),
      manager.findOneBy(HttpHostnameReservationEntity, { hostname }),
    ]);
    if (existingBinding || reservation) throw new ConflictException('Hostname is already occupied or draining');
    if (await manager.count(HttpHostnameReservationEntity) >= MAX_HTTP_HOSTNAME_RESERVATIONS) {
      throw new ConflictException({
        code: 'HTTP_HOSTNAME_RESERVATION_CAPACITY_REACHED',
        message: `At most ${MAX_HTTP_HOSTNAME_RESERVATIONS} active or draining hostnames are supported`,
      });
    }
    await manager.save(HttpHostnameReservationEntity, manager.create(HttpHostnameReservationEntity, {
      hostname,
      ownerId,
      bindingId,
      state: 'active',
      reusableAt: null,
    }));
  }

  private async releaseHostname(
    manager: EntityManager,
    binding: HttpProxyBindingEntity,
  ): Promise<void> {
    const reservation = await manager.findOneBy(HttpHostnameReservationEntity, {
      hostname: binding.hostname,
    });
    if (
      !reservation
      || reservation.state !== 'active'
      || reservation.ownerId !== binding.ownerId
      || reservation.bindingId !== binding.id
    ) {
      throw new ConflictException('Hostname reservation identity is missing or inconsistent');
    }
    await manager.update(HttpHostnameReservationEntity, binding.hostname, {
      state: 'releasing',
      bindingId: null,
      reusableAt: new Date(Date.now() + CONTAINER_DELETE_PROXY_DRAIN_MS),
    });
    monotonicReuseGuard.arm(hostnameReuseKey(binding.hostname));
  }

  private async bindingDtos(
    bindings: HttpProxyBindingEntity[],
    requesterId: string,
    proxyOnline: boolean,
  ): Promise<HttpProxyBindingDto[]> {
    const [pools, containers, lifecycles, desiredSpecs, routes, users] = await Promise.all([
      this.domainPoolsRepo.find({ where: { id: In([...new Set(bindings.map((row) => row.domainPoolId))]) } }),
      this.containersRepo.find({ where: { id: In([...new Set(bindings.map((row) => row.containerId))]) } }),
      this.lifecyclesRepo.find({ where: { containerId: In([...new Set(bindings.map((row) => row.containerId))]) } }),
      this.desiredSpecsRepo.find({ where: { containerId: In([...new Set(bindings.map((row) => row.containerId))]) } }),
      this.routesRepo.find({ where: { containerId: In([...new Set(bindings.map((row) => row.containerId))]) } }),
      this.usersRepo.find({ where: { id: In([...new Set(bindings.map((row) => row.ownerId))]) } }),
    ]);
    const poolsById = new Map(pools.map((row) => [row.id, row]));
    const containersById = new Map(containers.map((row) => [row.id, row]));
    const lifecycleByContainerId = new Map(lifecycles.map((row) => [row.containerId, row]));
    const desiredByContainerId = new Map(desiredSpecs.map((row) => [row.containerId, row]));
    const routesByContainerId = new Map(routes
      .filter((route) => this.routeMatchesLifecycle(
        route,
        lifecycleByContainerId.get(route.containerId),
        desiredByContainerId.get(route.containerId),
      ))
      .map((row) => [row.containerId, row]));
    const usersById = new Map(users.map((row) => [row.id, row]));
    return bindings
      .filter((binding) => usersById.get(binding.ownerId)?.status === UserStatus.Active)
      .map((binding) => {
        const pool = poolsById.get(binding.domainPoolId);
        const container = containersById.get(binding.containerId);
        const route = routesByContainerId.get(binding.containerId);
        const reasons = this.warningReasons(pool, container, route, proxyOnline);
        const status: HttpProxyBindingStatus = pool?.enabled === false ? 'disabled' : reasons.length > 0 ? 'warning' : 'ready';
        return {
          id: binding.id,
          mine: binding.ownerId === requesterId,
          ownerId: binding.ownerId,
          ownerUsername: usersById.get(binding.ownerId)?.username ?? binding.ownerId,
          hostname: binding.hostname,
          domainPoolId: binding.domainPoolId,
          domainPool: pool?.wildcardDomain ?? binding.domainPoolId,
          targetUrl: route?.macvlanIp ? `http://${route.macvlanIp}:${binding.targetPort}` : null,
          containerId: binding.containerId,
          containerName: container?.name ?? null,
          containerStatus: route?.runtimeStatus ?? (container ? null : 'missing'),
          targetPort: binding.targetPort,
          entryHttpsEnabled: Boolean(pool?.httpsEnabled),
          status,
          warningReasons: reasons,
          warningMessage: httpProxyWarningMessage(reasons),
          createdAt: binding.createdAt.toISOString(),
          updatedAt: binding.updatedAt.toISOString(),
        };
      });
  }

  private warningReasons(
    pool: HttpDomainPoolEntity | undefined,
    container: ContainerEntity | undefined,
    route: ContainerSshRouteEntity | undefined,
    proxyOnline: boolean,
  ): HttpProxyWarningReason[] {
    const reasons: HttpProxyWarningReason[] = [];
    if (!proxyOnline) reasons.push('proxy_offline');
    if (!pool?.enabled) reasons.push('domain_pool_disabled');
    if (pool?.httpsEnabled && !this.poolHasSafeTlsLease(pool, Date.now())) {
      reasons.push('https_not_configured');
    }
    if (!container) reasons.push('container_deleted');
    if (!route || (container && route.serverId !== container.serverId)) reasons.push('route_missing', 'container_runtime_missing');
    else {
      if (route.runtimeStatus !== ContainerStatus.Running) reasons.push('container_not_running');
      if (!route.runtimeId) reasons.push('container_runtime_missing');
      if (!route.macvlanIp) reasons.push('container_ip_missing');
      if (Date.now() - route.observedAt.getTime() > ROUTE_STALE_MS) reasons.push('container_runtime_stale');
    }
    return [...new Set(reasons)];
  }

  private routeMatchesLifecycle(
    route: ContainerSshRouteEntity,
    lifecycle: ContainerLifecycleEntity | undefined,
    desired: ContainerDesiredSpecEntity | undefined,
  ): boolean {
    return lifecycle?.phase === ContainerPhase.Active
      && lifecycle.activeTaskId === null
      && lifecycle.boundRuntimeId === route.runtimeId
      && desired?.powerIntent === ContainerPowerIntent.Running;
  }

  private poolHasSafeTlsLease(pool: HttpDomainPoolEntity, now: number): boolean {
    return Boolean(
      pool.certificatePem
      && pool.encryptedPrivateKeyPem
      && pool.certificateNotAfter
      && pool.certificateNotAfter.getTime() > now
        + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS
        + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
    );
  }

  private domainPoolDto(row: HttpDomainPoolEntity): HttpDomainPoolDto {
    return {
      id: row.id,
      wildcardDomain: row.wildcardDomain,
      enabled: row.enabled,
      httpsEnabled: row.httpsEnabled,
      certificateFingerprint: row.certificateFingerprint,
      certificateNotAfter: row.certificateNotAfter?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private certFields(
    certificatePem: string | null | undefined,
    privateKeyPem: string | null | undefined,
    wildcardDomain: string,
  ): Partial<HttpDomainPoolEntity> {
    if (!certificatePem && !privateKeyPem) {
      return {
        certificatePem: null,
        encryptedPrivateKeyPem: null,
        certificateFingerprint: null,
        certificateNotAfter: null,
      };
    }
    if (!certificatePem || !privateKeyPem) {
      throw new BadRequestException('Both certificatePem and privateKeyPem are required when configuring HTTPS');
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
      certificatePem,
      encryptedPrivateKeyPem: this.encrypt(privateKeyPem),
      certificateFingerprint: cert.fingerprint256,
      certificateNotAfter: new Date(cert.validTo),
    };
  }

  private validateCertificate(certificatePem: string, wildcardDomain: string): X509Certificate {
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
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [KEY_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  private decrypt(value: string): string {
    const [version, ivRaw, tagRaw, ciphertextRaw] = value.split('.');
    if (version !== KEY_VERSION || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error('Unsupported encrypted HTTP proxy key format');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, 'base64url')), decipher.final()]).toString('utf8');
  }

  private key(): Buffer {
    const secret = this.config.get<string>('ssh.keyEncryptionSecret') || this.config.get<string>('auth.jwtSecret');
    return createHash('sha256').update(secret).digest();
  }
}

function parseBindingInput(input: unknown, partial: boolean) {
  const record = objectInput(input);
  const parsed: {
    hostname?: string;
    containerId?: string;
    targetPort?: number;
  } = {};
  if (!partial || record.hostname !== undefined) parsed.hostname = stringField(record.hostname, 'hostname');
  if (!partial || record.containerId !== undefined) parsed.containerId = stringField(record.containerId, 'containerId');
  if (!partial || record.targetPort !== undefined) parsed.targetPort = portField(record.targetPort);
  return parsed as typeof parsed & { hostname: string; containerId: string; targetPort: number };
}

function parseDomainPoolInput(input: unknown, partial: boolean) {
  const record = objectInput(input);
  const parsed: {
    wildcardDomain?: string;
    enabled?: boolean;
    httpsEnabled?: boolean;
    certificatePem?: string | null;
    privateKeyPem?: string | null;
  } = {};
  if (!partial || record.wildcardDomain !== undefined) parsed.wildcardDomain = stringField(record.wildcardDomain, 'wildcardDomain');
  if (record.enabled !== undefined) parsed.enabled = booleanField(record.enabled, 'enabled');
  if (record.httpsEnabled !== undefined) parsed.httpsEnabled = booleanField(record.httpsEnabled, 'httpsEnabled');
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
  return parsed as typeof parsed & { wildcardDomain: string };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Request body must be an object');
  return input as Record<string, unknown>;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

function nullableStringField(value: unknown, name: string): string | null {
  if (value === null || value === '') return null;
  return stringField(value, name);
}

function nullableBoundedStringField(value: unknown, name: string, maxLength: number): string | null {
  const parsed = nullableStringField(value, name);
  if (parsed !== null && parsed.length > maxLength) {
    throw new BadRequestException(`${name} must not exceed ${maxLength} characters`);
  }
  return parsed;
}

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new BadRequestException(`${name} must be boolean`);
  return value;
}

function portField(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new BadRequestException('targetPort must be an integer between 1 and 65535');
  }
  return value;
}
