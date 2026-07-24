import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  ActionAvailability,
  AuditAction,
  AgentTaskKind,
  AgentTaskStatus,
  ContainerAction,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  ContainerStatsResponse,
  ContainerView,
  Capability,
  CreateContainerRequest,
  AgentTaskRefResponse,
  LABEL,
  RuntimeDriftKind,
  ServerStatus,
  UserStatus,
  type ExecSessionRequest,
  type ContainerMountSpec,
  type ContainerSnapshot,
  remoteFsSourceIdentity,
  zInspectContainerResult,
  allocateNextIp,
  MAX_MANAGED_CONTAINERS_PER_AGENT,
} from '@nyabase/common';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import { ContainerTaskService } from './container-task.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { resolveGpuIndices, shouldCountContainerForQuota } from './resource-quota.policy.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { ExecSessionRegistry } from '../gateway/exec-session-registry.js';
import { ExecSessionAuthorizationService } from '../gateway/exec-session-authorization.service.js';
import { ContainerSshRouteService } from '../ssh/container-ssh-route.service.js';
import { SshIdentityService } from '../ssh/ssh-identity.service.js';
import { SshProxySnapshotService } from '../ssh/ssh-proxy-snapshot.service.js';
import type { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { networkHasUntrustedInventory } from '../common/network-inventory-safety.js';
import {
  assertNetworkClaimCapacity,
  gcExpiredNetworkClaims,
} from '../common/network-claim-ledger.js';
import { toUserAgentTaskDto } from '../agent-tasks/agent-task-projection.js';
import { AuditService } from '../audit/audit.service.js';
import { postCommitBestEffort } from '../common/post-commit.js';
import {
  requesterSafeContainerFailure,
  requesterSafeSshError,
} from './container-view-projection.js';
import {
  normalizeContainerMounts,
  type ContainerMountInput as MountInput,
  type NormalizedContainerMount as NormalizedMount,
} from './container-mount-normalizer.js';
import {
  ContainerMountIntegrityError,
  resolveActiveContainerMountSources,
  resolveContainerMountIntegrity,
  type ResolvedContainerMount as ResolvedMount,
} from './container-mount-integrity.js';
import { safeEpochToIso } from '../common/safe-date.js';

@Injectable()
export class ContainerControlService {
  /**
   * Console creation is a direct RPC while lifecycle changes are durable tasks.
   * Serialize both per container so an exec cannot be registered after an
   * action already closed sessions but before that action commits its intent.
   */
  private readonly activeContainerInteractions = new Set<string>();

  constructor(
    private dataSource: DataSource,
    private access: AccessResolverService,
    private actions: ContainerActionPolicyService,
    private containerTasks: ContainerTaskService,
    private resourceKeys: ResourceKeyService,
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
    @InjectRepository(ContainerDesiredSpecEntity)
    private desiredRepo: Repository<ContainerDesiredSpecEntity>,
    @InjectRepository(ContainerLifecycleEntity)
    private lifecycleRepo: Repository<ContainerLifecycleEntity>,
    @InjectRepository(AgentTaskEntity)
    private tasksRepo: Repository<AgentTaskEntity>,
    @InjectRepository(ImageEntity)
    private imagesRepo: Repository<ImageEntity>,
    @InjectRepository(ServerEntity)
    private serversRepo: Repository<ServerEntity>,
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    @InjectRepository(GpuAllocationEntity)
    private gpuAllocationsRepo: Repository<GpuAllocationEntity>,
    @InjectRepository(DataDirectoryEntity)
    private dataDirsRepo: Repository<DataDirectoryEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private remoteFsAssignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    private agentGateway: AgentGateway,
    private execSessionRegistry: ExecSessionRegistry,
    private execSessionAuthorization: ExecSessionAuthorizationService,
    private sshRoutes: ContainerSshRouteService,
    private sshIdentities: SshIdentityService,
    private sshProxySnapshots: SshProxySnapshotService,
    private auditService: AuditService,
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
    if (!container) throw new NotFoundException('Container not found');
    await this.assertCanRead(userId, container);
    return (await this.viewsFor([container]))[0];
  }

  async getForAdmin(containerId: string, _actorId: string): Promise<ContainerView> {
    const container = await this.containersRepo.findOneBy({ id: containerId });
    if (!container) throw new NotFoundException('Container not found');
    return (await this.viewsFor([container]))[0];
  }

  async create(userId: string, request: CreateContainerRequest): Promise<AgentTaskRefResponse> {
    const containerId = uuidv4();
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
    if (!user?.numericId) throw new ForbiddenException('User numeric ID is required for container runtime tasks');
    if (!server) throw new NotFoundException('Server not found');
    this.assertRuntimeReady(request.serverId);
    const dockerRoot = this.agentGateway.stateCache.requireRuntimeReady(request.serverId).dockerRoot;
    if (!dockerRoot) throw new ConflictException('Agent Docker root is not available');
    const imageDockerId = this.agentGateway.stateCache.resolveImageDockerId(
      request.serverId,
      image.dockerImage,
    );
    if (!imageDockerId) {
      throw new ConflictException('Image is not present on the target server; complete a Pull task first');
    }

    const effectiveGrant = grant;
    for (const dir of request.dataDirs ?? []) {
      if (!await this.access.hasMountSourceAccess(userId, request.serverId, dir.sourceKind, dir.sourceId)) {
        throw new ForbiddenException('Mount source access denied');
      }
    }
    const normalizedMounts = this.normalizeMounts(request.dataDirs ?? []);
    const resolvedMounts = await this.resolveMounts(request.serverId, userId, normalizedMounts);
    const agentMounts = this.agentMountSpecs(resolvedMounts);
    const runtimeOverrides = image.runtimeOverrides;
    // This optimistic read is only a race detector. The immutable task payload
    // is built from a second read inside the same serialized transaction that
    // enqueues the task.
    const expectedSshKey = image.disableSsh
      ? null
      : await this.sshIdentities.getUserInternalPublicKey(userId);

    const task = await runSerializedTransaction(this.dataSource, async (manager) => {
      const freshAccess = await this.access.resolveContainerCreateAccessInTransaction(
        manager,
        userId,
        request.serverId,
        request.imageId,
        resolvedMounts.map((mount) => ({
          kind: mount.sourceKind,
          id: mount.sourceId,
          sourceIdentity: mount.sourceIdentity,
        })),
      );
      if (!freshAccess) throw new ForbiddenException('Server or image access was revoked');
      if (!freshAccess.mountSourcesAllowed) throw new ForbiddenException('Mount source access was revoked');
      if (JSON.stringify(freshAccess.grant) !== JSON.stringify(effectiveGrant)) {
        throw new ConflictException('Resource grant changed while creating the container; retry with the latest grant');
      }
      const [freshImage, freshUser, freshServer, duplicateName] = await Promise.all([
        manager.findOneBy(ImageEntity, { id: request.imageId }),
        manager.findOneBy(UserEntity, { id: userId }),
        manager.findOneBy(ServerEntity, { id: request.serverId }),
        manager.findOne(ContainerEntity, {
          where: { ownerId: userId, serverId: request.serverId, name: request.name },
        }),
      ]);
      if (!freshImage?.isActive) throw new ForbiddenException('Image is missing or inactive');
      if (
        freshImage.dockerImage !== image.dockerImage
        || freshImage.disableSsh !== image.disableSsh
        || JSON.stringify(freshImage.runtimeOverrides) !== JSON.stringify(image.runtimeOverrides)
      ) {
        throw new ConflictException('Image definition changed while creating the container; retry');
      }
      if (!freshUser?.numericId || freshUser.status !== UserStatus.Active) {
        throw new ForbiddenException('User is disabled or has no numeric runtime identity');
      }
      if (!freshServer) throw new NotFoundException('Server not found');
      if (!freshServer.macvlanCidr || !freshServer.macvlanGateway) {
        throw new ConflictException('Agent network identity has not been durably bound yet');
      }
      if (freshServer.status !== ServerStatus.Online) {
        throw new ConflictException('Target Agent no longer has a current authoritative inventory');
      }
      if (await networkHasUntrustedInventory(manager, freshServer.macvlanCidr)) {
        throw new ConflictException({
          code: 'NETWORK_INVENTORY_UNTRUSTED',
          message: 'A Server on the shared macvlan has no trusted authoritative inventory',
        });
      }
      const managedContainerCount = await manager.count(ContainerEntity, {
        where: { serverId: request.serverId },
      });
      if (managedContainerCount >= MAX_MANAGED_CONTAINERS_PER_AGENT) {
        throw new ConflictException({
          code: 'SERVER_CONTAINER_CAPACITY_REACHED',
          message: `Server already owns ${MAX_MANAGED_CONTAINERS_PER_AGENT} managed containers`,
        });
      }
      if (duplicateName) throw new ConflictException('Container name is already in use on this server');
      await this.assertMountSnapshotsStillActive(manager, request.serverId, userId, resolvedMounts);

      const freshSshKey = freshImage.disableSsh
        ? null
        : await this.sshIdentities.getUserInternalPublicKeyInTransaction(manager, userId);
      if (
        expectedSshKey?.generation !== freshSshKey?.generation
        || expectedSshKey?.publicKey !== freshSshKey?.publicKey
        || expectedSshKey?.fingerprint !== freshSshKey?.fingerprint
      ) {
        throw new ConflictException('Internal SSH key rotated while creating the container; retry');
      }
      const ssh = freshSshKey
        ? {
          enabled: true as const,
          internalPublicKey: freshSshKey.publicKey,
          internalKeyGeneration: freshSshKey.generation,
        }
        : { enabled: false as const };

      const quotaDesired = await manager.findOne(QuotaDesiredEntity, {
        where: { serverId: request.serverId, userId },
      });
      if (
        !quotaDesired
        || quotaDesired.numericUserId !== freshUser.numericId
        || quotaDesired.limitBytes !== freshAccess.grant.diskBytes
      ) {
        throw new ConflictException({
          code: 'QUOTA_DESIRED_NOT_READY',
          message: 'Current grant quota has not reached a durable desired generation yet',
        });
      }

      const now = new Date();
      await gcExpiredNetworkClaims(manager);
      const claims = await manager.find(NetworkAddressClaimEntity, {
        where: { networkKey: freshServer.macvlanCidr },
        select: { address: true },
      });
      const observedRuntimeIps = this.agentGateway.stateCache.getAll().flatMap((snapshot) =>
        [...snapshot.containers.values()].map((container) => container.runtime.ip));
      const assignedIp = allocateNextIp(
        freshServer.macvlanCidr,
        new Set([
          ...claims.map((claim) => claim.address),
          ...observedRuntimeIps,
        ]),
      );
      if (!assignedIp) {
        throw new ConflictException('No durable macvlan address is available on this server');
      }
      await assertNetworkClaimCapacity(manager, 1);
      await manager.save(NetworkAddressClaimEntity, manager.create(NetworkAddressClaimEntity, {
        id: uuidv4(),
        address: assignedIp,
        ownerKind: 'container',
        ownerId: containerId,
        serverId: request.serverId,
        networkKey: freshServer.macvlanCidr,
        state: 'active',
        reusableAt: null,
      }));
      const requestedCpu = effectiveGrant.cpuMillis ?? 0;
      const requestedMem = effectiveGrant.memBytes ?? 0;
      const requestedDisk = quotaDesired.limitBytes;
      const gpuLoad = await this.gpuLoadMap(request.serverId, manager);
      const knownGpuIndices = await this.knownGpuIndices(
        request.serverId,
        [...gpuLoad.keys()],
        manager,
      );
      const gpuIndices = resolveGpuIndices(
        effectiveGrant,
        knownGpuIndices,
      );

      return this.containerTasks.createContainerTask(manager, {
        containerId,
        serverId: request.serverId,
        requestedBy: userId,
        kind: AgentTaskKind.ContainerCreate,
        request: {
          ...request,
          ownerId: userId,
          createdBy: userId,
          imageDockerRef: image.dockerImage,
          imageDefaultUid: runtimeOverrides.uid,
          runtimeOverrides,
          cpuMillis: requestedCpu,
          memBytes: requestedMem,
          diskBytes: requestedDisk,
          gpuIndices,
          dataDirs: normalizedMounts,
          assignedIp,
        },
        payload: {
          containerId,
          specGeneration: 1,
          quotaGeneration: quotaDesired.generation,
          dockerRoot,
          ownerId: userId,
          numericOwnerId: freshUser.numericId,
          imageDockerRef: image.dockerImage,
          imageDockerId,
          imageId: image.id,
          assignedIp,
          runtimeOverrides,
          name: request.name,
          cpuMillis: requestedCpu,
          memBytes: requestedMem,
          diskBytes: requestedDisk,
          gpuIndices,
          mounts: agentMounts,
          ssh,
        },
        phase: ContainerPhase.Provisioning,
        resourceKeys: this.containerTaskResourceKeys(
          request.serverId,
          userId,
          containerId,
          normalizedMounts,
          true,
        ),
        beforeSave: async (taskManager) => {
          const container = taskManager.create(ContainerEntity, {
            id: containerId,
            serverId: request.serverId,
            ownerId: userId,
            name: request.name,
            imageId: image.id,
            createdBy: userId,
          });
          await taskManager.save(ContainerEntity, container);
          await taskManager.save(ContainerDesiredSpecEntity, taskManager.create(ContainerDesiredSpecEntity, {
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
          await taskManager.save(ContainerLifecycleEntity, taskManager.create(ContainerLifecycleEntity, {
            containerId,
            phase: ContainerPhase.Provisioning,
            boundRuntimeId: null,
            quotaPathsJson: [],
            runtimeSpecHash: null,
            activeTaskId: null,
            lastTransitionAt: now,
            failureReason: null,
            failureCode: null,
          }));
          if (gpuIndices.length > 0) {
            await taskManager.save(GpuAllocationEntity, taskManager.create(GpuAllocationEntity, {
              containerId,
              serverId: request.serverId,
              gpuIndicesJson: gpuIndices,
              allocatedAt: now,
            }));
          }
          await this.saveMountRows(taskManager, container, userId, resolvedMounts);
        },
      });
    });
    await postCommitBestEffort(
      'Container create audit',
      () => this.auditService.log(userId, AuditAction.CreateContainer, containerId, 'container', {
        serverId: request.serverId,
        imageId: request.imageId,
        name: request.name,
        taskId: task.taskId,
      }),
    );
    return task;
  }

  private async assertMountSnapshotsStillActive(
    manager: EntityManager,
    serverId: string,
    userId: string,
    mounts: readonly ResolvedMount[],
  ): Promise<void> {
    let fresh: ResolvedMount[];
    try {
      fresh = await resolveActiveContainerMountSources(
        manager,
        { serverId, ownerId: userId },
        mounts,
      );
    } catch (error) {
      if (error instanceof ContainerMountIntegrityError) {
        throw this.mountIntegrityConflict(error);
      }
      throw error;
    }
    if (fresh.some((mount, index) =>
      mount.resourceId !== mounts[index]?.resourceId
      || mount.sourceIdentity !== mounts[index]?.sourceIdentity)) {
      throw new ConflictException({
        code: 'CONTAINER_MOUNT_SOURCE_UNAVAILABLE',
        message: 'A container mount source changed while preparing the action; retry',
      });
    }
  }

  async action(containerId: string, action: ContainerAction, userId: string, body?: unknown): Promise<AgentTaskRefResponse> {
    const container = await this.containersRepo.findOneBy({ id: containerId });
    if (!container) throw new NotFoundException('Container not found');
    await this.assertCanWrite(userId, container);
    return this.actionOnContainer(container, action, userId, body, userId, true);
  }

  async actionForAdmin(containerId: string, action: ContainerAction, actorId: string, body?: unknown): Promise<AgentTaskRefResponse> {
    const container = await this.containersRepo.findOneBy({ id: containerId });
    if (!container) throw new NotFoundException('Container not found');
    return this.actionOnContainer(container, action, actorId, body, container.ownerId, false);
  }

  private async actionOnContainer(
    container: ContainerEntity,
    action: ContainerAction,
    requestedBy: string,
    body: unknown,
    accessUserId: string,
    requireOwnerAccess: boolean,
  ): Promise<AgentTaskRefResponse> {
    const task = await this.runContainerInteraction(container.id, () =>
      this.actionOnContainerLocked(
        container,
        action,
        requestedBy,
        body,
        accessUserId,
        requireOwnerAccess,
      ));
    await postCommitBestEffort(
      'Container action audit',
      () => this.auditService.log(
        requestedBy,
        this.auditActionForContainerAction(action),
        container.id,
        'container',
        { serverId: container.serverId, ownerId: container.ownerId, taskId: task.taskId },
      ),
    );
    return task;
  }

  private async actionOnContainerLocked(
    container: ContainerEntity,
    action: ContainerAction,
    requestedBy: string,
    body: unknown,
    accessUserId: string,
    requireOwnerAccess: boolean,
  ): Promise<AgentTaskRefResponse> {
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
    if (action === 'reconcileSsh') {
      return this.reconcileSsh(
        container,
        lifecycle,
        requestedBy,
        requireOwnerAccess,
      );
    }
    const kind = this.taskKind(action);
    const phase = action === 'delete' ? ContainerPhase.Deleting : ContainerPhase.Updating;
    const isPowerEnsure = action === 'start' || action === 'restart';
    const numericOwnerId = isPowerEnsure
      ? await this.requireNumericUserId(container.ownerId)
      : null;
    const quotaDesired = isPowerEnsure
      ? await this.dataSource.getRepository(QuotaDesiredEntity).findOne({
          where: { serverId: container.serverId, userId: container.ownerId },
        })
      : null;
    if (
      isPowerEnsure
      && (
        !quotaDesired
        || quotaDesired.numericUserId !== numericOwnerId
      )
    ) {
      throw new ConflictException('Current durable quota generation is unavailable for this container owner');
    }
    const dockerRoot = isPowerEnsure
      ? this.agentGateway.stateCache.requireRuntimeReady(container.serverId).dockerRoot
      : null;
    if (isPowerEnsure && lifecycle.quotaPathsJson.length !== 2) {
      throw new ConflictException('Container writable-layer quota recovery metadata is incomplete');
    }
    if (
      action === 'delete'
      && lifecycle.boundRuntimeId
      && (lifecycle.quotaPathsJson.length !== 2 || !lifecycle.runtimeSpecHash)
    ) {
      throw new ConflictException('Container deletion requires complete immutable runtime cleanup evidence');
    }
    if (
      action === 'delete'
      && !lifecycle.boundRuntimeId
      && (lifecycle.quotaPathsJson.length !== 0 || lifecycle.runtimeSpecHash !== null)
    ) {
      throw new ConflictException('Unbound container has ambiguous runtime cleanup evidence');
    }
    const expectedPowerSsh = isPowerEnsure
      ? await this.containerSshPayload(container)
      : null;
    const powerEnsure = isPowerEnsure
      ? {
        dockerRoot,
        quotaGeneration: quotaDesired!.generation,
        numericOwnerId: numericOwnerId!,
        diskBytes: quotaDesired!.limitBytes,
        quotaPaths: lifecycle.quotaPathsJson,
      }
      : {};
    const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    let runtimeObservation = null;
    if (action === 'restart' && lifecycle.boundRuntimeId) {
      const startInspect = () => this.agentGateway.rpc(
        container.serverId,
        'inspectContainer',
        { containerId: container.id, runtimeId: lifecycle.boundRuntimeId },
      );
      const started = requireOwnerAccess
        ? await this.access.startExternalWithActiveServerAccess(
          requestedBy,
          container.serverId,
          startInspect,
        )
        : await this.access.startExternalWithActorCapabilities(
          requestedBy,
          [Capability.ManageContainersAny],
          startInspect,
        );
      runtimeObservation = zInspectContainerResult.parse(await started.completion);
    }
    if (runtimeObservation && runtimeObservation.runtimeId !== lifecycle.boundRuntimeId) {
      throw new ConflictException('Agent returned an unexpected container runtime identity');
    }
    if (action === 'restart' && !runtimeObservation) {
      throw new ConflictException('A fresh runtime baseline is required before restart');
    }
    const actionSpecificPayload = action === 'restart'
      ? { baselineStartedAt: runtimeObservation?.startedAt }
      : action === 'delete'
        ? {
          serverId: container.serverId,
          specGeneration: lifecycle.boundRuntimeId ? String(desired.generation) : null,
          runtimeSpecHash: lifecycle.boundRuntimeId ? lifecycle.runtimeSpecHash : null,
          numericOwnerId: await this.requireNumericUserId(container.ownerId),
          quotaPaths: lifecycle.quotaPathsJson,
        }
        : {};
    const actionPayload = {
      containerId: container.id,
      runtimeId: lifecycle.boundRuntimeId,
      timeoutSeconds: typeof bodyRecord.timeoutSeconds === 'number'
        ? bodyRecord.timeoutSeconds
        : undefined,
      ...powerEnsure,
      ...actionSpecificPayload,
    };
    return this.enqueueLifecycleTaskThenRevokeConsoles(
      lifecycle.boundRuntimeId,
      () => this.containerTasks.enqueueExistingContainerAction({
      containerId: container.id,
      requestedBy,
      kind,
      request: body ?? { action },
      payload: actionPayload,
      prepareInTransaction: isPowerEnsure
        ? async (manager) => {
          const freshDesiredForMounts = await manager.findOne(
            ContainerDesiredSpecEntity,
            { where: { containerId: container.id } },
          );
          if (
            !freshDesiredForMounts
            || freshDesiredForMounts.generation !== desired.generation
          ) {
            throw new ConflictException('Container desired state changed while preparing the action; retry');
          }
          const resolvedMounts = await this.resolveMountIntegrityForAction(
            manager,
            container,
            freshDesiredForMounts,
          );
          const freshSsh = await this.containerSshPayloadInTransaction(manager, container);
          if (!this.sameSshPayload(expectedPowerSsh!, freshSsh)) {
            throw new ConflictException('Internal SSH key or image SSH policy changed while preparing the action; retry');
          }
          return {
            payload: {
              ...actionPayload,
              mounts: this.agentMountSpecs(resolvedMounts),
              ssh: freshSsh,
            },
            resourceKeys: this.containerTaskResourceKeys(
              container.serverId,
              container.ownerId,
              container.id,
              resolvedMounts,
              true,
            ),
          };
        }
        : undefined,
      phase,
      resourceKeys: isPowerEnsure
        ? undefined
        : this.containerTaskResourceKeys(
          container.serverId,
          container.ownerId,
          container.id,
          [],
          action === 'delete',
        ),
      beforeSave: async (manager) => {
        if (!requireOwnerAccess) {
          await this.access.assertActorCapabilitiesInTransaction(
            manager, requestedBy, [Capability.ManageContainersAny],
          );
        }
        const [freshContainer, freshDesired, freshLifecycle, freshQuota, freshActor, freshAccess] = await Promise.all([
          manager.findOneBy(ContainerEntity, { id: container.id }),
          manager.findOne(ContainerDesiredSpecEntity, { where: { containerId: container.id } }),
          manager.findOne(ContainerLifecycleEntity, { where: { containerId: container.id } }),
          quotaDesired
            ? manager.findOne(QuotaDesiredEntity, {
                where: { serverId: container.serverId, userId: container.ownerId },
              })
            : Promise.resolve(null),
          requireOwnerAccess
            ? manager.findOneBy(UserEntity, { id: requestedBy })
            : Promise.resolve(null),
          requireOwnerAccess
            ? this.access.resolveServerInTransaction(manager, requestedBy, container.serverId)
            : Promise.resolve(null),
        ]);
        if (
          !freshContainer
          || !freshDesired
          || !freshLifecycle
          || freshContainer.serverId !== container.serverId
          || freshContainer.ownerId !== container.ownerId
          || freshDesired.generation !== desired.generation
          || freshLifecycle.phase !== lifecycle.phase
          || freshLifecycle.boundRuntimeId !== lifecycle.boundRuntimeId
          || freshLifecycle.activeTaskId !== lifecycle.activeTaskId
          || freshLifecycle.lastTransitionAt.getTime() !== lifecycle.lastTransitionAt.getTime()
        ) {
          throw new ConflictException('Container state changed while preparing the action; retry');
        }
        if (
          requireOwnerAccess
          && (
            freshActor?.status !== UserStatus.Active
            || freshActor.id !== container.ownerId
            || !freshAccess
          )
        ) {
          throw new ForbiddenException('Container owner is disabled or server access was revoked');
        }
        if (
          quotaDesired
          && (
            !freshQuota
            || freshQuota.generation !== quotaDesired.generation
            || freshQuota.numericUserId !== quotaDesired.numericUserId
            || freshQuota.limitBytes !== quotaDesired.limitBytes
          )
        ) {
          throw new ConflictException('Quota generation changed while preparing the container action; retry');
        }
      },
      }),
    );
  }

  /**
   * A console close may use an exact-container stop as its fail-closed exec
   * barrier. Therefore browser revocation is allowed only after the lifecycle
   * task transaction committed. We then revoke browser and Agent ownership
   * immediately; the Agent task-entry runtime fence is the ordering/loss
   * backstop if task dispatch races or overtakes this one-way close.
   */
  private async enqueueLifecycleTaskThenRevokeConsoles(
    runtimeId: string | null,
    enqueue: () => Promise<AgentTaskRefResponse>,
  ): Promise<AgentTaskRefResponse> {
    const task = await enqueue();
    if (runtimeId) this.execSessionRegistry.closeByRuntime(runtimeId, true);
    return task;
  }

  async createExecSession(
    containerId: string,
    userId: string,
    authVersion: number,
    request: ExecSessionRequest,
  ): Promise<{ sessionId: string }> {
    const container = await this.containersRepo.findOneBy({ id: containerId });
    if (!container) throw new NotFoundException('Container not found');
    await this.assertCanRead(userId, container);
    return this.createExecSessionForContainer(
      container,
      userId,
      authVersion,
      request,
      'container-owner',
    );
  }

  async createExecSessionForAdmin(
    containerId: string,
    actorId: string,
    authVersion: number,
    request: ExecSessionRequest,
  ): Promise<{ sessionId: string }> {
    const container = await this.containersRepo.findOneBy({ id: containerId });
    if (!container) throw new NotFoundException('Container not found');
    return this.createExecSessionForContainer(
      container,
      actorId,
      authVersion,
      request,
      'manage-containers-any',
    );
  }

  private async createExecSessionForContainer(
    container: ContainerEntity,
    actorId: string,
    authVersion: number,
    request: ExecSessionRequest,
    authorizationKind: 'container-owner' | 'manage-containers-any',
  ): Promise<{ sessionId: string }> {
    const session = await this.runContainerInteraction(container.id, () =>
      this.createExecSessionForContainerLocked(
        container,
        actorId,
        authVersion,
        request,
        authorizationKind,
      ));
    await postCommitBestEffort(
      'Container exec audit',
      () => this.auditService.log(actorId, AuditAction.ExecContainer, container.id, 'container', {
        serverId: container.serverId,
        ownerId: container.ownerId,
        sessionId: session.sessionId,
        tty: request.tty !== false,
      }),
    );
    return session;
  }

  private async createExecSessionForContainerLocked(
    container: ContainerEntity,
    actorId: string,
    authVersion: number,
    request: ExecSessionRequest,
    authorizationKind: 'container-owner' | 'manage-containers-any',
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
    const sessionAuthority = {
      serverId: container.serverId,
      userId: actorId,
      containerId: container.id,
      dockerId: runtimeId,
      authorizationKind,
      createdAt: Date.now(),
      claimed: false,
    };
    let started = false;
    let admission: { result: Promise<unknown> } | null;
    try {
      const shell = request.shell?.trim() || '/bin/sh';
      admission = await this.execSessionAuthorization.startAuthorized(
        sessionAuthority,
        authVersion,
        () => {
          started = true;
          this.execSessionRegistry.register(sessionId, sessionAuthority);
          return this.agentGateway.rpc(container.serverId, 'execStream', {
            sessionId,
            runtimeId,
            cmd: [shell],
            tty: request.tty !== false,
            cols: request.cols,
            rows: request.rows,
          });
        },
      );
      if (!admission) {
        throw new ForbiddenException('Console authorization was revoked before session admission');
      }
      await admission.result;
      return { sessionId };
    } catch (error) {
      if (started) {
        try {
          this.agentGateway.notify(container.serverId, 'execClose', { sessionId });
        } catch {
          // Agent disconnect is already a complete process-local exec teardown.
        }
        this.execSessionRegistry.remove(sessionId);
      }
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
      const observedAt = this.agentGateway.stateCache.get(view.serverId)?.lastUpdated ?? Date.now();
      const lastObservedAt = safeEpochToIso(observedAt);
      return {
        containerId: view.id,
        stats: null,
        ts: lastObservedAt ? observedAt : Date.now(),
        ...(lastObservedAt ? { lastObservedAt } : {}),
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
    const omittedLoginIds = await this.omittedServerLoginContainerIds(containers);
    return Promise.all(containers.map((c) => this.toView(
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
    const activeTask = await this.activeTaskForContainer(c.id, lifecycle);
    const phase = lifecycle?.phase ?? ContainerPhase.Failed;
    const runtimeReady = this.agentGateway.stateCache.isRuntimeReady(c.serverId);
    const serverSnap = this.agentGateway.stateCache.get(c.serverId);
    const snapshot = runtimeReady && lifecycle?.boundRuntimeId
      ? this.agentGateway.stateCache.getContainer(c.serverId, lifecycle.boundRuntimeId)
      : undefined;
    const runtimeId = lifecycle?.boundRuntimeId ?? snapshot?.runtime.runtimeId ?? null;
    const runtimeStatus = snapshot?.status ?? ContainerStatus.Unknown;
    const runtimeIp = this.nonEmptyString(snapshot?.runtime.ip) ?? null;
    const viewMounts = this.safeNormalizedMountsFromDesired(desired);
    const drift = this.runtimeDrift(desired, lifecycle, snapshot, runtimeReady);
    if (desired && viewMounts === null) {
      drift.push({
        kind: RuntimeDriftKind.DesiredMountSpecInvalid,
        message: 'Durable container mount configuration is invalid',
      });
    }
    const server = servers.get(c.serverId);
    const image = images.get(c.imageId);
    const owner = users.get(c.ownerId);
    const safeFailure = requesterSafeContainerFailure(
      lifecycle?.failureCode,
      lifecycle?.failureReason,
    );
    return {
      id: c.id,
      serverId: c.serverId,
      serverName: server?.name ?? c.serverId,
      ownerId: c.ownerId,
      ownerName: owner?.username,
      name: c.name,
      imageId: c.imageId,
      imageName: image?.name,
      failureCode: safeFailure.failureCode,
      failureReason: safeFailure.failureReason,
      powerIntent: desired?.powerIntent ?? ContainerPowerIntent.Stopped,
      runtimeReady,
      runtime: {
        bound: Boolean(lifecycle?.boundRuntimeId || snapshot),
        runtimeId,
        status: runtimeStatus,
        ip: runtimeIp,
        observedAt: snapshot ? safeEpochToIso(serverSnap?.lastUpdated ?? Date.now()) : null,
        drift,
      },
      activeTask: activeTask ? toUserAgentTaskDto(activeTask) : null,
      resources: {
        cpuMillis: desired?.cpuMillis ?? 0,
        memBytes: desired?.memBytes ?? 0,
        diskBytes: desired?.diskBytes ?? 0,
        gpuIndices: desired?.gpuIndices ?? [],
      },
      ssh: this.sshView(c, owner, server, image, snapshot, sshRoute, omittedServerLoginAllowed),
      mounts: this.mountViews(viewMounts ?? []),
      actions: this.actions.forContainer({
        phase,
        runtimeReady,
        runtimeStatus,
        runtimeDrift: drift,
        activeTaskId: activeTask?.id ?? null,
        sshEnabled: image?.disableSsh !== true,
      }),
    };
  }

  private async activeTaskForContainer(
    containerId: string,
    lifecycle: ContainerLifecycleEntity | null,
  ): Promise<AgentTaskEntity | null> {
    if (lifecycle?.activeTaskId) {
      const task = await this.tasksRepo.findOneBy({ id: lifecycle.activeTaskId });
      if (task?.status === AgentTaskStatus.Pending) return task;
    }
    return this.tasksRepo.findOne({
      where: {
        resourceType: 'container',
        resourceId: containerId,
        status: AgentTaskStatus.Pending,
      },
      order: { createdAt: 'ASC' },
    });
  }

  private nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private mountViews(mounts: readonly NormalizedMount[]): ContainerView['mounts'] {
    return mounts.map((mount, index) => ({
      id: mount.id ?? `${mount.sourceKind}:${mount.sourceId}:${mount.dirName}:${index}`,
      sourceKind: mount.sourceKind,
      sourceId: mount.sourceId,
      dirName: mount.dirName,
      containerPath: mount.containerPath,
    }));
  }

  private normalizedMountsFromDesired(desired: ContainerDesiredSpecEntity | null): NormalizedMount[] {
    if (!desired) return [];
    try {
      return normalizeContainerMounts(desired.mountsJson);
    } catch {
      throw new ConflictException({
        code: 'CONTAINER_MOUNT_SPEC_INVALID',
        message: 'Durable container mount configuration is invalid',
      });
    }
  }

  private safeNormalizedMountsFromDesired(
    desired: ContainerDesiredSpecEntity | null,
  ): NormalizedMount[] | null {
    try {
      return this.normalizedMountsFromDesired(desired);
    } catch {
      return null;
    }
  }

  private normalizeMounts(input: MountInput[]): NormalizedMount[] {
    return normalizeContainerMounts(input);
  }

  private async resolveMountIntegrityForAction(
    manager: EntityManager,
    container: ContainerEntity,
    desired: ContainerDesiredSpecEntity,
  ): Promise<ResolvedMount[]> {
    let resolved: ResolvedMount[];
    try {
      resolved = await resolveContainerMountIntegrity(manager, container, desired);
    } catch (error) {
      if (!(error instanceof ContainerMountIntegrityError)) throw error;
      throw this.mountIntegrityConflict(error);
    }

    const disks = this.agentGateway.stateCache.get(container.serverId)?.disks ?? [];
    for (const mount of resolved) {
      if (mount.sourceKind !== 'local') continue;
      const exact = disks.filter((disk) => disk.diskId === mount.sourceId);
      if (
        exact.length !== 1
        || exact[0]!.sourceIdentity !== mount.sourceIdentity
      ) {
        throw new ConflictException({
          code: 'CONTAINER_MOUNT_SOURCE_UNAVAILABLE',
          message: 'A local container mount source is not present with its exact physical identity',
        });
      }
    }
    return resolved;
  }

  private mountIntegrityConflict(error: ContainerMountIntegrityError): ConflictException {
    const code = error.kind === 'desired_invalid'
      ? 'CONTAINER_MOUNT_SPEC_INVALID'
      : error.kind === 'index_divergent'
        ? 'CONTAINER_MOUNT_INDEX_DIVERGENT'
        : 'CONTAINER_MOUNT_SOURCE_UNAVAILABLE';
    return new ConflictException({
      code,
      message: error.kind === 'desired_invalid'
        ? 'Durable container mount configuration is invalid'
        : error.kind === 'index_divergent'
          ? 'Durable container mount configuration is internally inconsistent'
          : 'A durable container mount source is no longer active with its exact identity',
    });
  }

  private agentMountSpecs(mounts: readonly ResolvedMount[]): ContainerMountSpec[] {
    return mounts.map((mount) => ({
        sourceId: mount.sourceId,
        resourceId: mount.resourceId,
        sourceIdentity: mount.sourceIdentity,
        containerPath: mount.containerPath,
      }));
  }

  private async reconcileSsh(
    container: ContainerEntity,
    lifecycle: ContainerLifecycleEntity,
    requestedBy: string,
    requireOwnerAccess: boolean,
  ): Promise<AgentTaskRefResponse> {
    if (!lifecycle.boundRuntimeId) throw new ForbiddenException('Runtime is not bound yet');
    const expectedSsh = await this.containerSshPayload(container);
    return this.containerTasks.enqueueExistingContainerAction({
      containerId: container.id,
      requestedBy,
      kind: AgentTaskKind.ContainerSshEnsure,
      request: { action: 'reconcileSsh' },
      payload: {
        containerId: container.id,
        runtimeId: lifecycle.boundRuntimeId,
        ...expectedSsh,
      },
      payloadInTransaction: async (manager) => {
        const freshSsh = await this.containerSshPayloadInTransaction(manager, container);
        if (!this.sameSshPayload(expectedSsh, freshSsh)) {
          throw new ConflictException('Internal SSH key or image SSH policy changed while preparing SSH reconciliation; retry');
        }
        return {
          containerId: container.id,
          runtimeId: lifecycle.boundRuntimeId,
          ...freshSsh,
        };
      },
      phase: ContainerPhase.Updating,
      beforeSave: async (manager) => {
        if (requireOwnerAccess) {
          const [actor, access] = await Promise.all([
            manager.findOneBy(UserEntity, { id: requestedBy }),
            this.access.resolveServerInTransaction(manager, requestedBy, container.serverId),
          ]);
          if (
            actor?.status !== UserStatus.Active
            || container.ownerId !== requestedBy
            || !access
          ) {
            throw new ForbiddenException(
              'Container owner is disabled or server access was revoked',
            );
          }
        } else {
          await this.access.assertActorCapabilitiesInTransaction(
            manager, requestedBy, [Capability.ManageContainersAny],
          );
        }
        const [current, freshContainer] = await Promise.all([
          manager.findOneBy(ContainerLifecycleEntity, { containerId: container.id }),
          manager.findOneBy(ContainerEntity, { id: container.id }),
        ]);
        if (
          !current
          || !freshContainer
          || freshContainer.serverId !== container.serverId
          || freshContainer.ownerId !== container.ownerId
          || current.phase !== lifecycle.phase
          || current.activeTaskId !== lifecycle.activeTaskId
          || current.boundRuntimeId !== lifecycle.boundRuntimeId
          || current.lastTransitionAt.getTime() !== lifecycle.lastTransitionAt.getTime()
        ) {
          throw new ConflictException('Container state changed while preparing SSH reconciliation; retry');
        }
      },
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
        ...await this.resolveMountIdentity(serverId, userId, mount),
      });
    }
    return result;
  }

  private async resolveMountIdentity(
    serverId: string,
    userId: string,
    mount: NormalizedMount,
  ): Promise<{ resourceId: string; sourceIdentity: string }> {
    const dataDir = await this.dataDirsRepo.findOneBy({
      sourceKind: mount.sourceKind,
      sourceId: mount.sourceId,
      name: mount.dirName,
      userId,
      desiredState: 'active',
      ...(mount.sourceKind === 'local' ? { serverId } : {}),
    });
    if (!dataDir) throw new NotFoundException('Data directory not found');

    if (mount.sourceKind === 'local') {
      const disk = this.agentGateway.stateCache.get(serverId)?.disks.find((d) => d.diskId === mount.sourceId);
      if (!disk) throw new NotFoundException('Data disk not found');
      if (disk.sourceIdentity !== dataDir.sourceIdentity) {
        throw new ConflictException('Data disk identity changed after DataDir creation');
      }
      return { resourceId: dataDir.id, sourceIdentity: dataDir.sourceIdentity };
    }
    const assignment = await this.remoteFsAssignmentsRepo.findOneBy({
      remoteFsMountId: mount.sourceId,
      serverId,
      desiredState: 'active',
    });
    if (!assignment) throw new NotFoundException('Remote FS mount not assigned to server');
    const remote = await this.remoteFsRepo.findOneBy({ id: mount.sourceId, desiredState: 'active' });
    if (!remote) throw new NotFoundException('Remote FS mount not found');
    if (remoteFsSourceIdentity(remote.params) !== dataDir.sourceIdentity) {
      throw new ConflictException('Remote filesystem identity changed after DataDir creation');
    }
    return { resourceId: dataDir.id, sourceIdentity: dataDir.sourceIdentity };
  }

  private async saveMountRows(
    manager: EntityManager,
    container: ContainerEntity,
    userId: string,
    mounts: ResolvedMount[],
    _taskId?: string,
  ): Promise<void> {
    await manager.delete('container_mounts', { containerId: container.id });
    if (mounts.length === 0) return;
    await manager.insert('container_mounts', mounts.map((mount) => ({
      id: uuidv4(),
      serverId: container.serverId,
      containerId: container.id,
      containerName: container.name,
      sourceKind: mount.sourceKind,
      sourceId: mount.sourceId,
      sourceIdentity: mount.sourceIdentity,
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
      if (!lifecycle || !container || !shouldCountContainerForQuota(lifecycle.phase)) continue;
      for (const idx of row.gpuIndicesJson ?? []) load.set(idx, (load.get(idx) ?? 0) + 1);
    }
    return load;
  }

  private async knownGpuIndices(serverId: string, assigned: number[], manager?: EntityManager): Promise<number[]> {
    void manager;
    const fromInventory = this.agentGateway.stateCache.get(serverId)?.gpus.map((gpu) => gpu.index) ?? [];
    return [...new Set([...fromInventory, ...assigned])].sort((a, b) => a - b);
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
    if (
      lifecycle?.boundRuntimeId
      && snapshot?.runtime.runtimeId
      && lifecycle.boundRuntimeId !== snapshot.runtime.runtimeId
    ) {
      drift.push({
        kind: RuntimeDriftKind.RuntimeIdMismatch,
        desired: lifecycle.boundRuntimeId,
        observed: snapshot.runtime.runtimeId,
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
      const observedGeneration = this.numberOrNull(snapshot.labels?.[LABEL.SPEC_GENERATION]);
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
      lastError: requesterSafeSshError(route?.lastError ?? snapshot?.sshServer.lastError),
    };
  }

  private async omittedServerLoginContainerIds(containers: ContainerEntity[]): Promise<Set<string>> {
    if (containers.length === 0) return new Set();
    const ownerIds = [...new Set(containers.map((container) => container.ownerId))];
    const names = [...new Set(containers.map((container) => container.name))];
    const candidates = await this.containersRepo.find({
      where: {
        ownerId: In(ownerIds),
        name: In(names),
      },
    });
    const candidateIds = candidates.map((container) => container.id);
    const [routes, images] = await Promise.all([
      this.sshRoutes.findByContainerIds(candidateIds),
      this.imageMap([...new Set(candidates.map((container) => container.imageId))]),
    ]);
    const activeByOwnerName = new Map<string, ContainerEntity[]>();
    for (const candidate of candidates) {
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

  private async runContainerInteraction<T>(containerId: string, work: () => Promise<T>): Promise<T> {
    if (this.activeContainerInteractions.has(containerId)) {
      throw new ConflictException({
        code: 'CONTAINER_INTERACTION_BUSY',
        message: 'Another container interaction is already being prepared',
        containerId,
      });
    }
    this.activeContainerInteractions.add(containerId);
    try {
      return await work();
    } finally {
      this.activeContainerInteractions.delete(containerId);
    }
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

  private async requireNumericUserId(userId: string): Promise<number> {
    const user = await this.usersRepo.findOneBy({ id: userId });
    if (user?.numericId == null) {
      throw new ConflictException('User numeric ID is required for container runtime tasks');
    }
    return user.numericId;
  }

  private taskKind(action: ContainerAction): AgentTaskKind {
    switch (action) {
      case 'start': return AgentTaskKind.ContainerStart;
      case 'stop': return AgentTaskKind.ContainerStop;
      case 'restart': return AgentTaskKind.ContainerRestart;
      case 'delete': return AgentTaskKind.ContainerDelete;
      case 'updateMounts': throw new BadRequestException('Container mounts are immutable; delete and recreate the container');
      case 'reconcileSsh': return AgentTaskKind.ContainerSshEnsure;
      case 'stats':
      case 'console':
        throw new BadRequestException(`Container action ${action} is not a lifecycle task`);
    }
  }

  private auditActionForContainerAction(action: ContainerAction): AuditAction {
    switch (action) {
      case 'start': return AuditAction.StartContainer;
      case 'stop': return AuditAction.StopContainer;
      case 'restart': return AuditAction.RestartContainer;
      case 'delete': return AuditAction.DeleteContainer;
      case 'reconcileSsh': return AuditAction.ReconcileContainerSsh;
      case 'updateMounts':
        // Mount replacement is rejected before task admission, so this branch
        // cannot produce a successful action audit.
        throw new BadRequestException('Container mounts are immutable; delete and recreate the container');
      case 'stats':
      case 'console':
        throw new BadRequestException(`Container action ${action} has no lifecycle audit`);
    }
  }

  private async containerSshPayload(container: ContainerEntity): Promise<{
    enabled: boolean;
    internalPublicKey?: string;
    internalKeyGeneration?: number;
  }> {
    const image = await this.imagesRepo.findOneBy({ id: container.imageId });
    if (!image) throw new ConflictException('Container image definition is missing');
    if (image.disableSsh) return { enabled: false };
    const key = await this.sshIdentities.getUserInternalPublicKey(container.ownerId);
    return {
      enabled: true,
      internalPublicKey: key.publicKey,
      internalKeyGeneration: key.generation,
    };
  }

  private async containerSshPayloadInTransaction(
    manager: EntityManager,
    container: ContainerEntity,
  ): Promise<{
    enabled: boolean;
    internalPublicKey?: string;
    internalKeyGeneration?: number;
  }> {
    const image = await manager.findOneBy(ImageEntity, { id: container.imageId });
    if (!image) throw new ConflictException('Container image definition is missing');
    if (image.disableSsh) return { enabled: false };
    const key = await this.sshIdentities.getUserInternalPublicKeyInTransaction(
      manager,
      container.ownerId,
    );
    return {
      enabled: true,
      internalPublicKey: key.publicKey,
      internalKeyGeneration: key.generation,
    };
  }

  private sameSshPayload(
    left: { enabled: boolean; internalPublicKey?: string; internalKeyGeneration?: number },
    right: { enabled: boolean; internalPublicKey?: string; internalKeyGeneration?: number },
  ): boolean {
    return left.enabled === right.enabled
      && left.internalPublicKey === right.internalPublicKey
      && left.internalKeyGeneration === right.internalKeyGeneration;
  }

  private containerTaskResourceKeys(
    serverId: string,
    userId: string,
    containerId: string,
    mounts: NormalizedMount[],
    touchesQuota: boolean,
  ): string[] {
    const keys = [this.resourceKeys.container(containerId)];
    if (touchesQuota) keys.push(this.resourceKeys.quota(serverId, userId));
    for (const mount of mounts) {
      keys.push(this.resourceKeys.dataDir({
        serverId,
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
        name: mount.dirName,
      }));
      keys.push(this.resourceKeys.mountSource({
        serverId,
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
      }));
    }
    return [...new Set(keys)].sort();
  }
}
