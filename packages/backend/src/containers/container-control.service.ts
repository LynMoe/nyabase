import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  ActionAvailability,
  AgentCommandKind,
  ContainerAction,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  ContainerStatsResponse,
  ContainerView,
  CreateContainerRequest,
  OperationKind,
  OperationStatus,
  OperationRefResponse,
  RuntimeDriftKind,
  type ExecSessionRequest,
  type ContainerMountSpec,
  type ContainerSnapshot,
} from '@nyabase/common';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import { ContainerOperationService } from './container-operation.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { ResourceKeyService } from '../operations/resource-key.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { resolveGpuIndices, shouldCountContainerForQuota } from './resource-quota.policy.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { ExecSessionRegistry } from '../gateway/exec-session-registry.js';
import { ContainerSshRouteService } from '../ssh/container-ssh-route.service.js';
import { SshIdentityService } from '../ssh/ssh-identity.service.js';
import { SshProxySnapshotService } from '../ssh/ssh-proxy-snapshot.service.js';
import type { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';

type MountInput = NonNullable<CreateContainerRequest['dataDirs']>[number];

type NormalizedMount = MountInput & { id: string };

type ResolvedMount = NormalizedMount & { hostPath: string };

@Injectable()
export class ContainerControlService {
  constructor(
    private dataSource: DataSource,
    private access: AccessResolverService,
    private actions: ContainerActionPolicyService,
    private operations: ContainerOperationService,
    private operationsService: OperationsService,
    private resourceKeys: ResourceKeyService,
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
    @InjectRepository(ContainerDesiredSpecEntity)
    private desiredRepo: Repository<ContainerDesiredSpecEntity>,
    @InjectRepository(ContainerLifecycleEntity)
    private lifecycleRepo: Repository<ContainerLifecycleEntity>,
    @InjectRepository(OperationEntity)
    private operationsRepo: Repository<OperationEntity>,
    @InjectRepository(ImageEntity)
    private imagesRepo: Repository<ImageEntity>,
    @InjectRepository(ServerEntity)
    private serversRepo: Repository<ServerEntity>,
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    @InjectRepository(GpuAllocationEntity)
    private gpuAllocationsRepo: Repository<GpuAllocationEntity>,
    @InjectRepository(DataDiskEntity)
    private dataDisksRepo: Repository<DataDiskEntity>,
    @InjectRepository(DataDirectoryEntity)
    private dataDirsRepo: Repository<DataDirectoryEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private remoteFsAssignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    private agentGateway: AgentGateway,
    private execSessionRegistry: ExecSessionRegistry,
    private sshRoutes: ContainerSshRouteService,
    private sshIdentities: SshIdentityService,
    private sshProxySnapshots: SshProxySnapshotService,
  ) {}

  async list(userId: string, filters: { serverId?: string } = {}): Promise<ContainerView[]> {
    const where: { serverId?: string; ownerId?: string } = {};
    if (filters.serverId) where.serverId = filters.serverId;
    where.ownerId = userId;
    const containers = await this.containersRepo.find({ where, order: { createdAt: 'DESC' } });
    return this.viewsFor(containers);
  }

  async listForAdmin(filters: { serverId?: string } = {}): Promise<ContainerView[]> {
    const where: { serverId?: string } = {};
    if (filters.serverId) where.serverId = filters.serverId;
    const containers = await this.containersRepo.find({ where, order: { createdAt: 'DESC' } });
    return this.viewsFor(containers);
  }

  async get(containerId: string, userId: string): Promise<ContainerView> {
    const container = await this.containersRepo.findOneBy({ id: containerId });
    if (!container || container.deletedAt) throw new NotFoundException('Container not found');
    await this.assertCanRead(userId, container);
    return (await this.viewsFor([container]))[0];
  }

  async getForAdmin(containerId: string, _actorId: string): Promise<ContainerView> {
    const container = await this.containersRepo.findOneBy({ id: containerId });
    if (!container || container.deletedAt) throw new NotFoundException('Container not found');
    return (await this.viewsFor([container]))[0];
  }

  async create(userId: string, request: CreateContainerRequest): Promise<OperationRefResponse> {
    const grant = await this.access.resolveServer(userId, request.serverId);
    if (!grant) throw new ForbiddenException('No server access');
    const allowedImages = await this.access.resolveAllowedImages(userId, request.serverId);
    if (!allowedImages.has(request.imageId)) throw new ForbiddenException('No image access');
    const [image, user, server] = await Promise.all([
      this.imagesRepo.findOneBy({ id: request.imageId }),
      this.usersRepo.findOneBy({ id: userId }),
      this.serversRepo.findOneBy({ id: request.serverId }),
    ]);
    if (!image) throw new NotFoundException('Image not found');
    if (!image.isActive) throw new ForbiddenException('Image is inactive');
    if (!user?.numericId) throw new ForbiddenException('User numeric ID is required for container runtime operations');
    if (!server) throw new NotFoundException('Server not found');
    this.assertRuntimeReady(request.serverId);

    const effectiveGrant = grant ?? {
      cpuMillis: 0,
      memBytes: 0,
      diskBytes: 0,
      gpuMode: server.defaultGpuMode,
      gpuIndices: server.defaultGpuIndices,
    };
    for (const dir of request.dataDirs ?? []) {
      if (!await this.access.hasMountSourceAccess(userId, request.serverId, dir.sourceKind, dir.sourceId)) {
        throw new ForbiddenException('Mount source access denied');
      }
    }
    const normalizedMounts = this.normalizeMounts(request.dataDirs ?? []);
    await this.toAgentMountSpecs(request.serverId, userId, normalizedMounts);
    const runtimeOverrides = image.runtimeOverrides ?? {
      uid: image.defaultUid,
      entrypoint: null,
      cmd: null,
      init: false,
    };

    return runSerializedTransaction(this.dataSource, async (manager) => {
      const now = new Date();
      const containerId = uuidv4();
      const requestedCpu = effectiveGrant.cpuMillis ?? 0;
      const requestedMem = effectiveGrant.memBytes ?? 0;
      const requestedDisk = effectiveGrant.diskBytes ?? 0;
      const gpuLoad = await this.gpuLoadMap(request.serverId, manager);
      const knownGpuIndices = await this.knownGpuIndices(
        request.serverId,
        server.defaultGpuIndices,
        [...gpuLoad.keys()],
        manager,
      );
      const gpuIndices = resolveGpuIndices(
        effectiveGrant,
        knownGpuIndices,
      );

      const container = manager.create(ContainerEntity, {
        id: containerId,
        serverId: request.serverId,
        ownerId: userId,
        name: request.name,
        imageId: request.imageId,
        createdBy: userId,
        deletedAt: null,
      });
      await manager.save(ContainerEntity, container);
      await manager.save(ContainerDesiredSpecEntity, manager.create(ContainerDesiredSpecEntity, {
        id: uuidv4(),
        containerId,
        generation: 1,
        imageRef: image.dockerImage,
        imageDefaultUid: runtimeOverrides.uid,
        imageRuntimeOverrides: runtimeOverrides,
        cpuMillis: requestedCpu,
        memBytes: requestedMem,
        diskBytes: requestedDisk,
        gpuMode: gpuIndices.length > 0 ? 'indices' : 'none',
        gpuIndices,
        mountsJson: normalizedMounts,
        powerIntent: ContainerPowerIntent.Running,
      }));
      await manager.save(ContainerLifecycleEntity, manager.create(ContainerLifecycleEntity, {
        containerId,
        phase: ContainerPhase.Provisioning,
        boundRuntimeId: null,
        activeOperationId: null,
        lastTransitionAt: now,
        failureReason: null,
        failureCode: null,
      }));
      if (gpuIndices.length > 0) {
        await manager.save(GpuAllocationEntity, manager.create(GpuAllocationEntity, {
          containerId,
          serverId: request.serverId,
          gpuIndicesJson: gpuIndices,
          allocatedAt: now,
        }));
      }
      await this.saveMountRows(manager, container, userId, normalizedMounts);
      return this.operations.createContainerOperation(manager, {
        containerId,
        serverId: request.serverId,
        requestedBy: userId,
        kind: OperationKind.ContainerCreate,
        commandKind: AgentCommandKind.RuntimeContainerCreate,
        request: { ...request, cpuMillis: requestedCpu, memBytes: requestedMem, gpuIndices, dataDirs: normalizedMounts },
        payload: {
          containerId,
          specGeneration: 1,
          ownerId: userId,
          numericOwnerId: user.numericId,
          imageDockerRef: image.dockerImage,
          imageId: image.id,
          runtimeOverrides,
          name: request.name,
          cpuMillis: requestedCpu,
          memBytes: requestedMem,
          gpuIndices,
          ipCidr: server.ipCidr,
          gateway: server.gateway,
          reservedIps: server.reservedIps,
        },
        phase: ContainerPhase.Provisioning,
      });
    });
  }

  async action(containerId: string, action: ContainerAction, userId: string, body?: unknown): Promise<OperationRefResponse> {
    const container = await this.containersRepo.findOneBy({ id: containerId });
    if (!container || container.deletedAt) throw new NotFoundException('Container not found');
    await this.assertCanWrite(userId, container);
    return this.actionOnContainer(container, action, userId, body, userId);
  }

  async actionForAdmin(containerId: string, action: ContainerAction, actorId: string, body?: unknown): Promise<OperationRefResponse> {
    const container = await this.containersRepo.findOneBy({ id: containerId });
    if (!container || container.deletedAt) throw new NotFoundException('Container not found');
    return this.actionOnContainer(container, action, actorId, body, container.ownerId);
  }

  private async actionOnContainer(
    container: ContainerEntity,
    action: ContainerAction,
    requestedBy: string,
    body: unknown,
    accessUserId: string,
  ): Promise<OperationRefResponse> {
    const desired = await this.desiredRepo.findOneByOrFail({ containerId: container.id });
    const lifecycle = await this.lifecycleRepo.findOneByOrFail({ containerId: container.id });
    const view = await this.toView(
      container,
      desired,
      lifecycle,
      await this.serverMap([container.serverId]),
      await this.imageMap([container.imageId]),
      await this.userMap([container.ownerId]),
      (await this.sshRoutes.findByContainerIds([container.id])).get(container.id) ?? null,
      (await this.omittedServerLoginContainerIds([container])).has(container.id),
    );
    const availability = view.actions[action];
    if (!availability.enabled) {
      if (availability.reason === 'agent_state_unready') this.assertRuntimeReady(container.serverId);
      throw new ForbiddenException(availability.message ?? availability.reason ?? 'Action unavailable');
    }

    if (action !== 'delete' || lifecycle.boundRuntimeId) this.assertRuntimeReady(container.serverId);
    if (action === 'updateMounts') return this.updateMounts(container, desired, lifecycle, requestedBy, accessUserId, body);
    if (action === 'reconcileSsh') return this.reconcileSsh(container, lifecycle, requestedBy);
    if (action === 'delete' && !lifecycle.boundRuntimeId) {
      return this.operations.completeLocalContainerDelete(container.id, requestedBy);
    }

    const kind = this.operationKind(action);
    const commandKind = this.commandKind(action);
    const phase = action === 'delete' ? ContainerPhase.Deleting : ContainerPhase.Updating;
    const powerIntent = action === 'start' || action === 'restart'
      ? ContainerPowerIntent.Running
      : action === 'stop' || action === 'delete'
      ? ContainerPowerIntent.Stopped
      : undefined;
    const actionPayload: Record<string, unknown> = {
      containerId: container.id,
      runtimeId: lifecycle.boundRuntimeId,
      action,
      force: action === 'delete' ? true : undefined,
      body,
    };
    return this.operations.enqueueExistingContainerAction({
      containerId: container.id,
      requestedBy,
      kind,
      commandKind,
      request: body ?? { action },
      payload: actionPayload,
      phase,
      powerIntent,
    });
  }

  async createExecSession(
    containerId: string,
    userId: string,
    request: ExecSessionRequest,
  ): Promise<{ sessionId: string }> {
    const container = await this.containersRepo.findOneBy({ id: containerId });
    if (!container || container.deletedAt) throw new NotFoundException('Container not found');
    await this.assertCanRead(userId, container);
    return this.createExecSessionForContainer(container, userId, request);
  }

  async createExecSessionForAdmin(
    containerId: string,
    actorId: string,
    request: ExecSessionRequest,
  ): Promise<{ sessionId: string }> {
    const container = await this.containersRepo.findOneBy({ id: containerId });
    if (!container || container.deletedAt) throw new NotFoundException('Container not found');
    return this.createExecSessionForContainer(container, actorId, request);
  }

  private async createExecSessionForContainer(
    container: ContainerEntity,
    actorId: string,
    request: ExecSessionRequest,
  ): Promise<{ sessionId: string }> {
    const desired = await this.desiredRepo.findOneByOrFail({ containerId: container.id });
    const lifecycle = await this.lifecycleRepo.findOneByOrFail({ containerId: container.id });
    const view = await this.toView(
      container,
      desired,
      lifecycle,
      await this.serverMap([container.serverId]),
      await this.imageMap([container.imageId]),
      await this.userMap([container.ownerId]),
      (await this.sshRoutes.findByContainerIds([container.id])).get(container.id) ?? null,
      (await this.omittedServerLoginContainerIds([container])).has(container.id),
    );
    if (!view.actions.console.enabled) {
      throw new ForbiddenException(view.actions.console.message ?? view.actions.console.reason ?? 'Console unavailable');
    }
    const runtimeId = lifecycle.boundRuntimeId;
    if (!runtimeId) throw new ForbiddenException('Runtime is not bound yet');

    const sessionId = uuidv4();
    this.execSessionRegistry.register(sessionId, {
      serverId: container.serverId,
      userId: actorId,
      dockerId: runtimeId,
      createdAt: Date.now(),
    });
    try {
      const shell = request.shell?.trim() || '/bin/sh';
      await this.agentGateway.rpc(container.serverId, 'execStream', {
        sessionId,
        runtimeId,
        cmd: [shell],
        tty: request.tty !== false,
        cols: request.cols,
        rows: request.rows,
      });
      return { sessionId };
    } catch (error) {
      this.execSessionRegistry.remove(sessionId);
      throw error;
    }
  }

  async getStats(containerId: string, userId: string): Promise<ContainerStatsResponse> {
    const view = await this.get(containerId, userId);
    return this.statsForView(view);
  }

  async getStatsForAdmin(containerId: string, actorId: string): Promise<ContainerStatsResponse> {
    const view = await this.getForAdmin(containerId, actorId);
    return this.statsForView(view);
  }

  private async statsForView(view: ContainerView): Promise<ContainerStatsResponse> {
    if (!view.actions.stats.enabled) {
      throw new ForbiddenException(view.actions.stats.message ?? view.actions.stats.reason ?? 'Stats unavailable');
    }

    if (view.runtime.runtimeId) {
      const snapshot = this.agentGateway.stateCache.getContainerByContainerId(view.serverId, view.id);
      const observedAt = this.agentGateway.stateCache.get(view.serverId)?.lastUpdated ?? Date.now();
      return {
        containerId: view.id,
        stats: snapshot?.stats ?? null,
        ts: observedAt,
        lastObservedAt: new Date(observedAt).toISOString(),
      };
    }
    return {
      containerId: view.id,
      stats: null,
      ts: Date.now(),
    };
  }

  disabledAction(reason: ActionAvailability['reason'], message: string): ActionAvailability {
    return this.actions.disabled(reason, message);
  }

  private async updateMounts(
    container: ContainerEntity,
    desired: ContainerDesiredSpecEntity,
    lifecycle: ContainerLifecycleEntity,
    requestedBy: string,
    accessUserId: string,
    body: unknown,
  ): Promise<OperationRefResponse> {
    if (!Array.isArray(body)) throw new BadRequestException('Mount update body must be an array');
    const mounts = this.normalizeMounts(body as MountInput[]);
    for (const dir of mounts) {
      if (!await this.access.hasMountSourceAccess(accessUserId, container.serverId, dir.sourceKind, dir.sourceId)) {
        throw new ForbiddenException('Mount source access denied');
      }
    }
    if (!lifecycle.boundRuntimeId) throw new ForbiddenException('Runtime is not bound yet');
    const expected = await this.toAgentMountSpecs(container.serverId, container.ownerId, mounts);
    const currentMounts = this.mountsFromDesired(desired);
    const nextPaths = new Set(mounts.map((m) => m.containerPath));
    const toRemove = currentMounts
      .map((m) => m.containerPath)
      .filter((path) => !nextPaths.has(path));
    return this.operations.enqueueExistingContainerAction({
      containerId: container.id,
      requestedBy,
      kind: OperationKind.ContainerUpdateMounts,
      commandKind: AgentCommandKind.Noop,
      request: { action: 'updateMounts', mounts },
      payload: {
        containerId: container.id,
        runtimeId: lifecycle.boundRuntimeId,
        expected,
        toRemove,
      },
      phase: ContainerPhase.Updating,
      beforeSave: async (manager, operationId) => {
        await manager.update(ContainerDesiredSpecEntity, { containerId: container.id }, {
          mountsJson: mounts,
          generation: () => 'generation + 1',
          updatedAt: new Date(),
        });
        await this.saveMountRows(manager, container, container.ownerId, mounts, operationId);
      },
    });
  }

  private async viewsFor(containers: ContainerEntity[]): Promise<ContainerView[]> {
    if (containers.length === 0) return [];
    const ids = containers.map((c) => c.id);
    const [desiredRows, lifecycleRows, servers, images, users, routes] = await Promise.all([
      this.desiredRepo.find({ where: { containerId: In(ids) } }),
      this.lifecycleRepo.find({ where: { containerId: In(ids) } }),
      this.serverMap([...new Set(containers.map((c) => c.serverId))]),
      this.imageMap([...new Set(containers.map((c) => c.imageId))]),
      this.userMap([...new Set(containers.map((c) => c.ownerId))]),
      this.sshRoutes.findByContainerIds(ids),
    ]);
    const desired = new Map(desiredRows.map((d) => [d.containerId, d]));
    const lifecycle = new Map(lifecycleRows.map((l) => [l.containerId, l]));
    const visible = containers.filter((c) => !c.deletedAt);
    const omittedLoginIds = await this.omittedServerLoginContainerIds(visible);
    return Promise.all(visible.map((c) => this.toView(
      c,
      desired.get(c.id) ?? null,
      lifecycle.get(c.id) ?? null,
      servers,
      images,
      users,
      routes.get(c.id) ?? null,
      omittedLoginIds.has(c.id),
    )));
  }

  private async toView(
    c: ContainerEntity,
    desired: ContainerDesiredSpecEntity | null,
    lifecycle: ContainerLifecycleEntity | null,
    servers: Map<string, ServerEntity>,
    images: Map<string, ImageEntity>,
    users: Map<string, UserEntity>,
    sshRoute: ContainerSshRouteEntity | null,
    omittedServerLoginAllowed: boolean,
  ): Promise<ContainerView> {
    const activeOperation = await this.activeOperationForContainer(c.id, lifecycle);
    const phase = lifecycle?.phase ?? ContainerPhase.Failed;
    const runtimeReady = this.agentGateway.stateCache.isRuntimeReady(c.serverId);
    const serverSnap = this.agentGateway.stateCache.get(c.serverId);
    const snapshot = runtimeReady ? this.agentGateway.stateCache.getContainerByContainerId(c.serverId, c.id) : undefined;
    const runtimeId = lifecycle?.boundRuntimeId ?? snapshot?.spec.runtimeId ?? null;
    const runtimeStatus = snapshot?.status ?? ContainerStatus.Unknown;
    const runtimeIp = this.nonEmptyString(snapshot?.spec.ip) ?? null;
    const drift = this.runtimeDrift(desired, lifecycle, snapshot, runtimeReady);
    const server = servers.get(c.serverId);
    const image = images.get(c.imageId);
    const owner = users.get(c.ownerId);
    return {
      id: c.id,
      serverId: c.serverId,
      serverName: server?.name ?? c.serverId,
      ownerId: c.ownerId,
      ownerName: owner?.username,
      name: c.name,
      imageId: c.imageId,
      imageName: image?.name,
      failureCode: lifecycle?.failureCode ?? null,
      failureReason: lifecycle?.failureReason ?? null,
      powerIntent: desired?.powerIntent ?? ContainerPowerIntent.Stopped,
      runtimeReady,
      runtime: {
        bound: Boolean(lifecycle?.boundRuntimeId || snapshot),
        runtimeId,
        status: runtimeStatus,
        ip: runtimeIp,
        observedAt: snapshot ? new Date(serverSnap?.lastUpdated ?? Date.now()).toISOString() : null,
        drift,
      },
      activeOperation: activeOperation ? {
        id: activeOperation.id,
        kind: activeOperation.kind,
        status: activeOperation.status,
        resourceType: activeOperation.resourceType,
        resourceId: activeOperation.resourceId,
        serverId: activeOperation.serverId,
        requestedBy: activeOperation.requestedBy,
        resourceKeys: activeOperation.resourceKeysJson,
        commandId: activeOperation.commandId,
        commandKind: activeOperation.commandKind,
        request: activeOperation.requestJson,
        result: activeOperation.resultJson,
        hookResults: activeOperation.hookResultsJson,
        lastError: activeOperation.lastError,
        createdAt: activeOperation.createdAt.toISOString(),
        startedAt: activeOperation.startedAt?.toISOString() ?? null,
        commandCompletedAt: activeOperation.commandCompletedAt?.toISOString() ?? null,
        completedAt: activeOperation.completedAt?.toISOString() ?? null,
      } : null,
      resources: {
        cpuMillis: desired?.cpuMillis ?? 0,
        memBytes: desired?.memBytes ?? 0,
        diskBytes: desired?.diskBytes ?? 0,
        gpuIndices: desired?.gpuIndices ?? [],
      },
      ssh: this.sshView(c, owner, server, image, snapshot, sshRoute, omittedServerLoginAllowed),
      mounts: this.mountsFromDesired(desired),
      actions: this.actions.forContainer({
        phase,
        runtimeReady,
        runtimeStatus,
        runtimeDrift: drift,
        activeOperationId: activeOperation?.id ?? null,
        sshEnabled: image?.disableSsh !== true,
      }),
    };
  }

  private async activeOperationForContainer(
    containerId: string,
    lifecycle: ContainerLifecycleEntity | null,
  ): Promise<OperationEntity | null> {
    if (lifecycle?.activeOperationId) {
      const operation = await this.operationsRepo.findOneBy({ id: lifecycle.activeOperationId });
      if (operation && ![
        OperationStatus.Succeeded,
        OperationStatus.Failed,
        OperationStatus.Cancelled,
      ].includes(operation.status)) {
        return operation;
      }
    }
    return this.operationsService.activeOperationForResource([
      this.resourceKeys.container(containerId),
    ]);
  }

  private nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private mountsFromDesired(desired: ContainerDesiredSpecEntity | null): ContainerView['mounts'] {
    const mounts = this.normalizedMountsFromDesired(desired);
    return mounts.map((mount, index) => ({
      id: mount.id ?? `${mount.sourceKind}:${mount.sourceId}:${mount.dirName}:${index}`,
      sourceKind: mount.sourceKind,
      sourceId: mount.sourceId,
      dirName: mount.dirName,
      containerPath: mount.containerPath,
    }));
  }

  private normalizedMountsFromDesired(desired: ContainerDesiredSpecEntity | null): NormalizedMount[] {
    const mounts = Array.isArray(desired?.mountsJson) ? desired.mountsJson as NormalizedMount[] : [];
    return mounts.map((mount, index) => ({
      id: mount.id ?? `${mount.sourceKind}:${mount.sourceId}:${mount.dirName}:${index}`,
      sourceKind: mount.sourceKind,
      sourceId: mount.sourceId,
      dirName: mount.dirName,
      containerPath: mount.containerPath,
    }));
  }

  private normalizeMounts(input: MountInput[]): NormalizedMount[] {
    const seenPaths = new Set<string>();
    const seenDirs = new Set<string>();
    return input.map((dir) => {
      const sourceKind = dir.sourceKind;
      const sourceId = String(dir.sourceId ?? '').trim();
      const dirName = String(dir.dirName ?? '').trim();
      const containerPath = this.normalizeContainerPath(String(dir.containerPath ?? '').trim());
      if (sourceKind !== 'local' && sourceKind !== 'remote') throw new BadRequestException('Invalid mount source kind');
      if (!sourceId) throw new BadRequestException('Mount source is required');
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dirName)) throw new BadRequestException('Invalid mount dir name');
      if (seenPaths.has(containerPath)) throw new BadRequestException('Duplicate container mount path');
      seenPaths.add(containerPath);
      const key = `${sourceKind}:${sourceId}:${dirName}`;
      if (seenDirs.has(key)) throw new BadRequestException('Duplicate mount source directory');
      seenDirs.add(key);
      return {
        id: `${sourceKind}:${sourceId}:${dirName}:${containerPath}`,
        sourceKind,
        sourceId,
        dirName,
        containerPath,
      };
    });
  }

  private normalizeContainerPath(value: string): string {
    if (!value.startsWith('/')) throw new BadRequestException('Container path must be absolute');
    const parts = value.split('/').filter(Boolean);
    if (parts.length === 0) throw new BadRequestException('Container path must not be root');
    if (parts.some((part) => part === '.' || part === '..')) throw new BadRequestException('Container path must not contain dot segments');
    return `/${parts.join('/')}`;
  }

  private async toAgentMountSpecs(
    serverId: string,
    userId: string,
    mounts: NormalizedMount[],
  ): Promise<ContainerMountSpec[]> {
    const result: ContainerMountSpec[] = [];
    const resolved = await this.resolveMounts(serverId, userId, mounts);
    for (const mount of resolved) {
      result.push({
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
        userId,
        dirName: mount.dirName,
        hostPath: mount.hostPath,
        containerPath: mount.containerPath,
      });
    }
    return result;
  }

  private async reconcileSsh(
    container: ContainerEntity,
    lifecycle: ContainerLifecycleEntity,
    requestedBy: string,
  ): Promise<OperationRefResponse> {
    if (!lifecycle.boundRuntimeId) throw new ForbiddenException('Runtime is not bound yet');
    const internalKey = await this.sshIdentities.getUserInternalPublicKey(container.ownerId);
    return this.operations.enqueueExistingContainerAction({
      containerId: container.id,
      requestedBy,
      kind: OperationKind.ContainerReconcileSsh,
      commandKind: AgentCommandKind.RuntimeContainerSshApply,
      request: { action: 'reconcileSsh' },
      payload: {
        containerId: container.id,
        runtimeId: lifecycle.boundRuntimeId,
        enabled: true,
        internalPublicKey: internalKey.publicKey,
        internalKeyGeneration: internalKey.generation,
      },
      phase: ContainerPhase.Updating,
    });
  }

  private async resolveMounts(
    serverId: string,
    userId: string,
    mounts: NormalizedMount[],
  ): Promise<ResolvedMount[]> {
    const result: ResolvedMount[] = [];
    for (const mount of mounts) {
      result.push({
        ...mount,
        hostPath: await this.resolveHostPath(serverId, userId, mount),
      });
    }
    return result;
  }

  private async resolveHostPath(serverId: string, userId: string, mount: NormalizedMount): Promise<string> {
    const dataDir = await this.dataDirsRepo.findOneBy({
      sourceKind: mount.sourceKind,
      sourceId: mount.sourceId,
      name: mount.dirName,
      userId,
      desiredState: 'active',
    });
    if (!dataDir) throw new NotFoundException('Data directory not found');

    if (mount.sourceKind === 'local') {
      const disk = await this.dataDisksRepo.findOneBy({ id: mount.sourceId, serverId, desiredState: 'active' });
      if (!disk) throw new NotFoundException('Data disk not found');
      return this.joinHostPath(disk.mountPoint, mount.dirName);
    }
    const assignment = await this.remoteFsAssignmentsRepo.findOneBy({
      remoteFsMountId: mount.sourceId,
      serverId,
      desiredState: 'active',
    });
    if (!assignment) throw new NotFoundException('Remote FS mount not assigned to server');
    const remote = await this.remoteFsRepo.findOneBy({ id: mount.sourceId, desiredState: 'active' });
    if (!remote) throw new NotFoundException('Remote FS mount not found');
    return this.joinHostPath(remote.hostMountPoint, mount.dirName);
  }

  private joinHostPath(root: string, dirName: string): string {
    return `${root.replace(/\/+$/, '')}/${dirName}`;
  }

  private async saveMountRows(
    manager: EntityManager,
    container: ContainerEntity,
    userId: string,
    mounts: NormalizedMount[],
    _operationId?: string,
  ): Promise<void> {
    await manager.delete('container_mounts', { containerId: container.id });
    if (mounts.length === 0) return;
    await manager.insert('container_mounts', mounts.map((mount) => ({
      id: uuidv4(),
      serverId: container.serverId,
      containerId: container.id,
      dockerId: null,
      containerName: container.name,
      sourceKind: mount.sourceKind,
      sourceId: mount.sourceId,
      userId,
      dirName: mount.dirName,
      containerPath: mount.containerPath,
    })));
  }

  private async gpuLoadMap(serverId: string, manager?: EntityManager): Promise<Map<number, number>> {
    const rows = manager
      ? await manager.find(GpuAllocationEntity, { where: { serverId } })
      : await this.gpuAllocationsRepo.find({ where: { serverId } });
    if (rows.length === 0) return new Map();
    const lifecycles = manager
      ? await manager.find(ContainerLifecycleEntity, { where: { containerId: In(rows.map((row) => row.containerId)) } })
      : await this.lifecycleRepo.find({ where: { containerId: In(rows.map((row) => row.containerId)) } });
    const lifecycleById = new Map(lifecycles.map((l) => [l.containerId, l]));
    const containers = manager
      ? await manager.find(ContainerEntity, { where: { id: In(rows.map((row) => row.containerId)) } })
      : await this.containersRepo.find({ where: { id: In(rows.map((row) => row.containerId)) } });
    const containerById = new Map(containers.map((c) => [c.id, c]));
    const load = new Map<number, number>();
    for (const row of rows) {
      const lifecycle = lifecycleById.get(row.containerId);
      const container = containerById.get(row.containerId);
      if (!lifecycle || !container || !shouldCountContainerForQuota(lifecycle.phase, container.deletedAt)) continue;
      for (const idx of row.gpuIndicesJson ?? []) load.set(idx, (load.get(idx) ?? 0) + 1);
    }
    return load;
  }

  private async knownGpuIndices(serverId: string, serverDefaultIndices: number[], assigned: number[], manager?: EntityManager): Promise<number[]> {
    void manager;
    const fromInventory = this.agentGateway.stateCache.get(serverId)?.gpus.map((gpu) => gpu.index) ?? [];
    return [...new Set([...fromInventory, ...serverDefaultIndices, ...assigned])].sort((a, b) => a - b);
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

  private runtimeDrift(
    desired: ContainerDesiredSpecEntity | null,
    lifecycle: ContainerLifecycleEntity | null,
    snapshot: ContainerSnapshot | undefined,
    runtimeReady: boolean,
  ): ContainerView['runtime']['drift'] {
    const drift: ContainerView['runtime']['drift'] = [];
    if (!runtimeReady) {
      drift.push({ kind: RuntimeDriftKind.AgentStateUnready, message: 'Agent runtime state is not ready' });
      return drift;
    }
    if (!lifecycle?.boundRuntimeId && !snapshot) {
      drift.push({ kind: RuntimeDriftKind.RuntimeUnbound, message: 'Container has no bound runtime' });
    }
    if (desired && lifecycle?.phase === ContainerPhase.Active && !snapshot) {
      drift.push({ kind: RuntimeDriftKind.RuntimeMissing, message: 'Runtime container is missing from agent state' });
    }
    if (lifecycle?.boundRuntimeId && snapshot?.spec.runtimeId && lifecycle.boundRuntimeId !== snapshot.spec.runtimeId) {
      drift.push({
        kind: RuntimeDriftKind.RuntimeIdMismatch,
        desired: lifecycle.boundRuntimeId,
        observed: snapshot.spec.runtimeId,
      });
    }
    if (desired && snapshot) {
      const wantsRunning = desired.powerIntent === ContainerPowerIntent.Running;
      const isRunning = snapshot.status === ContainerStatus.Running;
      const isStopped = snapshot.status === ContainerStatus.Exited || snapshot.status === ContainerStatus.Dead;
      if ((wantsRunning && !isRunning) || (!wantsRunning && !isStopped)) {
        drift.push({
          kind: RuntimeDriftKind.PowerIntentMismatch,
          desired: desired.powerIntent,
          observed: snapshot.status,
        });
      }
      const observedGeneration = this.numberOrNull(snapshot.labels?.['nyabase.specGeneration'] ?? snapshot.labels?.['nyabase.spec_generation']);
      if (observedGeneration !== null && observedGeneration < desired.generation) {
        drift.push({
          kind: RuntimeDriftKind.SpecGenerationStale,
          desired: desired.generation,
          observed: observedGeneration,
        });
      }
    }
    return drift;
  }

  private numberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value !== 'string' || value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  private sshView(
    container: ContainerEntity,
    owner: UserEntity | undefined,
    server: ServerEntity | undefined,
    image: ImageEntity | undefined,
    snapshot: ContainerSnapshot | undefined,
    route: ContainerSshRouteEntity | null,
    omittedServerLoginAllowed: boolean,
  ): ContainerView['ssh'] {
    const endpoint = this.sshProxySnapshots.endpoint();
    const disabledByImage = image?.disableSsh === true;
    const status = route?.sshStatus ?? snapshot?.sshServer.status ?? (disabledByImage ? 'disabled' : 'unknown');
    const runningRoute = Boolean(
      !disabledByImage
      && route?.macvlanIp
      && route.runtimeStatus === ContainerStatus.Running
      && route.sshStatus === 'running',
    );
    const username = owner?.username ?? container.ownerId;
    const explicitLogin = runningRoute && server
      ? `${username}.${server.slug}.${container.name}`
      : null;
    return {
      enabled: !disabledByImage,
      ready: runningRoute,
      status,
      disabledReason: disabledByImage
        ? 'image_ssh_disabled'
        : runningRoute
        ? undefined
        : !route
        ? 'route_missing'
        : route.runtimeStatus !== ContainerStatus.Running
        ? 'runtime_not_running'
        : 'sync_pending',
      login: {
        omittedServer: runningRoute && omittedServerLoginAllowed
          ? `${username}.${container.name}`
          : null,
        explicitServer: explicitLogin,
      },
      proxyHost: endpoint?.host ?? null,
      proxyPort: endpoint?.port ?? null,
      observedAt: route?.observedAt?.toISOString() ?? null,
      appliedInternalKeyGeneration: route?.appliedInternalKeyGeneration ?? null,
      hostKeyFingerprint: route?.containerHostKeyFingerprint ?? snapshot?.sshServer.hostKeyFingerprint ?? null,
      user: 'root',
      port: 22,
      lastError: route?.lastError ?? snapshot?.sshServer.lastError,
    };
  }

  private async omittedServerLoginContainerIds(containers: ContainerEntity[]): Promise<Set<string>> {
    const relevant = containers.filter((container) => !container.deletedAt);
    if (relevant.length === 0) return new Set();
    const ownerIds = [...new Set(relevant.map((container) => container.ownerId))];
    const names = [...new Set(relevant.map((container) => container.name))];
    const candidates = await this.containersRepo.find({
      where: {
        ownerId: In(ownerIds),
        name: In(names),
      },
    });
    const candidateIds = candidates.filter((container) => !container.deletedAt).map((container) => container.id);
    const [routes, images] = await Promise.all([
      this.sshRoutes.findByContainerIds(candidateIds),
      this.imageMap([...new Set(candidates.map((container) => container.imageId))]),
    ]);
    const activeByOwnerName = new Map<string, ContainerEntity[]>();
    for (const candidate of candidates) {
      if (candidate.deletedAt) continue;
      const route = routes.get(candidate.id);
      const image = images.get(candidate.imageId);
      if (!route || image?.disableSsh === true) continue;
      if (!route.macvlanIp || route.runtimeStatus !== ContainerStatus.Running || route.sshStatus !== 'running') continue;
      const key = `${candidate.ownerId}\n${candidate.name.toLowerCase()}`;
      const list = activeByOwnerName.get(key) ?? [];
      list.push(candidate);
      activeByOwnerName.set(key, list);
    }
    const result = new Set<string>();
    for (const list of activeByOwnerName.values()) {
      if (list.length === 1) result.add(list[0].id);
    }
    return result;
  }

  private async assertCanRead(userId: string, c: ContainerEntity): Promise<void> {
    if (c.ownerId === userId) return;
    throw new ForbiddenException();
  }

  private async assertCanWrite(userId: string, c: ContainerEntity): Promise<void> {
    await this.assertCanRead(userId, c);
  }

  private async serverMap(serverIds: string[]): Promise<Map<string, ServerEntity>> {
    const rows = serverIds.length ? await this.serversRepo.find({ where: { id: In(serverIds) } }) : [];
    return new Map(rows.map((s) => [s.id, s]));
  }

  private async imageMap(imageIds: string[]): Promise<Map<string, ImageEntity>> {
    const rows = imageIds.length ? await this.imagesRepo.find({ where: { id: In(imageIds) } }) : [];
    return new Map(rows.map((image) => [image.id, image]));
  }

  private async userMap(userIds: string[]): Promise<Map<string, UserEntity>> {
    const rows = userIds.length ? await this.usersRepo.find({ where: { id: In(userIds) } }) : [];
    return new Map(rows.map((user) => [user.id, user]));
  }

  private operationKind(action: ContainerAction): OperationKind {
    switch (action) {
      case 'start': return OperationKind.ContainerStart;
      case 'stop': return OperationKind.ContainerStop;
      case 'restart': return OperationKind.ContainerRestart;
      case 'delete': return OperationKind.ContainerDelete;
      case 'updateMounts': return OperationKind.ContainerUpdateMounts;
      case 'reconcileSsh': return OperationKind.ContainerReconcileSsh;
      default: return OperationKind.ContainerRestart;
    }
  }

  private commandKind(action: ContainerAction): AgentCommandKind {
    switch (action) {
      case 'delete': return AgentCommandKind.RuntimeContainerDelete;
      case 'updateMounts': return AgentCommandKind.RuntimeContainerMountsApply;
      case 'reconcileSsh': return AgentCommandKind.RuntimeContainerSshApply;
      default: return AgentCommandKind.RuntimeContainerPower;
    }
  }
}
