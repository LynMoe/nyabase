import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes, createHash } from 'crypto';
import { ServerEntity } from '../entities/server.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import {
  ServerStatus,
  AgentTaskStatus,
  DataDiskDto,
  SelfCheckResult,
  type DockerDaemonStatus,
  type DiskInfo,
  type ServerDto,
  type UserServerDto,
  type UserDataDiskDto,
  MAX_PLATFORM_SERVERS,
  AuditAction,
  Capability,
  zSelfCheckResult,
} from '@nyabase/common';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { rpcWithErrorMapping } from '../gateway/agent-errors.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { SshProxyGateway } from '../ssh/ssh-proxy-gateway.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { postCommitBestEffort } from '../common/post-commit.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { gcExpiredNetworkClaims } from '../common/network-claim-ledger.js';
import { AuditService } from '../audit/audit.service.js';
import { publicDataDiskDisplayName } from '../mount-sources/utils.js';
import { safeEpochToIso } from '../common/safe-date.js';

const SERVER_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

interface ServerDtoOptions {
  includeHostFingerprint?: boolean;
}

@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);

  constructor(
    @InjectRepository(ServerEntity)
    private serversRepo: Repository<ServerEntity>,
    private agentGateway: AgentGateway,
    private accessResolver: AccessResolverService,
    private sshProxyGateway: SshProxyGateway,
    private dataSource: DataSource,
    private proxySnapshots: ProxySnapshotNotifierService,
    private auditService: AuditService,
  ) {}

  async create(actorId: string, dto: {
    name: string;
    slug: string;
  }) {
    this.assertValidSlug(dto.slug);
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const server = await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager, actorId, [Capability.ManageServers],
      );
      if (await manager.count(ServerEntity) >= MAX_PLATFORM_SERVERS) {
        throw new ConflictException({
          code: 'SERVER_CAPACITY_REACHED',
          message: `At most ${MAX_PLATFORM_SERVERS} servers are supported`,
        });
      }
      if (await manager.findOneBy(ServerEntity, { slug: dto.slug })) {
        throw new ConflictException('Server slug already exists');
      }
      if (await manager.existsBy(ImageEntity, { deleting: true })) {
        throw new ConflictException('A server cannot be created while image cleanup is in progress');
      }
      return manager.save(ServerEntity, manager.create(ServerEntity, {
        id: uuidv4(),
        name: dto.name,
        slug: dto.slug,
        agentTokenHash: tokenHash,
        hostFingerprint: null,
        agentConfigFingerprint: null,
        status: ServerStatus.Unknown,
        lastSeenAt: null,
        macvlanCidr: null,
        macvlanGateway: null,
        macvlanReservedIps: [],
      }));
    });
    await postCommitBestEffort(
      'Server create audit',
      () => this.auditService.log(actorId, AuditAction.CreateServer, server.id, 'server', {
        serverId: server.id,
        name: server.name,
        slug: server.slug,
      }),
      this.logger,
    );
    await postCommitBestEffort(
      'Server create SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    return {
      server: await this.toDto(server, { includeHostFingerprint: true }),
      agentToken: rawToken,
    };
  }

  async findAll(): Promise<ServerEntity[]> {
    return this.serversRepo.find();
  }

  async findAllDtos(options: ServerDtoOptions = {}): Promise<ServerDto[]> {
    const servers = await this.serversRepo.find();
    return Promise.all(servers.map((server) => this.toDto(server, options)));
  }

  async findByIds(ids: string[]): Promise<ServerEntity[]> {
    if (ids.length === 0) return [];
    return this.serversRepo.findBy(ids.map((id) => ({ id })));
  }

  async findDtosByIds(ids: string[]): Promise<ServerDto[]> {
    const servers = await this.findByIds(ids);
    return Promise.all(servers.map((server) => this.toDto(server)));
  }

  async findUserDtosByIds(ids: string[]): Promise<UserServerDto[]> {
    const servers = await this.findByIds(ids);
    return servers.map((server) => this.toUserDto(server));
  }

  async findById(id: string): Promise<ServerEntity> {
    const server = await this.serversRepo.findOne({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }

  async findDtoById(id: string, options: ServerDtoOptions = {}): Promise<ServerDto> {
    return this.toDto(await this.findById(id), options);
  }

  async findUserDtoById(id: string): Promise<UserServerDto> {
    return this.toUserDto(await this.findById(id));
  }

  async findByTokenHash(hash: string): Promise<ServerEntity | null> {
    return this.serversRepo.findOne({ where: { agentTokenHash: hash } });
  }

  async update(
    actorId: string,
    id: string,
    dto: {
      name?: string;
      slug?: string;
    },
  ) {
    if (dto.slug !== undefined) this.assertValidSlug(dto.slug);
    const { saved, previous } = await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager, actorId, [Capability.ManageServers],
      );
      const server = await manager.findOneBy(ServerEntity, { id });
      if (!server) throw new NotFoundException('Server not found');
      if (dto.slug !== undefined && dto.slug !== server.slug) {
        const existingSlug = await manager.findOneBy(ServerEntity, { slug: dto.slug });
        if (existingSlug && existingSlug.id !== id) {
          throw new ConflictException('Server slug already exists');
        }
      }
      const allowed: Partial<Pick<ServerEntity, 'name' | 'slug'>> = {};
      if (dto.name !== undefined) allowed.name = dto.name;
      if (dto.slug !== undefined) allowed.slug = dto.slug;
      if (Object.keys(allowed).length > 0) await manager.update(ServerEntity, id, allowed);
      return {
        saved: await manager.findOneByOrFail(ServerEntity, { id }),
        previous: { name: server.name, slug: server.slug },
      };
    });
    await postCommitBestEffort(
      'Server update audit',
      () => this.auditService.log(actorId, AuditAction.UpdateServer, saved.id, 'server', {
        serverId: saved.id,
        previous,
        current: { name: saved.name, slug: saved.slug },
      }),
      this.logger,
    );
    await postCommitBestEffort(
      'Server update SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    return this.toDto(saved, { includeHostFingerprint: true });
  }

  async delete(actorId: string, id: string) {
    const deleted = await this.agentGateway.runWithSessionFence(
      id,
      'Server deletion started',
      () => runSerializedTransaction(this.dataSource, async (manager) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          manager, actorId, [Capability.ManageServers],
        );
        const server = await manager.findOneBy(ServerEntity, { id });
        if (!server) throw new NotFoundException('Server not found');
        await gcExpiredNetworkClaims(manager);
        const dependencies: string[] = [];
        const check = async (label: string, entity: Parameters<typeof manager.count>[0], where: object) => {
          if (await manager.count(entity, { where })) dependencies.push(label);
        };
        await check('pending agent tasks', AgentTaskEntity, {
          serverId: id,
          status: AgentTaskStatus.Pending,
        });
        await check('resource locks', ResourceLockEntity, { serverId: id });
        await check('remote FS assignments', RemoteFsServerAssignmentEntity, { serverId: id });
        await check('containers', ContainerEntity, { serverId: id });
        await check('container mounts', ContainerMountEntity, { serverId: id });
        await check('local data directories', DataDirectoryEntity, { serverId: id });
        await check('GPU allocations', GpuAllocationEntity, { serverId: id });
        await check('SSH routes', ContainerSshRouteEntity, { serverId: id });
        await check('server grants', ServerGrantEntity, { serverId: id });
        await check('image grants', ImageGrantEntity, { serverId: id });
        await check('local mount source grants', MountSourceGrantEntity, { serverId: id });
        await check('active or draining network address claims', NetworkAddressClaimEntity, { serverId: id });
        if (dependencies.length > 0) {
          throw new ConflictException({
            code: 'SERVER_NOT_EMPTY',
            message: 'Server still owns durable control-plane state',
            dependencies,
          });
        }
        // QuotaDesired is a disposable control-plane projection once the
        // server owns no task, lock, grant, container or data path. Physical
        // project records contain no reachable data at this point and must not
        // make an otherwise empty Server undeletable forever.
        await manager.delete(QuotaDesiredEntity, { serverId: id });
        // A fresh full-empty report proves that no managed runtime remains on
        // this host. Static reservation claims are configuration, not a second
        // decommission state machine: drop the deleted host's rows, and retain
        // the shared gateway only while another Server uses the same CIDR.
        if (server.hostFingerprint) {
          await manager.delete(NetworkAddressClaimEntity, {
            ownerKind: 'host',
            ownerId: server.hostFingerprint,
          });
        }
        if (server.macvlanCidr) {
          const peers = await manager.count(ServerEntity, {
            where: { macvlanCidr: server.macvlanCidr, id: Not(id) },
          });
          if (peers === 0) {
            await manager.delete(NetworkAddressClaimEntity, {
              ownerKind: 'gateway',
              ownerId: server.macvlanCidr,
            });
          }
        }
        await manager.delete(ServerEntity, id);
        return { serverId: server.id, name: server.name, slug: server.slug };
      }),
      {
        requireBoundServerEmptyInventory: true,
        authorizeAndClaim: (claim) => this.accessResolver.runWithActorCapabilities(
          actorId,
          [Capability.ManageServers],
          async () => { claim(); },
        ),
      },
    );
    await postCommitBestEffort(
      'Server delete audit',
      () => this.auditService.log(actorId, AuditAction.DeleteServer, deleted.serverId, 'server', deleted),
      this.logger,
    );
    this.proxySnapshots.forgetServer(id, 'server deleted');
    await postCommitBestEffort(
      'Server delete SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
  }

  async regenerateToken(actorId: string, id: string) {
    const rawToken = randomBytes(32).toString('hex');
    const agentTokenHash = createHash('sha256').update(rawToken).digest('hex');
    await this.agentGateway.runWithSessionFence(
      id,
      'Agent token rotation started',
      () => runSerializedTransaction(this.dataSource, async (manager) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          manager, actorId, [Capability.ManageServers],
        );
        const server = await manager.findOneBy(ServerEntity, { id });
        if (!server) throw new NotFoundException('Server not found');
        await manager.update(ServerEntity, id, { agentTokenHash });
      }),
      {
        authorizeAndClaim: (claim) => this.accessResolver.runWithActorCapabilities(
          actorId,
          [Capability.ManageServers],
          async () => { claim(); },
        ),
      },
    );
    await postCommitBestEffort(
      'Server Agent token rotation audit',
      () => this.auditService.log(
        actorId,
        AuditAction.RotateServerAgentToken,
        id,
        'server',
      ),
      this.logger,
    );
    return rawToken;
  }

  // ---------------------------------------------------------------------------
  // Local data sources are owned by agent.yaml and observed through state reports.
  // ---------------------------------------------------------------------------

  async listDiskDtos(serverId: string): Promise<DataDiskDto[]> {
    await this.findById(serverId);
    return (this.agentGateway.stateCache.get(serverId)?.disks ?? []).map((disk) => this.toDiskDto(disk));
  }

  async listUserDiskDtos(serverId: string): Promise<UserDataDiskDto[]> {
    await this.findById(serverId);
    return (this.agentGateway.stateCache.get(serverId)?.disks ?? []).map((disk) => ({
      diskId: disk.diskId,
      displayName: publicDataDiskDisplayName(disk.diskId, disk.label),
      totalBytes: disk.totalBytes,
      usedBytes: disk.usedBytes,
      pquotaEnabled: disk.pquotaEnabled,
    }));
  }

  async listAllDisks(): Promise<Array<{
    diskId: string;
    serverId: string;
    mountPoint: string;
    sourceIdentity: string;
    label: string | null;
  }>> {
    return this.agentGateway.stateCache.getAll()
      .flatMap((snap) => snap.disks.map((disk) => ({
        diskId: disk.diskId,
        serverId: snap.serverId,
        mountPoint: disk.mountPoint,
        sourceIdentity: disk.sourceIdentity,
        label: disk.label ?? null,
      })))
      .sort((a, b) => a.serverId.localeCompare(b.serverId) || a.mountPoint.localeCompare(b.mountPoint));
  }

  async selfCheck(actorId: string, serverId: string): Promise<SelfCheckResult> {
    await this.findById(serverId);
    if (!this.agentGateway.isOnline(serverId)) {
      throw new BadRequestException('Agent is offline, cannot run self-check');
    }
    this.assertRuntimeReady(serverId);
    const started = await this.accessResolver.startExternalWithActorCapabilities(
      actorId,
      [Capability.ManageServers],
      () => rpcWithErrorMapping(() =>
        this.agentGateway.rpc<SelfCheckResult>(serverId, 'selfCheck', {}),
      ),
    );
    return zSelfCheckResult.parse(await started.completion);
  }

  async persistDockerDaemonStatus(serverId: string, status: DockerDaemonStatus): Promise<DockerDaemonStatus> {
    if (status.serverId !== serverId) {
      throw new BadRequestException('Docker daemon status serverId mismatch');
    }
    this.agentGateway.stateCache.updateDockerDaemonStatus(serverId, status);
    return status;
  }

  async getUserQuota(serverId: string, userId: string): Promise<{ usedBytes: number; limitBytes: number }> {
    await this.findById(serverId);
    const grant = await this.accessResolver.resolveServer(userId, serverId);
    const latest = this.agentGateway.stateCache.get(serverId)?.xfsProjects.find((row) => row.userId === userId) ?? null;
    return {
      usedBytes: latest?.usedBytes ?? 0,
      limitBytes: grant?.diskBytes ?? 0,
    };
  }

  private toDiskDto(disk: DiskInfo): DataDiskDto {
    return {
      diskId: disk.diskId,
      mountPoint: disk.mountPoint,
      sourceIdentity: disk.sourceIdentity,
      label: disk.label,
      totalBytes: disk.totalBytes,
      usedBytes: disk.usedBytes,
      pquotaEnabled: disk.pquotaEnabled,
    };
  }

  private async toDto(server: ServerEntity, options: ServerDtoOptions = {}): Promise<ServerDto> {
    const snap = this.agentGateway.stateCache.get(server.id);
    const disks = await this.listDiskDtos(server.id);
    return {
      id: server.id,
      name: server.name,
      slug: server.slug,
      ...(options.includeHostFingerprint
        ? { hostFingerprint: server.hostFingerprint }
        : {}),
      status: server.status,
      quarantineCode: server.quarantineCode,
      quarantineMessage: server.quarantineMessage,
      lastSeenAt: server.lastSeenAt?.toISOString() ?? null,
      runtimeReady: snap?.runtimeReady === true,
      runtimeObservedAt: safeEpochToIso(snap?.lastUpdated),
      disks,
      gpus: snap?.gpus ?? [],
      agentVersion: snap?.agentVersion,
      dockerDaemon: snap?.dockerDaemon ?? null,
    };
  }

  private toUserDto(server: ServerEntity): UserServerDto {
    const snapshot = this.agentGateway.stateCache.get(server.id);
    return {
      id: server.id,
      name: server.name,
      slug: server.slug,
      status: server.status,
      lastSeenAt: server.lastSeenAt?.toISOString() ?? null,
      runtimeReady: snapshot?.runtimeReady === true,
    };
  }

  private assertRuntimeReady(serverId: string): void {
    const availability = this.agentGateway.stateCache.getRuntimeBlockReason(serverId);
    if (!availability.enabled) {
      throw new ConflictException({
        statusCode: 409,
        code: 'agent_state_unready',
        reason: 'agent_state_unready',
        message: availability.message,
      });
    }
  }

  private assertValidSlug(slug: string): void {
    if (!SERVER_SLUG_RE.test(slug)) {
      throw new BadRequestException('Server slug must be a lowercase resource name');
    }
  }
}
