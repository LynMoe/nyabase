import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, X509Certificate } from 'crypto';
import { In, Repository } from 'typeorm';
import {
  ContainerStatus,
  httpProxyWarningMessage,
  hostnameMatchesHttpProxyWildcard,
  normalizeHttpProxyHostname,
  normalizeHttpProxyWildcardDomain,
  type HttpProxyBindingStatus,
  type HttpProxySnapshot,
  type HttpProxyTargetProtocol,
  type HttpProxyWarningReason,
} from '@nyabase/common';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { HttpDomainPoolEntity } from '../entities/http-domain-pool.entity.js';
import { HttpProxyBindingEntity } from '../entities/http-proxy-binding.entity.js';
import { UserEntity } from '../entities/user.entity.js';

const KEY_VERSION = 'v1';
const ROUTE_STALE_MS = 120_000;

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
  containerStatus: ContainerStatus | 'deleted' | 'missing' | null;
  targetPort: number;
  targetProtocol: HttpProxyTargetProtocol;
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

  constructor(
    @InjectRepository(HttpDomainPoolEntity)
    private domainPoolsRepo: Repository<HttpDomainPoolEntity>,
    @InjectRepository(HttpProxyBindingEntity)
    private bindingsRepo: Repository<HttpProxyBindingEntity>,
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
    @InjectRepository(ContainerSshRouteEntity)
    private routesRepo: Repository<ContainerSshRouteEntity>,
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    private config: NyabaseConfigService,
  ) {}

  async listBindings(requesterId: string, proxyOnline: boolean): Promise<HttpProxyBindingDto[]> {
    const bindings = await this.bindingsRepo.find({ order: { hostname: 'ASC' } });
    return this.bindingDtos(bindings, requesterId, proxyOnline);
  }

  async createBinding(requesterId: string, input: unknown): Promise<HttpProxyBindingDto> {
    const dto = parseBindingInput(input, false);
    const hostname = normalizeHttpProxyHostname(dto.hostname);
    const pool = await this.enabledPoolForHostname(hostname);
    const container = await this.containersRepo.findOneBy({ id: dto.containerId });
    if (!container || container.deletedAt) throw new NotFoundException('Container not found');
    if (container.ownerId !== requesterId) throw new ForbiddenException('Container is not owned by current user');
    await this.assertHostnameAvailable(hostname);
    const binding = await this.bindingsRepo.save(this.bindingsRepo.create({
      id: randomUUID(),
      hostname,
      domainPoolId: pool.id,
      ownerId: requesterId,
      containerId: container.id,
      targetPort: dto.targetPort,
      targetProtocol: dto.targetProtocol,
    }));
    return (await this.bindingDtos([binding], requesterId, false))[0]!;
  }

  async updateBinding(requesterId: string, id: string, input: unknown): Promise<HttpProxyBindingDto> {
    const binding = await this.bindingsRepo.findOneBy({ id });
    if (!binding) throw new NotFoundException('Binding not found');
    if (binding.ownerId !== requesterId) throw new ForbiddenException('Only binding owner can edit it');
    const dto = parseBindingInput(input, true);
    if (dto.hostname !== undefined) {
      const hostname = normalizeHttpProxyHostname(dto.hostname);
      const pool = await this.enabledPoolForHostname(hostname);
      await this.assertHostnameAvailable(hostname, binding.id);
      binding.hostname = hostname;
      binding.domainPoolId = pool.id;
    }
    if (dto.containerId !== undefined) {
      const container = await this.containersRepo.findOneBy({ id: dto.containerId });
      if (!container || container.deletedAt) throw new NotFoundException('Container not found');
      if (container.ownerId !== requesterId) throw new ForbiddenException('Container is not owned by current user');
      binding.containerId = container.id;
    }
    if (dto.targetPort !== undefined) binding.targetPort = dto.targetPort;
    if (dto.targetProtocol !== undefined) binding.targetProtocol = dto.targetProtocol;
    const saved = await this.bindingsRepo.save(binding);
    return (await this.bindingDtos([saved], requesterId, false))[0]!;
  }

  async deleteBinding(requesterId: string, id: string): Promise<void> {
    const binding = await this.bindingsRepo.findOneBy({ id });
    if (!binding) throw new NotFoundException('Binding not found');
    if (binding.ownerId !== requesterId) throw new ForbiddenException('Only binding owner can delete it');
    await this.bindingsRepo.delete({ id });
  }

  async listDomainPools(): Promise<HttpDomainPoolDto[]> {
    const rows = await this.domainPoolsRepo.find({ order: { wildcardDomain: 'ASC' } });
    return rows.map((row) => this.domainPoolDto(row));
  }

  async createDomainPool(input: unknown): Promise<HttpDomainPoolDto> {
    const dto = parseDomainPoolInput(input, false);
    const row = await this.domainPoolsRepo.save(this.domainPoolsRepo.create({
      id: randomUUID(),
      wildcardDomain: normalizeHttpProxyWildcardDomain(dto.wildcardDomain),
      enabled: dto.enabled ?? true,
      httpsEnabled: dto.httpsEnabled ?? false,
      ...this.certFields(dto.certificatePem, dto.privateKeyPem),
    }));
    return this.domainPoolDto(row);
  }

  async updateDomainPool(id: string, input: unknown): Promise<HttpDomainPoolDto> {
    const row = await this.domainPoolsRepo.findOneBy({ id });
    if (!row) throw new NotFoundException('Domain pool not found');
    const dto = parseDomainPoolInput(input, true);
    if (dto.wildcardDomain !== undefined) row.wildcardDomain = normalizeHttpProxyWildcardDomain(dto.wildcardDomain);
    if (dto.enabled !== undefined) row.enabled = dto.enabled;
    if (dto.httpsEnabled !== undefined) row.httpsEnabled = dto.httpsEnabled;
    if (dto.certificatePem !== undefined || dto.privateKeyPem !== undefined) {
      Object.assign(row, this.certFields(dto.certificatePem ?? row.certificatePem, dto.privateKeyPem));
    }
    return this.domainPoolDto(await this.domainPoolsRepo.save(row));
  }

  async deleteDomainPool(id: string): Promise<void> {
    const count = await this.bindingsRepo.countBy({ domainPoolId: id });
    if (count > 0) throw new ConflictException('Domain pool still has bindings');
    await this.domainPoolsRepo.delete({ id });
  }

  async buildSnapshot(): Promise<HttpProxySnapshot> {
    this.generation += 1;
    const [bindings, pools, containers, routes] = await Promise.all([
      this.bindingsRepo.find(),
      this.domainPoolsRepo.find(),
      this.containersRepo.find(),
      this.routesRepo.find(),
    ]);
    const poolsById = new Map(pools.map((row) => [row.id, row]));
    const containersById = new Map(containers.map((row) => [row.id, row]));
    const routesByContainerId = new Map(routes.map((row) => [row.containerId, row]));
    const now = Date.now();
    const routable = bindings.flatMap((binding) => {
      const pool = poolsById.get(binding.domainPoolId);
      const container = containersById.get(binding.containerId);
      const route = routesByContainerId.get(binding.containerId);
      if (!pool?.enabled || !container || container.deletedAt || !route) return [];
      if (pool.httpsEnabled && (!pool.certificatePem || !pool.encryptedPrivateKeyPem)) return [];
      if (!route.macvlanIp || route.runtimeStatus !== ContainerStatus.Running) return [];
      if (now - route.observedAt.getTime() > ROUTE_STALE_MS) return [];
      return [{
        bindingId: binding.id,
        hostname: binding.hostname,
        domainPoolId: pool.id,
        targetIp: route.macvlanIp,
        targetPort: binding.targetPort,
        targetProtocol: binding.targetProtocol,
        ownerId: binding.ownerId,
        containerId: container.id,
        containerName: container.name,
        runtimeId: route.runtimeId,
        runtimeStatus: route.runtimeStatus,
      }];
    });
    return {
      generation: this.generation,
      createdAt: new Date().toISOString(),
      routes: routable,
      domainPools: pools.filter((pool) => pool.enabled && pool.httpsEnabled && pool.certificatePem && pool.encryptedPrivateKeyPem)
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
    };
  }

  private async enabledPoolForHostname(hostname: string): Promise<HttpDomainPoolEntity> {
    const pools = await this.domainPoolsRepo.find({ where: { enabled: true } });
    const pool = pools.find((row) => hostnameMatchesHttpProxyWildcard(hostname, row.wildcardDomain));
    if (!pool) throw new BadRequestException('Hostname is not under an enabled wildcard domain pool');
    return pool;
  }

  private async assertHostnameAvailable(hostname: string, exceptId?: string): Promise<void> {
    const existing = await this.bindingsRepo.findOneBy({ hostname });
    if (!existing || existing.id === exceptId) return;
    const owner = await this.usersRepo.findOneBy({ id: existing.ownerId });
    throw new ConflictException({
      message: 'Hostname is already occupied',
      occupiedBy: {
        userId: existing.ownerId,
        username: owner?.username ?? existing.ownerId,
      },
    });
  }

  private async bindingDtos(
    bindings: HttpProxyBindingEntity[],
    requesterId: string,
    proxyOnline: boolean,
  ): Promise<HttpProxyBindingDto[]> {
    const [pools, containers, routes, users] = await Promise.all([
      this.domainPoolsRepo.find({ where: { id: In([...new Set(bindings.map((row) => row.domainPoolId))]) } }),
      this.containersRepo.find({ where: { id: In([...new Set(bindings.map((row) => row.containerId))]) } }),
      this.routesRepo.find({ where: { containerId: In([...new Set(bindings.map((row) => row.containerId))]) } }),
      this.usersRepo.find({ where: { id: In([...new Set(bindings.map((row) => row.ownerId))]) } }),
    ]);
    const poolsById = new Map(pools.map((row) => [row.id, row]));
    const containersById = new Map(containers.map((row) => [row.id, row]));
    const routesByContainerId = new Map(routes.map((row) => [row.containerId, row]));
    const usersById = new Map(users.map((row) => [row.id, row]));
    return bindings.map((binding) => {
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
        targetUrl: route?.macvlanIp ? `${binding.targetProtocol}://${route.macvlanIp}:${binding.targetPort}` : null,
        containerId: binding.containerId,
        containerName: container?.name ?? null,
        containerStatus: container?.deletedAt ? 'deleted' : route?.runtimeStatus ?? (container ? null : 'missing'),
        targetPort: binding.targetPort,
        targetProtocol: binding.targetProtocol,
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
    if (pool?.httpsEnabled && (!pool.certificatePem || !pool.encryptedPrivateKeyPem)) reasons.push('https_not_configured');
    if (!container) reasons.push('container_deleted');
    else if (container.deletedAt) reasons.push('container_deleted');
    if (!route) reasons.push('route_missing', 'container_runtime_missing');
    else {
      if (route.runtimeStatus !== ContainerStatus.Running) reasons.push('container_not_running');
      if (!route.runtimeId) reasons.push('container_runtime_missing');
      if (!route.macvlanIp) reasons.push('container_ip_missing');
      if (Date.now() - route.observedAt.getTime() > ROUTE_STALE_MS) reasons.push('container_runtime_stale');
    }
    return [...new Set(reasons)];
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

  private certFields(certificatePem?: string | null, privateKeyPem?: string | null): Partial<HttpDomainPoolEntity> {
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
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(certificatePem);
    } catch {
      throw new BadRequestException('Invalid certificate PEM');
    }
    return {
      certificatePem,
      encryptedPrivateKeyPem: this.encrypt(privateKeyPem),
      certificateFingerprint: cert.fingerprint256,
      certificateNotAfter: new Date(cert.validTo),
    };
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
    targetProtocol?: HttpProxyTargetProtocol;
  } = {};
  if (!partial || record.hostname !== undefined) parsed.hostname = stringField(record.hostname, 'hostname');
  if (!partial || record.containerId !== undefined) parsed.containerId = stringField(record.containerId, 'containerId');
  if (!partial || record.targetPort !== undefined) parsed.targetPort = portField(record.targetPort);
  if (!partial || record.targetProtocol !== undefined) parsed.targetProtocol = protocolField(record.targetProtocol);
  return parsed as typeof parsed & { hostname: string; containerId: string; targetPort: number; targetProtocol: HttpProxyTargetProtocol };
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
  if (record.certificatePem !== undefined) parsed.certificatePem = nullableStringField(record.certificatePem, 'certificatePem');
  if (record.privateKeyPem !== undefined) parsed.privateKeyPem = nullableStringField(record.privateKeyPem, 'privateKeyPem');
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

function protocolField(value: unknown): HttpProxyTargetProtocol {
  if (value !== 'http' && value !== 'https') throw new BadRequestException('targetProtocol must be http or https');
  return value;
}
