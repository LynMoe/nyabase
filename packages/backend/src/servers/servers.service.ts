import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Inject,
  Logger,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes, createHash } from 'crypto';
import type { ServerRecord } from '../domain/domain-records.js';
import {
  ServerStatus,
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
import { postCommitBestEffort } from '../common/post-commit.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { AuditService } from '../audit/audit.service.js';
import { publicDataDiskDisplayName } from '../mount-sources/utils.js';
import { safeEpochToIso } from '../common/safe-date.js';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';

const SERVER_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

interface ServerDtoOptions {
  includeHostFingerprint?: boolean;
}

@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);
  private readonly infrastructure: InfrastructureRepository;
  private readonly transactions: PgTransactionManager;

  constructor(
    @Inject(InfrastructureRepository)
    infrastructure: unknown,
    private agentGateway: AgentGateway,
    private accessResolver: AccessResolverService,
    private sshProxyGateway: SshProxyGateway,
    @Inject(PgTransactionManager)
    transactions: unknown,
    private proxySnapshots: ProxySnapshotNotifierService,
    private auditService: AuditService,
    private readonly workflowRepository: WorkflowRepository,
  ) {
    this.infrastructure = infrastructure as InfrastructureRepository;
    this.transactions = transactions as PgTransactionManager;
  }

  async create(actorId: string, dto: {
    name: string;
    slug: string;
  }) {
    this.assertValidSlug(dto.slug);
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const server = await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction, actorId, [Capability.ManageServers],
      );
      await this.infrastructure.lockServerCapacity(transaction);
      if (await this.infrastructure.countServers(transaction) >= MAX_PLATFORM_SERVERS) {
        throw new ConflictException({
          code: 'SERVER_CAPACITY_REACHED',
          message: `At most ${MAX_PLATFORM_SERVERS} servers are supported`,
        });
      }
      if (await this.infrastructure.findServerBySlug(dto.slug, transaction)) {
        throw new ConflictException('Server slug already exists');
      }
      const deletingImage = await transaction
        .selectFrom('infra.images')
        .select('id')
        .where('deleting', '=', true)
        .executeTakeFirst();
      if (deletingImage) {
        throw new ConflictException('A server cannot be created while image cleanup is in progress');
      }
      const created = await this.infrastructure.insertServer({
        id: uuidv4(),
        name: dto.name,
        slug: dto.slug,
        agentTokenHash: tokenHash,
        macvlanCidr: null,
        macvlanGateway: null,
        macvlanReservedIps: [],
      }, transaction);
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.CreateServer,
        created.id,
        'server',
        { serverId: created.id, name: created.name, slug: created.slug },
      );
      return created;
    }).catch((error: unknown) => {
      if (isPgUniqueViolation(error)) {
        throw new ConflictException('Server slug already exists');
      }
      throw error;
    });
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

  async findAll(): Promise<ServerRecord[]> {
    return this.infrastructure.listServers();
  }

  async findAllDtos(options: ServerDtoOptions = {}): Promise<ServerDto[]> {
    const servers = await this.infrastructure.listServers();
    return Promise.all(servers.map((server) => this.toDto(server, options)));
  }

  async findByIds(ids: string[]): Promise<ServerRecord[]> {
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    return (await this.infrastructure.listServers()).filter((server) => wanted.has(server.id));
  }

  async findDtosByIds(ids: string[]): Promise<ServerDto[]> {
    const servers = await this.findByIds(ids);
    return Promise.all(servers.map((server) => this.toDto(server)));
  }

  async findUserDtosByIds(ids: string[]): Promise<UserServerDto[]> {
    const servers = await this.findByIds(ids);
    return servers.map((server) => this.toUserDto(server));
  }

  async findById(id: string): Promise<ServerRecord> {
    const server = await this.infrastructure.findServerById(id);
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }

  async findDtoById(id: string, options: ServerDtoOptions = {}): Promise<ServerDto> {
    return this.toDto(await this.findById(id), options);
  }

  async findUserDtoById(id: string): Promise<UserServerDto> {
    return this.toUserDto(await this.findById(id));
  }

  async findByTokenHash(hash: string): Promise<ServerRecord | null> {
    return this.infrastructure.findServerByTokenHash(hash);
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
    const saved = await this.transactions.run(async (transaction) => {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction, actorId, [Capability.ManageServers],
      );
      const server = await this.infrastructure.findServerById(id, transaction);
      if (!server) throw new NotFoundException('Server not found');
      if (dto.slug !== undefined && dto.slug !== server.slug) {
        const existingSlug = await this.infrastructure.findServerBySlug(dto.slug, transaction);
        if (existingSlug && existingSlug.id !== id) {
          throw new ConflictException('Server slug already exists');
        }
      }
      const allowed: Partial<Pick<ServerRecord, 'name' | 'slug'>> = {};
      if (dto.name !== undefined) allowed.name = dto.name;
      if (dto.slug !== undefined) allowed.slug = dto.slug;
      const saved = Object.keys(allowed).length > 0
        ? await this.infrastructure.updateServerIdentity(id, allowed, transaction)
        : server;
      if (!saved) throw new NotFoundException('Server not found');
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.UpdateServer,
        saved.id,
        'server',
        {
          serverId: saved.id,
          previous: { name: server.name, slug: server.slug },
          current: { name: saved.name, slug: saved.slug },
        },
      );
      return saved;
    }).catch((error: unknown) => {
      if (isPgUniqueViolation(error)) {
        throw new ConflictException('Server slug already exists');
      }
      throw error;
    });
    await postCommitBestEffort(
      'Server update SSH snapshot broadcast',
      () => this.sshProxyGateway.broadcastSnapshot(),
      this.logger,
    );
    return this.toDto(saved, { includeHostFingerprint: true });
  }

  async delete(actorId: string, id: string) {
    await this.workflowRepository.runWithAgentSessionMutationFence(
      id,
      'Server deletion started',
      async (transaction) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          transaction, actorId, [Capability.ManageServers],
        );
        const server = await this.infrastructure.findServerById(id, transaction);
        if (!server) throw new NotFoundException('Server not found');
        const dependencies: string[] = [];
        if (await transaction.selectFrom('iam.server_grants').select('id')
          .where('server_id', '=', id).executeTakeFirst()) dependencies.push('server grants');
        if (await transaction.selectFrom('iam.image_grants').select('id')
          .where('server_id', '=', id).executeTakeFirst()) dependencies.push('image grants');
        if (await transaction.selectFrom('iam.mount_source_grants').select('id')
          .where('server_id', '=', id).executeTakeFirst()) {
          dependencies.push('local mount source grants');
        }
        if (dependencies.length > 0) {
          throw new ConflictException({
            code: 'SERVER_NOT_EMPTY',
            message: 'Server still owns durable control-plane state',
            dependencies,
          });
        }
        await this.infrastructure.deleteServer(id, transaction);
        await this.auditService.append(
          transaction,
          actorId,
          AuditAction.DeleteServer,
          server.id,
          'server',
          { serverId: server.id, name: server.name, slug: server.slug },
        );
        return { serverId: server.id, name: server.name, slug: server.slug };
      },
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
    await this.workflowRepository.runWithAgentSessionMutationFence(
      id,
      'Agent token rotation started',
      async (transaction) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          transaction, actorId, [Capability.ManageServers],
        );
        const server = await this.infrastructure.findServerById(id, transaction);
        if (!server) throw new NotFoundException('Server not found');
        await this.infrastructure.replaceAgentTokenHash(id, agentTokenHash, transaction);
        await this.auditService.append(
          transaction,
          actorId,
          AuditAction.RotateServerAgentToken,
          id,
          'server',
        );
      },
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

  private async toDto(server: ServerRecord, options: ServerDtoOptions = {}): Promise<ServerDto> {
    const snap = this.agentGateway.stateCache.get(server.id);
    const disks = (snap?.disks ?? []).map((disk) => this.toDiskDto(disk));
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
      runtimeReady:
        server.status === ServerStatus.Online
        && snap?.runtimeReady === true,
      runtimeObservedAt: safeEpochToIso(snap?.lastUpdated),
      disks,
      gpus: snap?.gpus ?? [],
      agentVersion: snap?.agentVersion,
      dockerDaemon: snap?.dockerDaemon ?? null,
    };
  }

  private toUserDto(server: ServerRecord): UserServerDto {
    const snapshot = this.agentGateway.stateCache.get(server.id);
    return {
      id: server.id,
      name: server.name,
      slug: server.slug,
      status: server.status,
      lastSeenAt: server.lastSeenAt?.toISOString() ?? null,
      runtimeReady:
        server.status === ServerStatus.Online
        && snapshot?.runtimeReady === true,
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

function isPgUniqueViolation(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === '23505';
}
