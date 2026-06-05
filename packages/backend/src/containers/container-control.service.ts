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
  OperationRefResponse,
  type ExecSessionRequest,
  type ContainerMountSpec,
} from '@nyabase/common';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { RuntimeContainerEntity } from '../entities/runtime-container.entity.js';
import { RuntimeGpuInventoryEntity } from '../entities/runtime-gpu-inventory.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { ContainerRuntimeObservationEntity } from '../entities/container-runtime-observation.entity.js';
import { RuntimeContainerStatEntity } from '../entities/runtime-container-stat.entity.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import { ContainerOperationService } from './container-operation.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { resolveGpuIndices, shouldCountContainerForQuota } from './resource-quota.policy.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { ExecSessionRegistry } from '../gateway/exec-session-registry.js';

type MountInput = NonNullable<CreateContainerRequest['dataDirs']>[number];

type NormalizedMount = MountInput & { id: string };

@Injectable()
export class ContainerControlService {
  constructor(
    private dataSource: DataSource,
    private access: AccessResolverService,
    private actions: ContainerActionPolicyService,
    private operations: ContainerOperationService,
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
    @InjectRepository(ContainerDesiredSpecEntity)
    private desiredRepo: Repository<ContainerDesiredSpecEntity>,
    @InjectRepository(ContainerLifecycleEntity)
    private lifecycleRepo: Repository<ContainerLifecycleEntity>,
    @InjectRepository(RuntimeContainerEntity)
    private runtimeRepo: Repository<RuntimeContainerEntity>,
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
    @InjectRepository(RuntimeGpuInventoryEntity)
    private gpuInventoryRepo: Repository<RuntimeGpuInventoryEntity>,
    @InjectRepository(DataDiskEntity)
    private dataDisksRepo: Repository<DataDiskEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private remoteFsAssignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(SshPublicKeyEntity)
    private sshKeysRepo: Repository<SshPublicKeyEntity>,
    @InjectRepository(ContainerRuntimeObservationEntity)
    private runtimeObservationRepo: Repository<ContainerRuntimeObservationEntity>,
    private agentGateway: AgentGateway,
    private execSessionRegistry: ExecSessionRegistry,
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
    const mountSpecs = await this.toAgentMountSpecs(request.serverId, userId, normalizedMounts);
    const sshKeys = request.sshServerEnabled === true
      ? await this.sshKeysRepo.find({ where: { userId } })
      : [];
    const sshPublicKeys = sshKeys.map((key) => key.keyText);
    const runtimeOverrides = image.runtimeOverrides ?? {
      uid: image.defaultUid,
      entrypoint: null,
      cmd: null,
      init: false,
    };
    const createDirs = normalizedMounts.map((dir) => ({
      sourceKind: dir.sourceKind,
      sourceId: dir.sourceId,
      dirName: dir.dirName,
      createIfMissing: dir.createIfMissing === true,
      ownerUid: runtimeOverrides.uid,
    }));

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
        sshEnabled: request.sshServerEnabled === true,
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
          createDirs,
          mounts: mountSpecs,
          sshServerEnabled: request.sshServerEnabled === true,
          sshPublicKeys,
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
    const runtime = await this.runtimeRepo.findOne({ where: { containerId: container.id }, order: { lastSeenAt: 'DESC' } });
    const view = await this.toView(
      container,
      desired,
      lifecycle,
      runtime,
      null,
      await this.serverNameMap([container.serverId]),
      await this.imageNameMap([container.imageId]),
    );
    const availability = view.actions[action];
    if (!availability.enabled) throw new ForbiddenException(availability.message ?? availability.reason ?? 'Action unavailable');

    if (action === 'updateMounts') return this.updateMounts(container, desired, lifecycle, runtime, requestedBy, accessUserId, body);
    if (action === 'enableSsh') return this.applySsh(container, desired, lifecycle, runtime, requestedBy, true, body ?? { action });
    if (action === 'reconcileSsh') return this.applySsh(container, desired, lifecycle, runtime, requestedBy, false, body ?? { action });
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
    if (action === 'start' || action === 'restart') {
      const desiredMounts = this.normalizedMountsFromDesired(desired);
      const keys = desired.sshEnabled
        ? await this.sshKeysRepo.find({ where: { userId: container.ownerId } })
        : [];
      actionPayload.mounts = await this.toAgentMountSpecs(container.serverId, container.ownerId, desiredMounts);
      actionPayload.sshServerEnabled = desired.sshEnabled;
      actionPayload.sshPublicKeys = keys.map((key) => key.keyText);
    }
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
    const runtime = await this.runtimeRepo.findOne({ where: { containerId: container.id }, order: { lastSeenAt: 'DESC' } });
    const view = await this.toView(
      container,
      desired,
      lifecycle,
      runtime,
      null,
      await this.serverNameMap([container.serverId]),
      await this.imageNameMap([container.imageId]),
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
      const stat = await this.dataSource.getRepository(RuntimeContainerStatEntity).findOneBy({
        runtimeContainerId: `${view.serverId}:${view.runtime.runtimeId}`,
      });
      if (stat) {
        return {
          containerId: view.id,
          stats: stat.statsJson as ContainerStatsResponse['stats'],
          ts: stat.observedAt.getTime(),
          lastObservedAt: stat.observedAt.toISOString(),
        };
      }
    }

    const observation = await this.runtimeObservationRepo.findOne({
      where: { containerId: view.id, stale: false },
      order: { lastSeenAt: 'DESC', reportSeq: 'DESC' },
    });
    return {
      containerId: view.id,
      stats: observation?.stats ?? null,
      ts: observation?.lastSeenAt.getTime() ?? Date.now(),
      lastObservedAt: observation?.lastSeenAt.toISOString(),
    };
  }

  disabledAction(reason: ActionAvailability['reason'], message: string): ActionAvailability {
    return this.actions.disabled(reason, message);
  }

  private async updateMounts(
    container: ContainerEntity,
    desired: ContainerDesiredSpecEntity,
    lifecycle: ContainerLifecycleEntity,
    _runtime: RuntimeContainerEntity | null,
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
      commandKind: AgentCommandKind.RuntimeContainerMountsApply,
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

  private async applySsh(
    container: ContainerEntity,
    desired: ContainerDesiredSpecEntity,
    lifecycle: ContainerLifecycleEntity,
    _runtime: RuntimeContainerEntity | null,
    userId: string,
    enable: boolean,
    request: unknown,
  ): Promise<OperationRefResponse> {
    if (!lifecycle.boundRuntimeId) throw new ForbiddenException('Runtime is not bound yet');
    if (!enable && !desired.sshEnabled) throw new ConflictException('SSH is not enabled for this container');
    const keys = await this.sshKeysRepo.find({ where: { userId: container.ownerId } });
    const publicKeys = keys.map((key) => key.keyText);
    return this.operations.enqueueExistingContainerAction({
      containerId: container.id,
      requestedBy: userId,
      kind: enable ? OperationKind.ContainerEnableSsh : OperationKind.ContainerReconcileSsh,
      commandKind: AgentCommandKind.RuntimeContainerSshApply,
      request,
      payload: {
        containerId: container.id,
        runtimeId: lifecycle.boundRuntimeId,
        publicKeys,
      },
      phase: ContainerPhase.Updating,
      beforeSave: enable
        ? async (manager) => {
          await manager.update(ContainerDesiredSpecEntity, { containerId: container.id }, {
            sshEnabled: true,
            updatedAt: new Date(),
          });
        }
        : undefined,
    });
  }

  private async viewsFor(containers: ContainerEntity[]): Promise<ContainerView[]> {
    if (containers.length === 0) return [];
    const ids = containers.map((c) => c.id);
    const [desiredRows, lifecycleRows, runtimeRows, servers, images, observationRows] = await Promise.all([
      this.desiredRepo.find({ where: { containerId: In(ids) } }),
      this.lifecycleRepo.find({ where: { containerId: In(ids) } }),
      this.runtimeRepo.find({ where: { containerId: In(ids) }, order: { lastSeenAt: 'DESC' } }),
      this.serverNameMap([...new Set(containers.map((c) => c.serverId))]),
      this.imageNameMap([...new Set(containers.map((c) => c.imageId))]),
      this.runtimeObservationRepo.find({ where: { containerId: In(ids), stale: false }, order: { lastSeenAt: 'DESC' } }),
    ]);
    const desired = new Map(desiredRows.map((d) => [d.containerId, d]));
    const lifecycle = new Map(lifecycleRows.map((l) => [l.containerId, l]));
    const runtime = new Map<string, RuntimeContainerEntity>();
    for (const row of runtimeRows) if (row.containerId && !runtime.has(row.containerId)) runtime.set(row.containerId, row);
    const observations = new Map<string, ContainerRuntimeObservationEntity>();
    for (const row of observationRows) if (row.containerId && !observations.has(row.containerId)) observations.set(row.containerId, row);
    return Promise.all(containers.filter((c) => !c.deletedAt).map((c) => this.toView(
      c,
      desired.get(c.id) ?? null,
      lifecycle.get(c.id) ?? null,
      runtime.get(c.id) ?? null,
      observations.get(c.id) ?? null,
      servers,
      images,
    )));
  }

  private async toView(
    c: ContainerEntity,
    desired: ContainerDesiredSpecEntity | null,
    lifecycle: ContainerLifecycleEntity | null,
    runtime: RuntimeContainerEntity | null,
    observation: ContainerRuntimeObservationEntity | null,
    serverNames: Map<string, string>,
    imageNames: Map<string, string>,
  ): Promise<ContainerView> {
    const activeOperation = lifecycle?.activeOperationId
      ? await this.operationsRepo.findOneBy({ id: lifecycle.activeOperationId })
      : null;
    const phase = lifecycle?.phase ?? ContainerPhase.Failed;
    const runtimeStatus = runtime?.status ?? observation?.status ?? ContainerStatus.Unknown;
    const runtimeIp = this.nonEmptyString(runtime?.ip)
      ?? this.nonEmptyString(observation?.labels?.ip)
      ?? null;
    return {
      id: c.id,
      serverId: c.serverId,
      serverName: serverNames.get(c.serverId) ?? c.serverId,
      ownerId: c.ownerId,
      ownerName: undefined,
      name: c.name,
      imageId: c.imageId,
      imageName: imageNames.get(c.imageId),
      phase,
      failureCode: lifecycle?.failureCode ?? null,
      failureReason: lifecycle?.failureReason ?? null,
      powerIntent: desired?.powerIntent ?? ContainerPowerIntent.Stopped,
      runtime: {
        bound: Boolean(lifecycle?.boundRuntimeId),
        runtimeId: lifecycle?.boundRuntimeId ?? runtime?.runtimeId ?? null,
        status: runtimeStatus,
        ip: runtimeIp,
        observedAt: (runtime?.lastSeenAt ?? observation?.lastSeenAt)?.toISOString() ?? null,
        stale: runtime?.stale ?? observation?.stale ?? true,
        drift: [],
      },
      activeOperation: activeOperation ? {
        id: activeOperation.id,
        kind: activeOperation.kind,
        status: activeOperation.status,
        resourceType: activeOperation.resourceType,
        resourceId: activeOperation.resourceId,
        serverId: activeOperation.serverId,
        attempts: activeOperation.attempts,
        lastError: activeOperation.lastError,
        createdAt: activeOperation.createdAt.toISOString(),
        startedAt: activeOperation.startedAt?.toISOString() ?? null,
        completedAt: activeOperation.completedAt?.toISOString() ?? null,
      } : null,
      resources: {
        cpuMillis: desired?.cpuMillis ?? 0,
        memBytes: desired?.memBytes ?? 0,
        diskBytes: desired?.diskBytes ?? 0,
        gpuIndices: desired?.gpuIndices ?? [],
      },
      ssh: observation?.sshServer ?? { enabled: desired?.sshEnabled ?? false, status: desired?.sshEnabled ? 'unknown' : 'disabled', user: 'root', port: 22 },
      mounts: this.mountsFromDesired(desired),
      actions: this.actions.forContainer({ phase, runtimeStatus, runtimeStale: runtime?.stale ?? observation?.stale ?? true, activeOperationId: lifecycle?.activeOperationId ?? null }),
    };
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
      createIfMissing: mount.createIfMissing === true,
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
        createIfMissing: dir.createIfMissing === true,
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
    for (const mount of mounts) {
      result.push({
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
        userId,
        dirName: mount.dirName,
        hostPath: await this.resolveHostPath(serverId, userId, mount),
        containerPath: mount.containerPath,
      });
    }
    return result;
  }

  private async resolveHostPath(serverId: string, _userId: string, mount: NormalizedMount): Promise<string> {
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
      createIfMissing: mount.createIfMissing === true,
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
    const inventory = manager
      ? await manager.find(RuntimeGpuInventoryEntity, { where: { serverId } })
      : await this.gpuInventoryRepo.find({ where: { serverId } });
    const fromInventory = inventory.map((gpu) => gpu.gpuIndex);
    return [...new Set([...fromInventory, ...serverDefaultIndices, ...assigned])].sort((a, b) => a - b);
  }

  private async assertCanRead(userId: string, c: ContainerEntity): Promise<void> {
    if (c.ownerId === userId) return;
    throw new ForbiddenException();
  }

  private async assertCanWrite(userId: string, c: ContainerEntity): Promise<void> {
    await this.assertCanRead(userId, c);
  }

  private async serverNameMap(serverIds: string[]): Promise<Map<string, string>> {
    const rows = serverIds.length ? await this.serversRepo.find({ where: { id: In(serverIds) } }) : [];
    return new Map(rows.map((s) => [s.id, s.name]));
  }

  private async imageNameMap(imageIds: string[]): Promise<Map<string, string>> {
    const rows = imageIds.length ? await this.imagesRepo.find({ where: { id: In(imageIds) } }) : [];
    return new Map(rows.map((image) => [image.id, image.name]));
  }

  private operationKind(action: ContainerAction): OperationKind {
    switch (action) {
      case 'start': return OperationKind.ContainerStart;
      case 'stop': return OperationKind.ContainerStop;
      case 'restart': return OperationKind.ContainerRestart;
      case 'delete': return OperationKind.ContainerDelete;
      case 'updateMounts': return OperationKind.ContainerUpdateMounts;
      case 'enableSsh': return OperationKind.ContainerEnableSsh;
      case 'reconcileSsh': return OperationKind.ContainerReconcileSsh;
      default: return OperationKind.ContainerRestart;
    }
  }

  private commandKind(action: ContainerAction): AgentCommandKind {
    switch (action) {
      case 'delete': return AgentCommandKind.RuntimeContainerDelete;
      case 'updateMounts': return AgentCommandKind.RuntimeContainerMountsApply;
      case 'enableSsh':
      case 'reconcileSsh': return AgentCommandKind.RuntimeContainerSshApply;
      default: return AgentCommandKind.RuntimeContainerPower;
    }
  }
}
