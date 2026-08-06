import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentTaskKind,
  AuditAction,
  Capability,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  LABEL,
  RuntimeDriftKind,
  ServerStatus,
  UserStatus,
  allocateNextIp,
  MAX_MANAGED_CONTAINERS_PER_AGENT,
  remoteFsSourceIdentity,
  zInspectContainerResult,
  type AgentTaskRefResponse,
  type ContainerAction,
  type ContainerMountSpec,
  type ContainerSnapshot,
  type ContainerStatsResponse,
  type ContainerView,
  type CreateContainerRequest,
  type ExecSessionRequest,
  type ExecSessionResponse,
  type ImageRuntimeOverrides,
  type UserAgentTaskDto,
} from '@nyabase/common';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { AuditService } from '../audit/audit.service.js';
import { safeEpochToIso } from '../common/safe-date.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { ExecSessionAuthorizationService } from '../gateway/exec-session-authorization.service.js';
import { ExecSessionRegistry } from '../gateway/exec-session-registry.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { SshProxySnapshotService } from '../ssh/ssh-proxy-snapshot.service.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import {
  normalizeContainerMounts,
  type NormalizedContainerMount,
} from './container-mount-normalizer.js';
import {
  type ContainerAggregate,
  type ContainerExecutor,
  type ContainerMountRecord,
  type ContainerSshRouteRecord,
  ContainerControlRepository,
} from './container-control.repository.js';
import { ContainerTaskService } from './container-task.service.js';
import {
  requesterSafeContainerFailure,
  requesterSafeSshError,
} from './container-view-projection.js';
import { resolveGpuIndices } from './resource-quota.policy.js';

interface ResolvedMount extends NormalizedContainerMount {
  resourceId: string;
  sourceIdentity: string;
}

interface ServerProjection {
  id: string;
  name: string;
  slug: string;
  status: string;
  macvlanCidr: string | null;
  macvlanGateway: string | null;
}

interface ImageProjection {
  id: string;
  name: string;
  dockerImage: string;
  runtimeOverrides: ImageRuntimeOverrides;
  isActive: boolean;
  disableSsh: boolean;
  deleting: boolean;
}

interface UserProjection {
  id: string;
  numericId: number;
  username: string;
  status: string;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

@Injectable()
export class ContainerControlService {
  private readonly activeContainerInteractions = new Set<string>();

  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly repository: ContainerControlRepository,
    private readonly access: AccessResolverService,
    private readonly actions: ContainerActionPolicyService,
    private readonly containerTasks: ContainerTaskService,
    private readonly resourceKeys: ResourceKeyService,
    private readonly agentGateway: AgentGateway,
    private readonly execSessionRegistry: ExecSessionRegistry,
    private readonly execSessionAuthorization: ExecSessionAuthorizationService,
    private readonly sshProxySnapshots: SshProxySnapshotService,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
    private readonly auditService: AuditService,
    private readonly workflow: WorkflowRepository,
  ) {}

  async list(
    userId: string,
    filters: { serverId?: string } = {},
  ): Promise<ContainerView[]> {
    return this.viewsFor(await this.repository.list({
      ownerId: userId,
      serverId: filters.serverId,
    }));
  }

  async listForAdmin(
    filters: { serverId?: string } = {},
  ): Promise<ContainerView[]> {
    return this.viewsFor(await this.repository.list({ serverId: filters.serverId }));
  }

  async get(containerId: string, userId: string): Promise<ContainerView> {
    const container = await this.requireContainer(containerId);
    this.assertOwner(userId, container);
    return (await this.viewsFor([container]))[0]!;
  }

  async getForAdmin(containerId: string, _actorId: string): Promise<ContainerView> {
    return (await this.viewsFor([await this.requireContainer(containerId)]))[0]!;
  }

  async create(
    userId: string,
    request: CreateContainerRequest,
  ): Promise<AgentTaskRefResponse> {
    const containerId = uuidv4();
    const grant = await this.access.resolveServer(userId, request.serverId);
    if (!grant || grant.accessPhase !== 'full') {
      throw new ForbiddenException(
        grant?.accessPhase === 'grace'
          ? 'Server grant is in expiry grace; creating resources is not allowed'
          : 'No server access',
      );
    }
    if (!(await this.access.resolveAllowedImages(userId, request.serverId)).has(request.imageId)) {
      throw new ForbiddenException('No image access');
    }
    for (const mount of request.dataDirs ?? []) {
      if (!await this.access.hasMountSourceAccess(
        userId,
        request.serverId,
        mount.sourceKind,
        mount.sourceId,
      )) {
        throw new ForbiddenException('Mount source access denied');
      }
    }
    const [image, user, server] = await Promise.all([
      this.image(request.imageId),
      this.user(userId),
      this.server(request.serverId),
    ]);
    if (!image) throw new NotFoundException('Image not found');
    if (!image.isActive || image.deleting) throw new ForbiddenException('Image is inactive');
    if (!user?.numericId) {
      throw new ForbiddenException('User numeric ID is required for container runtime tasks');
    }
    if (!server) throw new NotFoundException('Server not found');
    this.assertRuntimeReady(server.id);
    const runtime = this.agentGateway.stateCache.requireRuntimeReady(server.id);
    if (!runtime.dockerRoot) throw new ConflictException('Agent Docker root is not available');
    const imageDockerId = this.agentGateway.stateCache.resolveImageDockerId(
      server.id,
      image.dockerImage,
    );
    if (!imageDockerId) {
      throw new ConflictException(
        'Image is not present on the target server; complete a Pull task first',
      );
    }
    const normalizedMounts = normalizeContainerMounts(request.dataDirs ?? []);
    const resolvedMounts = await this.resolveMounts(
      this.database,
      server.id,
      userId,
      normalizedMounts,
    );
    const expectedSsh = image.disableSsh
      ? null
      : await this.internalSshKey(this.database, userId);
    const observedRuntimeIps = this.agentGateway.stateCache.getAll().flatMap((snapshot) =>
      [...snapshot.containers.values()].map((container) => container.runtime.ip));

    const task = await this.transactions.run(async (transaction) => {
      await sql`select pg_advisory_xact_lock(
        1856214887,
        hashtext(${`container-server:${server.id}`})
      )`.execute(transaction);
      const freshAccess = await this.access.resolveContainerCreateAccessInTransaction(
        transaction,
        userId,
        server.id,
        image.id,
        resolvedMounts.map((mount) => ({
          kind: mount.sourceKind,
          id: mount.sourceId,
          sourceIdentity: mount.sourceIdentity,
        })),
      );
      if (!freshAccess) {
        throw new ForbiddenException('Server or image access was revoked');
      }
      if (!freshAccess.mountSourcesAllowed) {
        throw new ForbiddenException('Mount source access was revoked');
      }
      if (!sameJson(freshAccess.grant, grant)) {
        throw new ConflictException(
          'Resource grant changed while creating the container; retry with the latest grant',
        );
      }
      const [freshImage, freshUser, freshServer] = await Promise.all([
        this.image(image.id, transaction),
        this.user(userId, transaction),
        this.server(server.id, transaction),
      ]);
      if (!freshImage?.isActive || freshImage.deleting) {
        throw new ForbiddenException('Image is missing or inactive');
      }
      if (
        freshImage.dockerImage !== image.dockerImage
        || freshImage.disableSsh !== image.disableSsh
        || !sameJson(freshImage.runtimeOverrides, image.runtimeOverrides)
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
        throw new ConflictException(
          'Target Agent no longer has a current authoritative inventory',
        );
      }
      await sql`select pg_advisory_xact_lock(
        1856214887,
        hashtext(${`container-network:${freshServer.macvlanCidr}`})
      )`.execute(transaction);
      await this.assertNetworkInventoryTrusted(
        transaction,
        freshServer.macvlanCidr,
      );
      if (await this.repository.countOnServer(server.id, transaction)
        >= MAX_MANAGED_CONTAINERS_PER_AGENT) {
        throw new ConflictException({
          code: 'SERVER_CONTAINER_CAPACITY_REACHED',
          message:
            `Server already owns ${MAX_MANAGED_CONTAINERS_PER_AGENT} managed containers`,
        });
      }
      await this.assertMountsCurrent(transaction, userId, server.id, resolvedMounts);
      const freshSsh = freshImage.disableSsh
        ? null
        : await this.internalSshKey(transaction, userId);
      if (!sameJson(expectedSsh, freshSsh)) {
        throw new ConflictException('Internal SSH key rotated while creating the container; retry');
      }
      const quota = await transaction.selectFrom('control.quota_desired')
        .selectAll()
        .where('server_id', '=', server.id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (
        !quota
        || quota.numeric_user_id !== freshUser.numericId
        || Number(quota.limit_bytes) !== freshAccess.grant.diskBytes
      ) {
        throw new ConflictException({
          code: 'QUOTA_DESIRED_NOT_READY',
          message: 'Current grant quota has not reached a durable desired generation yet',
        });
      }
      const claimed = await this.repository.listNetworkAddresses(
        freshServer.macvlanCidr,
        transaction,
      );
      const networkIdentities = await transaction.selectFrom('infra.servers')
        .select(['macvlan_gateway', 'macvlan_reserved_ips'])
        .where('macvlan_cidr', '=', freshServer.macvlanCidr)
        .execute();
      const staticAddresses = networkIdentities.flatMap((identity) => [
        ...(identity.macvlan_gateway ? [identity.macvlan_gateway] : []),
        ...stringArray(identity.macvlan_reserved_ips),
      ]);
      const assignedIp = allocateNextIp(
        freshServer.macvlanCidr,
        new Set([...claimed, ...observedRuntimeIps]),
        staticAddresses,
      );
      if (!assignedIp) {
        throw new ConflictException('No durable macvlan address is available on this server');
      }
      const knownGpuIndices = [
        ...new Set([
          ...(this.agentGateway.stateCache.get(server.id)?.gpus.map((gpu) => gpu.index) ?? []),
          ...await this.repository.claimedGpuIndices(server.id, transaction),
        ]),
      ].sort((left, right) => left - right);
      const gpuIndices = resolveGpuIndices(freshAccess.grant, knownGpuIndices);
      const aggregate = await this.repository.insert({
        id: containerId,
        serverId: server.id,
        ownerId: userId,
        imageId: image.id,
        createdBy: userId,
        name: request.name,
        imageRef: image.dockerImage,
        imageDefaultUid: image.runtimeOverrides.uid,
        imageRuntimeOverrides: image.runtimeOverrides,
        cpuMillis: freshAccess.grant.cpuMillis,
        memBytes: freshAccess.grant.memBytes,
        diskBytes: Number(quota.limit_bytes),
        gpuMode: gpuIndices.length > 0 ? 'indices' : 'none',
        gpuIndices,
        mountsJson: normalizedMounts,
        powerIntent: ContainerPowerIntent.Running,
        lifecyclePhase: ContainerPhase.Provisioning,
      }, transaction);
      await this.repository.replaceMounts(
        containerId,
        resolvedMounts.map((mount) => this.mountRecord(
          aggregate,
          userId,
          mount,
        )),
        transaction,
      );
      await this.repository.replaceGpuClaims(
        containerId,
        server.id,
        gpuIndices,
        transaction,
      );
      await this.repository.insertNetworkClaim({
        id: uuidv4(),
        containerId,
        serverId: server.id,
        networkKey: freshServer.macvlanCidr,
        address: assignedIp,
      }, transaction);
      const ssh = freshSsh
        ? {
          enabled: true as const,
          internalPublicKey: freshSsh.publicKey,
          internalKeyGeneration: freshSsh.generation,
        }
        : { enabled: false as const };
      const task = await this.containerTasks.enqueueInTransaction(transaction, {
        containerId,
        serverId: server.id,
        requestedBy: userId,
        kind: AgentTaskKind.ContainerCreate,
        request: {
          ...request,
          ownerId: userId,
          createdBy: userId,
          imageDockerRef: image.dockerImage,
          imageDefaultUid: image.runtimeOverrides.uid,
          runtimeOverrides: image.runtimeOverrides,
          cpuMillis: freshAccess.grant.cpuMillis,
          memBytes: freshAccess.grant.memBytes,
          diskBytes: Number(quota.limit_bytes),
          gpuIndices,
          dataDirs: normalizedMounts,
          assignedIp,
        },
        payload: {
          containerId,
          specGeneration: 1,
          quotaGeneration: quota.generation,
          dockerRoot: runtime.dockerRoot,
          ownerId: userId,
          numericOwnerId: freshUser.numericId,
          imageDockerRef: image.dockerImage,
          imageDockerId,
          imageId: image.id,
          assignedIp,
          runtimeOverrides: image.runtimeOverrides,
          name: request.name,
          cpuMillis: freshAccess.grant.cpuMillis,
          memBytes: freshAccess.grant.memBytes,
          diskBytes: Number(quota.limit_bytes),
          gpuIndices,
          mounts: this.agentMountSpecs(resolvedMounts),
          ssh,
        },
        resourceKeys: this.containerTaskResourceKeys(
          server.id,
          userId,
          containerId,
          normalizedMounts,
          true,
        ),
        beforeCommit: async (taskTransaction, taskId) => {
          if (!await this.repository.transition(containerId, aggregate.revision, {
            activeTaskId: taskId,
            lifecyclePhase: ContainerPhase.Provisioning,
          }, taskTransaction)) {
            throw new ConflictException(
              'Container state changed while preparing create; retry',
            );
          }
        },
      });
      await this.auditService.append(
        transaction,
        userId,
        AuditAction.CreateContainer,
        containerId,
        'container',
        {
          serverId: request.serverId,
          imageId: request.imageId,
          name: request.name,
          taskId: task.taskId,
        },
      );
      return task;
    }).catch((error: unknown) => {
      if (isPgUniqueViolationForConstraint(
        error,
        'containers_owner_id_server_id_name_key',
      )) {
        throw new ConflictException('Container name is already in use on this server');
      }
      throw error;
    });
    this.proxySnapshots.invalidate(`container ${containerId} create intent committed`);
    return task;
  }

  async action(
    containerId: string,
    action: ContainerAction,
    userId: string,
    body?: unknown,
  ): Promise<AgentTaskRefResponse> {
    const container = await this.requireContainer(containerId);
    this.assertOwner(userId, container);
    return this.actionOnContainer(container, action, userId, body, true);
  }

  async actionForAdmin(
    containerId: string,
    action: ContainerAction,
    actorId: string,
    body?: unknown,
  ): Promise<AgentTaskRefResponse> {
    return this.actionOnContainer(
      await this.requireContainer(containerId),
      action,
      actorId,
      body,
      false,
    );
  }

  private async actionOnContainer(
    snapshot: ContainerAggregate,
    action: ContainerAction,
    requestedBy: string,
    body: unknown,
    requireOwnerAccess: boolean,
  ): Promise<AgentTaskRefResponse> {
    if (action === 'updateMounts') {
      throw new ForbiddenException(
        'Container mounts are immutable; delete and recreate the container',
      );
    }
    const task = await this.runContainerInteraction(snapshot.id, async () => {
      const view = (await this.viewsFor([snapshot]))[0]!;
      const availability = view.actions[action];
      if (!availability.enabled) {
        if (availability.reason === 'agent_state_unready') {
          this.assertRuntimeReady(snapshot.serverId);
        }
        throw new ForbiddenException(
          availability.message ?? availability.reason ?? 'Action unavailable',
        );
      }
      if (action !== 'delete' || snapshot.boundRuntimeId) {
        this.assertRuntimeReady(snapshot.serverId);
      }
      let restartObservation: ReturnType<typeof zInspectContainerResult.parse> | null = null;
      if (action === 'restart') {
        if (!snapshot.boundRuntimeId) {
          throw new ConflictException('A fresh runtime baseline is required before restart');
        }
        const inspect = () => this.agentGateway.rpc(
          snapshot.serverId,
          'inspectContainer',
          { containerId: snapshot.id, runtimeId: snapshot.boundRuntimeId },
        );
        const started = requireOwnerAccess
          ? await this.access.startExternalWithActiveServerAccess(
            requestedBy,
            snapshot.serverId,
            inspect,
          )
          : await this.access.startExternalWithActorCapabilities(
            requestedBy,
            [Capability.ManageContainersAny],
            inspect,
          );
        restartObservation = zInspectContainerResult.parse(await started.completion);
        if (restartObservation.runtimeId !== snapshot.boundRuntimeId) {
          throw new ConflictException('Agent returned an unexpected container runtime identity');
        }
      }
      const result = await this.transactions.run(async (transaction) => {
        const current = await this.repository.lock(snapshot.id, transaction);
        if (!current) throw new NotFoundException('Container not found');
        if (current.revision !== snapshot.revision) {
          throw new ConflictException('Container state changed while preparing the action; retry');
        }
        if (requireOwnerAccess) {
          if (current.ownerId !== requestedBy) throw new ForbiddenException();
          const [actor, serverAccess] = await Promise.all([
            this.user(requestedBy, transaction),
            this.access.resolveServerInTransaction(
              transaction,
              requestedBy,
              current.serverId,
            ),
          ]);
          if (actor?.status !== UserStatus.Active || !serverAccess) {
            throw new ForbiddenException(
              'Container owner is disabled or server access was revoked',
            );
          }
        } else {
          await this.access.assertActorCapabilitiesInTransaction(
            transaction,
            requestedBy,
            [Capability.ManageContainersAny],
          );
        }
        let task: AgentTaskRefResponse;
        if (action === 'reconcileSsh') {
          task = await this.enqueueSshReconcile(transaction, current, requestedBy);
        } else {
          if (action === 'stats' || action === 'console') {
            throw new BadRequestException(
              `Container action ${action} is not a lifecycle task`,
            );
          }
          task = await this.enqueueLifecycleAction(
            transaction,
            current,
            action,
            requestedBy,
            body,
            restartObservation,
          );
        }
        await this.auditService.append(
          transaction,
          requestedBy,
          this.auditAction(action),
          current.id,
          'container',
          {
            serverId: current.serverId,
            ownerId: current.ownerId,
            taskId: task.taskId,
          },
        );
        return task;
      });
      this.proxySnapshots.invalidate(
        `container ${snapshot.id} ${action} intent committed`,
      );
      return this.enqueueLifecycleTaskThenRevokeConsoles(
        snapshot.boundRuntimeId,
        async () => result,
      );
    });
    return task;
  }

  private async enqueueLifecycleAction(
    transaction: Transaction<NyabaseDatabase>,
    container: ContainerAggregate,
    action: Exclude<ContainerAction, 'stats' | 'console' | 'updateMounts' | 'reconcileSsh'>,
    requestedBy: string,
    body: unknown,
    restartObservation: ReturnType<typeof zInspectContainerResult.parse> | null,
  ): Promise<AgentTaskRefResponse> {
    const powerEnsure = action === 'start' || action === 'restart';
    const quota = powerEnsure
      ? await transaction.selectFrom('control.quota_desired')
        .selectAll()
        .where('server_id', '=', container.serverId)
        .where('user_id', '=', container.ownerId)
        .executeTakeFirst()
      : null;
    const owner = await this.user(container.ownerId, transaction);
    if (!owner?.numericId) {
      throw new ConflictException('User numeric ID is required for container runtime tasks');
    }
    if (powerEnsure && (!quota || quota.numeric_user_id !== owner.numericId)) {
      throw new ConflictException(
        'Current durable quota generation is unavailable for this container owner',
      );
    }
    const mounts = powerEnsure
      ? await this.resolveMountIntegrity(transaction, container)
      : [];
    const ssh = powerEnsure ? await this.containerSshPayload(transaction, container) : null;
    const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const payload = {
      containerId: container.id,
      runtimeId: container.boundRuntimeId,
      timeoutSeconds: typeof bodyRecord.timeoutSeconds === 'number'
        ? bodyRecord.timeoutSeconds
        : undefined,
      ...(powerEnsure ? {
        dockerRoot: this.agentGateway.stateCache
          .requireRuntimeReady(container.serverId).dockerRoot,
        quotaGeneration: quota!.generation,
        numericOwnerId: owner.numericId,
        diskBytes: Number(quota!.limit_bytes),
        quotaPaths: container.quotaPaths,
        mounts: this.agentMountSpecs(mounts),
        ssh,
      } : {}),
      ...(action === 'restart'
        ? { baselineStartedAt: restartObservation?.startedAt }
        : {}),
      ...(action === 'delete'
        ? {
          serverId: container.serverId,
          specGeneration: container.boundRuntimeId
            ? String(container.desiredGeneration)
            : null,
          runtimeSpecHash: container.boundRuntimeId
            ? container.runtimeSpecHash
            : null,
          numericOwnerId: owner.numericId,
          quotaPaths: container.quotaPaths,
        }
        : {}),
    };
    const kind = action === 'start'
      ? AgentTaskKind.ContainerStart
      : action === 'stop'
        ? AgentTaskKind.ContainerStop
        : action === 'restart'
          ? AgentTaskKind.ContainerRestart
          : AgentTaskKind.ContainerDelete;
    return this.containerTasks.enqueueInTransaction(transaction, {
      containerId: container.id,
      serverId: container.serverId,
      requestedBy,
      kind,
      request: body ?? { action },
      payload,
      resourceKeys: this.containerTaskResourceKeys(
        container.serverId,
        container.ownerId,
        container.id,
        mounts,
        action === 'delete' || powerEnsure,
      ),
      beforeCommit: async (taskTransaction, taskId) => {
        const nextPower = action === 'stop'
          ? ContainerPowerIntent.Stopped
          : action === 'start' || action === 'restart'
            ? ContainerPowerIntent.Running
            : container.powerIntent;
        const transitioned = await this.repository.transition(
          container.id,
          container.revision,
          {
            activeTaskId: taskId,
            lifecyclePhase: action === 'delete'
              ? ContainerPhase.Deleting
              : ContainerPhase.Updating,
            powerIntent: nextPower,
            failureCode: null,
            failureReason: null,
          },
          taskTransaction,
        );
        if (!transitioned) {
          throw new ConflictException(
            'Container state changed while preparing the action; retry',
          );
        }
      },
    });
  }

  private async enqueueSshReconcile(
    transaction: Transaction<NyabaseDatabase>,
    container: ContainerAggregate,
    requestedBy: string,
  ): Promise<AgentTaskRefResponse> {
    if (!container.boundRuntimeId) throw new ForbiddenException('Runtime is not bound yet');
    const ssh = await this.containerSshPayload(transaction, container);
    return this.containerTasks.enqueueInTransaction(transaction, {
      containerId: container.id,
      serverId: container.serverId,
      requestedBy,
      kind: AgentTaskKind.ContainerSshEnsure,
      request: { action: 'reconcileSsh' },
      payload: {
        containerId: container.id,
        runtimeId: container.boundRuntimeId,
        ...ssh,
      },
      resourceKeys: [this.resourceKeys.container(container.id)],
      beforeCommit: async (taskTransaction, taskId) => {
        if (!await this.repository.transition(container.id, container.revision, {
          activeTaskId: taskId,
          lifecyclePhase: ContainerPhase.Updating,
          failureCode: null,
          failureReason: null,
        }, taskTransaction)) {
          throw new ConflictException(
            'Container state changed while preparing SSH reconciliation; retry',
          );
        }
      },
    });
  }

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
  ): Promise<ExecSessionResponse> {
    const container = await this.requireContainer(containerId);
    this.assertOwner(userId, container);
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
  ): Promise<ExecSessionResponse> {
    return this.createExecSessionForContainer(
      await this.requireContainer(containerId),
      actorId,
      authVersion,
      request,
      'manage-containers-any',
    );
  }

  private async createExecSessionForContainer(
    container: ContainerAggregate,
    actorId: string,
    authVersion: number,
    request: ExecSessionRequest,
    authorizationKind: 'container-owner' | 'manage-containers-any',
  ): Promise<ExecSessionResponse> {
    const result = await this.runContainerInteraction(container.id, async () => {
      const current = await this.requireContainer(container.id);
      const view = (await this.viewsFor([current]))[0]!;
      if (!view.actions.console.enabled) {
        throw new ForbiddenException(
          view.actions.console.message
            ?? view.actions.console.reason
            ?? 'Console unavailable',
        );
      }
      if (!current.boundRuntimeId) {
        throw new ForbiddenException('Runtime is not bound yet');
      }
      const sessionId = uuidv4();
      const authority = {
        serverId: current.serverId,
        userId: actorId,
        containerId: current.id,
        dockerId: current.boundRuntimeId,
        authorizationKind,
        createdAt: Date.now(),
        claimed: false,
      };
      try {
        let consolePublicUrl = '';
        const shell = request.shell?.trim() || '/bin/sh';
        const admission = await this.execSessionAuthorization.startAuthorized(
          authority,
          authVersion,
          () => {
            return this.agentGateway.rpc(current.serverId, 'execStream', {
              sessionId,
              runtimeId: current.boundRuntimeId!,
              cmd: [shell],
              tty: request.tty !== false,
              cols: request.cols,
              rows: request.rows,
              _nyabaseExecAuthority: {
                userId: actorId,
                containerId: current.id,
                authorizationKind,
              },
            });
          },
          async (transaction) => {
            const intent = await this.workflow.createExecSessionIntentInTransaction(
              transaction,
              {
                id: sessionId,
                serverId: current.serverId,
                userId: actorId,
                containerId: current.id,
                runtimeId: current.boundRuntimeId!,
                authorizationKind,
              },
            );
            consolePublicUrl = intent.consolePublicUrl;
            await this.auditService.append(
              transaction,
              actorId,
              AuditAction.ExecContainer,
              current.id,
              'container',
              {
                serverId: current.serverId,
                ownerId: current.ownerId,
                sessionId,
                tty: request.tty !== false,
              },
            );
          },
        );
        if (!admission) {
          throw new ForbiddenException(
            'Console authorization was revoked before session admission',
          );
        }
        await admission.result;
        return {
          sessionId,
          consoleUrl: `${consolePublicUrl || '/ws/console'}?sessionId=${encodeURIComponent(sessionId)}`,
        };
      } catch (error) {
        await this.workflow.closeExecSession(
          sessionId,
          'Exec admission did not complete',
        );
        throw error;
      }
    });
    return result;
  }

  async getStats(containerId: string, userId: string): Promise<ContainerStatsResponse> {
    return this.statsForView(await this.get(containerId, userId));
  }

  async getStatsForAdmin(
    containerId: string,
    actorId: string,
  ): Promise<ContainerStatsResponse> {
    return this.statsForView(await this.getForAdmin(containerId, actorId));
  }

  private async statsForView(view: ContainerView): Promise<ContainerStatsResponse> {
    if (!view.actions.stats.enabled) {
      throw new ForbiddenException(
        view.actions.stats.message ?? view.actions.stats.reason ?? 'Stats unavailable',
      );
    }
    if (view.runtime.runtimeId) {
      const observedAt = this.agentGateway.stateCache.get(view.serverId)?.lastUpdated
        ?? Date.now();
      const lastObservedAt = safeEpochToIso(observedAt);
      return {
        containerId: view.id,
        stats: null,
        ts: lastObservedAt ? observedAt : Date.now(),
        ...(lastObservedAt ? { lastObservedAt } : {}),
      };
    }
    return { containerId: view.id, stats: null, ts: Date.now() };
  }

  private async viewsFor(containers: ContainerAggregate[]): Promise<ContainerView[]> {
    if (containers.length === 0) return [];
    const ids = containers.map((container) => container.id);
    // These projection reads are intentionally sequential. A single container
    // response does not need five PostgreSQL connections at once, and keeping
    // the fan-out bounded leaves pool capacity for authentication, health, and
    // task polling during disposable dependency outages.
    const servers = await this.serverMap(
      [...new Set(containers.map((container) => container.serverId))],
    );
    const images = await this.imageMap(
      [...new Set(containers.map((container) => container.imageId))],
    );
    const users = await this.userMap(
      [...new Set(containers.map((container) => container.ownerId))],
    );
    const routes = await this.repository.routes(ids);
    const mountRows = await this.repository.listMounts(ids);
    const activeTasks = await this.containerTasks.findPendingMany(
      containers.map((container) => ({
        containerId: container.id,
        taskId: container.activeTaskId,
      })),
    );
    const mounts = new Map<string, ContainerMountRecord[]>();
    for (const row of mountRows) {
      const list = mounts.get(row.containerId) ?? [];
      list.push(row);
      mounts.set(row.containerId, list);
    }
    const omittedLoginIds = await this.omittedServerLoginContainerIds(
      containers,
      routes,
      images,
    );
    const views: ContainerView[] = [];
    for (const container of containers) {
      views.push(await this.toView(
        container,
        servers,
        images,
        users,
        routes.get(container.id) ?? null,
        mounts.get(container.id) ?? [],
        omittedLoginIds.has(container.id),
        activeTasks.get(container.id) ?? null,
      ));
    }
    return views;
  }

  private async toView(
    container: ContainerAggregate,
    servers: Map<string, ServerProjection>,
    images: Map<string, ImageProjection>,
    users: Map<string, UserProjection>,
    route: ContainerSshRouteRecord | null,
    mountRows: ContainerMountRecord[],
    omittedServerLoginAllowed: boolean,
    activeTask: UserAgentTaskDto | null,
  ): Promise<ContainerView> {
    const runtimeReady = this.agentGateway.stateCache.isRuntimeReady(container.serverId);
    const serverSnapshot = this.agentGateway.stateCache.get(container.serverId);
    // Durable runtime_missing is committed before the same Agent report's
    // process-local projection is published. Never combine that authoritative
    // failure with the previous report's apparently running snapshot.
    const snapshot = runtimeReady
      && container.boundRuntimeId
      && container.failureCode !== 'runtime_missing'
      ? this.agentGateway.stateCache.getContainer(
        container.serverId,
        container.boundRuntimeId,
      )
      : undefined;
    const runtimeId = container.boundRuntimeId ?? snapshot?.runtime.runtimeId ?? null;
    // Prefer the live agent snapshot when present. After a successful stop the
    // agent often omits exited containers from the running set; fall back to the
    // durable SSH route status (written by the stop finalizer) so start stays
    // available for grace-phase migration restarts.
    const runtimeStatus = snapshot?.status
      ?? route?.runtimeStatus
      ?? (container.powerIntent === ContainerPowerIntent.Stopped
        ? ContainerStatus.Exited
        : ContainerStatus.Unknown);
    const mounts = this.safeNormalizedMounts(container.mountsJson);
    const drift = this.runtimeDrift(container, snapshot, runtimeReady);
    if (mounts === null || !this.mountRowsMatch(mounts, mountRows)) {
      drift.push({
        kind: RuntimeDriftKind.DesiredMountSpecInvalid,
        message: 'Durable container mount configuration is invalid',
      });
    }
    const server = servers.get(container.serverId);
    const image = images.get(container.imageId);
    const owner = users.get(container.ownerId);
    const failure = requesterSafeContainerFailure(
      container.failureCode,
      container.failureReason,
    );
    return {
      id: container.id,
      serverId: container.serverId,
      serverName: server?.name ?? container.serverId,
      ownerId: container.ownerId,
      ownerName: owner?.username,
      name: container.name,
      imageId: container.imageId,
      imageName: image?.name,
      failureCode: failure.failureCode,
      failureReason: failure.failureReason,
      powerIntent: container.powerIntent,
      runtimeReady,
      runtime: {
        bound: Boolean(runtimeId),
        runtimeId,
        status: runtimeStatus,
        ip: this.nonEmptyString(snapshot?.runtime.ip),
        observedAt: snapshot
          ? safeEpochToIso(serverSnapshot?.lastUpdated ?? Date.now())
          : null,
        drift,
      },
      activeTask,
      resources: {
        cpuMillis: container.cpuMillis,
        memBytes: container.memBytes,
        diskBytes: container.diskBytes,
        gpuIndices: container.gpuIndices,
      },
      ssh: this.sshView(
        container,
        owner,
        server,
        image,
        snapshot,
        route,
        omittedServerLoginAllowed,
      ),
      mounts: (mounts ?? []).map((mount) => ({
        id: mount.id,
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
        dirName: mount.dirName,
        containerPath: mount.containerPath,
      })),
      actions: this.actions.forContainer({
        phase: container.lifecyclePhase,
        runtimeReady,
        runtimeStatus,
        runtimeDrift: drift,
        activeTaskId: container.activeTaskId ?? activeTask?.id ?? null,
        sshEnabled: image?.disableSsh !== true,
      }),
    };
  }

  private runtimeDrift(
    container: ContainerAggregate,
    snapshot: ContainerSnapshot | undefined,
    runtimeReady: boolean,
  ): ContainerView['runtime']['drift'] {
    const drift: ContainerView['runtime']['drift'] = [];
    if (!runtimeReady) {
      drift.push({
        kind: RuntimeDriftKind.AgentStateUnready,
        message: 'Agent runtime state is not ready',
      });
      return drift;
    }
    if (!container.boundRuntimeId && !snapshot) {
      drift.push({
        kind: RuntimeDriftKind.RuntimeUnbound,
        message: 'Container has no bound runtime',
      });
    }
    if (
      container.lifecyclePhase === ContainerPhase.Active
      && !snapshot
      && container.powerIntent !== ContainerPowerIntent.Stopped
    ) {
      drift.push({
        kind: RuntimeDriftKind.RuntimeMissing,
        message: 'Runtime container is missing from agent state',
      });
    }
    if (
      container.boundRuntimeId
      && snapshot?.runtime.runtimeId
      && container.boundRuntimeId !== snapshot.runtime.runtimeId
    ) {
      drift.push({
        kind: RuntimeDriftKind.RuntimeIdMismatch,
        desired: container.boundRuntimeId,
        observed: snapshot.runtime.runtimeId,
      });
    }
    if (snapshot) {
      const running = snapshot.status === ContainerStatus.Running;
      const stopped = snapshot.status === ContainerStatus.Exited
        || snapshot.status === ContainerStatus.Dead;
      if (
        (container.powerIntent === ContainerPowerIntent.Running && !running)
        || (container.powerIntent === ContainerPowerIntent.Stopped && !stopped)
      ) {
        drift.push({
          kind: RuntimeDriftKind.PowerIntentMismatch,
          desired: container.powerIntent,
          observed: snapshot.status,
        });
      }
      const generation = this.numberOrNull(
        snapshot.labels?.[LABEL.SPEC_GENERATION],
      );
      if (generation !== null && generation < container.desiredGeneration) {
        drift.push({
          kind: RuntimeDriftKind.SpecGenerationStale,
          desired: container.desiredGeneration,
          observed: generation,
        });
      }
    }
    return drift;
  }

  private sshView(
    container: ContainerAggregate,
    owner: UserProjection | undefined,
    server: ServerProjection | undefined,
    image: ImageProjection | undefined,
    snapshot: ContainerSnapshot | undefined,
    route: ContainerSshRouteRecord | null,
    omittedServerLoginAllowed: boolean,
  ): ContainerView['ssh'] {
    const endpoint = this.sshProxySnapshots.endpoint();
    const disabledByImage = image?.disableSsh === true;
    const status = route?.sshStatus
      ?? snapshot?.sshServer.status
      ?? (disabledByImage ? 'disabled' : 'unknown');
    const runningRoute = Boolean(
      !disabledByImage
      && route?.macvlanIp
      && route.runtimeStatus === ContainerStatus.Running
      && route.sshStatus === 'running',
    );
    const username = owner?.username ?? container.ownerId;
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
        explicitServer: runningRoute && server
          ? `${username}.${server.slug}.${container.name}`
          : null,
      },
      proxyHost: endpoint?.host ?? null,
      proxyPort: endpoint?.port ?? null,
      observedAt: route?.observedAt.toISOString() ?? null,
      appliedInternalKeyGeneration: route?.appliedInternalKeyGeneration ?? null,
      hostKeyFingerprint: route?.containerHostKeyFingerprint
        ?? snapshot?.sshServer.hostKeyFingerprint
        ?? null,
      user: 'root',
      port: 22,
      lastError: requesterSafeSshError(
        route?.lastError ?? snapshot?.sshServer.lastError,
      ),
    };
  }

  private async resolveMounts(
    executor: ContainerExecutor,
    serverId: string,
    userId: string,
    mounts: readonly NormalizedContainerMount[],
  ): Promise<ResolvedMount[]> {
    if (mounts.length === 0) return [];
    const sourceIds = [...new Set(mounts.map((mount) => mount.sourceId))];
    const remoteIds = [...new Set(mounts
      .filter((mount) => mount.sourceKind === 'remote')
      .map((mount) => mount.sourceId))];
    const [directories, assignments, remoteMounts] = await Promise.all([
      executor.selectFrom('control.data_directories')
        .selectAll()
        .where('user_id', '=', userId)
        .where('source_id', 'in', sourceIds)
        .where('desired_state', '=', 'active')
        .execute(),
      remoteIds.length === 0
        ? Promise.resolve([])
        : executor.selectFrom('infra.remote_fs_server_assignments')
            .select(['id', 'remote_fs_mount_id'])
            .where('remote_fs_mount_id', 'in', remoteIds)
            .where('server_id', '=', serverId)
            .where('desired_state', '=', 'active')
            .execute(),
      remoteIds.length === 0
        ? Promise.resolve([])
        : executor.selectFrom('infra.remote_fs_mounts')
            .select(['id', 'params', 'desired_state'])
            .where('id', 'in', remoteIds)
            .execute(),
    ]);
    const directoryByKey = new Map<string, (typeof directories)[number]>();
    for (const directory of directories) {
      if (
        directory.source_kind === 'local'
          ? directory.server_id !== serverId
          : directory.server_id !== null
      ) continue;
      const key = this.mountDirectoryKey(
        directory.source_kind,
        directory.source_id,
        directory.name,
      );
      if (directoryByKey.has(key)) {
        throw new ConflictException('Data directory identity is ambiguous');
      }
      directoryByKey.set(key, directory);
    }
    const assignmentIds = new Set(assignments.map((assignment) =>
      assignment.remote_fs_mount_id));
    if (assignmentIds.size !== assignments.length) {
      throw new ConflictException('Remote FS mount assignment identity is ambiguous');
    }
    const remoteById = new Map(remoteMounts.map((remote) => [remote.id, remote]));
    if (remoteById.size !== remoteMounts.length) {
      throw new ConflictException('Remote FS mount identity is ambiguous');
    }
    const result: ResolvedMount[] = [];
    for (const mount of mounts) {
      const directory = directoryByKey.get(this.mountDirectoryKey(
        mount.sourceKind,
        mount.sourceId,
        mount.dirName,
      ));
      if (!directory) throw new NotFoundException('Data directory not found');
      if (mount.sourceKind === 'local') {
        const disks = this.agentGateway.stateCache.get(serverId)?.disks
          .filter((disk) => disk.diskId === mount.sourceId) ?? [];
        if (
          disks.length !== 1
          || disks[0]!.sourceIdentity !== directory.source_identity
        ) {
          throw new ConflictException(
            'Data disk identity changed after DataDir creation',
          );
        }
      } else {
        const remote = remoteById.get(mount.sourceId);
        if (!assignmentIds.has(mount.sourceId) || remote?.desired_state !== 'active') {
          throw new NotFoundException('Remote FS mount not assigned to server');
        }
        if (remoteFsSourceIdentity(remote.params) !== directory.source_identity) {
          throw new ConflictException(
            'Remote filesystem identity changed after DataDir creation',
          );
        }
      }
      result.push({
        ...mount,
        resourceId: directory.id,
        sourceIdentity: directory.source_identity,
      });
    }
    return result;
  }

  private mountDirectoryKey(
    sourceKind: string,
    sourceId: string,
    name: string,
  ): string {
    return JSON.stringify([sourceKind, sourceId, name]);
  }

  private async assertMountsCurrent(
    transaction: Transaction<NyabaseDatabase>,
    userId: string,
    serverId: string,
    expected: readonly ResolvedMount[],
  ): Promise<void> {
    const current = await this.resolveMounts(
      transaction,
      serverId,
      userId,
      expected,
    );
    for (const [index, mount] of current.entries()) {
      if (
        mount.resourceId !== expected[index]?.resourceId
        || mount.sourceIdentity !== expected[index]?.sourceIdentity
      ) {
        throw new ConflictException({
          code: 'CONTAINER_MOUNT_SOURCE_UNAVAILABLE',
          message: 'A container mount source changed while preparing the action; retry',
        });
      }
    }
  }

  private async resolveMountIntegrity(
    transaction: Transaction<NyabaseDatabase>,
    container: ContainerAggregate,
  ): Promise<ResolvedMount[]> {
    const desired = normalizeContainerMounts(container.mountsJson);
    const resolved = await this.resolveMounts(
      transaction,
      container.serverId,
      container.ownerId,
      desired,
    );
    const rows = await this.repository.listMounts([container.id], transaction);
    if (!this.resolvedMountRowsMatch(resolved, rows)) {
      throw new ConflictException({
        code: 'CONTAINER_MOUNT_INDEX_DIVERGENT',
        message: 'Durable container mount configuration is internally inconsistent',
      });
    }
    for (const mount of resolved) {
      if (!await this.access.hasMountSourceAccessInTransaction(
        transaction,
        container.ownerId,
        container.serverId,
        { kind: mount.sourceKind, id: mount.sourceId },
        mount.sourceKind === 'local' ? mount.sourceIdentity : undefined,
      )) {
        throw new ForbiddenException('Mount source access was revoked');
      }
    }
    return resolved;
  }

  private async internalSshKey(
    executor: ContainerExecutor,
    userId: string,
  ): Promise<{ publicKey: string; generation: number; fingerprint: string }> {
    const [user, key] = await Promise.all([
      executor.selectFrom('iam.users')
        .select('status')
        .where('id', '=', userId)
        .executeTakeFirst(),
      executor.selectFrom('iam.user_internal_ssh_keys')
        .select(['public_key', 'generation', 'fingerprint'])
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    ]);
    if (user?.status !== UserStatus.Active) {
      throw new ForbiddenException('Container owner is disabled');
    }
    if (!key) throw new ConflictException('User internal SSH key invariant is missing');
    return {
      publicKey: key.public_key,
      generation: key.generation,
      fingerprint: key.fingerprint,
    };
  }

  private async assertNetworkInventoryTrusted(
    transaction: Transaction<NyabaseDatabase>,
    networkKey: string,
  ): Promise<void> {
    const peers = await transaction.selectFrom('infra.servers')
      .select(['id', 'status'])
      .where('macvlan_cidr', '=', networkKey)
      .execute();
    const untrusted = peers.find((peer) => peer.status !== ServerStatus.Online);
    if (!untrusted) return;
    throw new ConflictException({
      code: 'NETWORK_INVENTORY_UNTRUSTED',
      message:
        'A Server on the shared macvlan has no trusted authoritative inventory',
      serverId: untrusted.id,
    });
  }

  private async containerSshPayload(
    executor: ContainerExecutor,
    container: ContainerAggregate,
  ): Promise<{
    enabled: boolean;
    internalPublicKey?: string;
    internalKeyGeneration?: number;
  }> {
    const image = await this.image(container.imageId, executor);
    if (!image) throw new ConflictException('Container image definition is missing');
    if (image.disableSsh) return { enabled: false };
    const key = await this.internalSshKey(executor, container.ownerId);
    return {
      enabled: true,
      internalPublicKey: key.publicKey,
      internalKeyGeneration: key.generation,
    };
  }

  private async requireContainer(id: string): Promise<ContainerAggregate> {
    const container = await this.repository.find(id);
    if (!container) throw new NotFoundException('Container not found');
    return container;
  }

  private assertOwner(userId: string, container: ContainerAggregate): void {
    if (container.ownerId !== userId) throw new ForbiddenException();
  }

  private async server(
    id: string,
    executor: ContainerExecutor = this.database,
  ): Promise<ServerProjection | null> {
    const row = await executor.selectFrom('infra.servers')
      .select([
        'id', 'name', 'slug', 'status', 'macvlan_cidr', 'macvlan_gateway',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      macvlanCidr: row.macvlan_cidr,
      macvlanGateway: row.macvlan_gateway,
    } : null;
  }

  private async image(
    id: string,
    executor: ContainerExecutor = this.database,
  ): Promise<ImageProjection | null> {
    const row = await executor.selectFrom('infra.images')
      .select([
        'id', 'name', 'docker_image', 'runtime_overrides',
        'is_active', 'disable_ssh', 'deleting',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? {
      id: row.id,
      name: row.name,
      dockerImage: row.docker_image,
      runtimeOverrides: row.runtime_overrides as ImageRuntimeOverrides,
      isActive: row.is_active,
      disableSsh: row.disable_ssh,
      deleting: row.deleting,
    } : null;
  }

  private async user(
    id: string,
    executor: ContainerExecutor = this.database,
  ): Promise<UserProjection | null> {
    const row = await executor.selectFrom('iam.users')
      .select(['id', 'numeric_id', 'username', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? {
      id: row.id,
      numericId: row.numeric_id,
      username: row.username,
      status: row.status,
    } : null;
  }

  private async serverMap(ids: string[]): Promise<Map<string, ServerProjection>> {
    if (ids.length === 0) return new Map();
    const rows = await this.database.selectFrom('infra.servers')
      .select([
        'id', 'name', 'slug', 'status', 'macvlan_cidr', 'macvlan_gateway',
      ])
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((row) => [row.id, {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      macvlanCidr: row.macvlan_cidr,
      macvlanGateway: row.macvlan_gateway,
    }]));
  }

  private async imageMap(ids: string[]): Promise<Map<string, ImageProjection>> {
    if (ids.length === 0) return new Map();
    const rows = await this.database.selectFrom('infra.images')
      .select([
        'id', 'name', 'docker_image', 'runtime_overrides',
        'is_active', 'disable_ssh', 'deleting',
      ])
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((row) => [row.id, {
      id: row.id,
      name: row.name,
      dockerImage: row.docker_image,
      runtimeOverrides: row.runtime_overrides as ImageRuntimeOverrides,
      isActive: row.is_active,
      disableSsh: row.disable_ssh,
      deleting: row.deleting,
    }]));
  }

  private async userMap(ids: string[]): Promise<Map<string, UserProjection>> {
    if (ids.length === 0) return new Map();
    const rows = await this.database.selectFrom('iam.users')
      .select(['id', 'numeric_id', 'username', 'status'])
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((row) => [row.id, {
      id: row.id,
      numericId: row.numeric_id,
      username: row.username,
      status: row.status,
    }]));
  }

  private async omittedServerLoginContainerIds(
    containers: ContainerAggregate[],
    routes: Map<string, ContainerSshRouteRecord>,
    images: Map<string, ImageProjection>,
  ): Promise<Set<string>> {
    const owners = [...new Set(containers.map((container) => container.ownerId))];
    const names = [...new Set(containers.map((container) => container.name))];
    const candidates = (await this.repository.list()).filter((candidate) =>
      owners.includes(candidate.ownerId) && names.includes(candidate.name));
    const candidateRoutes = await this.repository.routes(
      candidates.map((candidate) => candidate.id),
    );
    for (const [id, route] of routes) candidateRoutes.set(id, route);
    const missingImageIds = [...new Set(candidates.map((candidate) => candidate.imageId))]
      .filter((id) => !images.has(id));
    for (const [id, image] of await this.imageMap(missingImageIds)) {
      images.set(id, image);
    }
    const byOwnerName = new Map<string, string[]>();
    for (const candidate of candidates) {
      const route = candidateRoutes.get(candidate.id);
      if (
        !route
        || images.get(candidate.imageId)?.disableSsh
        || !route.macvlanIp
        || route.runtimeStatus !== ContainerStatus.Running
        || route.sshStatus !== 'running'
      ) continue;
      const key = `${candidate.ownerId}\n${candidate.name.toLowerCase()}`;
      byOwnerName.set(key, [...(byOwnerName.get(key) ?? []), candidate.id]);
    }
    const result = new Set<string>();
    for (const ids of byOwnerName.values()) if (ids.length === 1) result.add(ids[0]!);
    return result;
  }

  private mountRecord(
    container: ContainerAggregate,
    userId: string,
    mount: ResolvedMount,
  ): ContainerMountRecord {
    return {
      id: uuidv4(),
      containerId: container.id,
      serverId: container.serverId,
      resourceId: mount.resourceId,
      sourceKind: mount.sourceKind,
      sourceId: mount.sourceId,
      sourceIdentity: mount.sourceIdentity,
      userId,
      dirName: mount.dirName,
      containerPath: mount.containerPath,
    };
  }

  private agentMountSpecs(mounts: readonly ResolvedMount[]): ContainerMountSpec[] {
    return mounts.map((mount) => ({
      sourceId: mount.sourceId,
      resourceId: mount.resourceId,
      sourceIdentity: mount.sourceIdentity,
      containerPath: mount.containerPath,
    }));
  }

  private containerTaskResourceKeys(
    serverId: string,
    userId: string,
    containerId: string,
    mounts: readonly Pick<
      NormalizedContainerMount,
      'sourceKind' | 'sourceId' | 'dirName'
    >[],
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

  private safeNormalizedMounts(value: unknown): NormalizedContainerMount[] | null {
    try {
      return normalizeContainerMounts(value);
    } catch {
      return null;
    }
  }

  private mountRowsMatch(
    mounts: readonly NormalizedContainerMount[],
    rows: readonly ContainerMountRecord[],
  ): boolean {
    return mounts.length === rows.length
      && mounts.every((mount) => rows.some((row) =>
        row.sourceKind === mount.sourceKind
        && row.sourceId === mount.sourceId
        && row.dirName === mount.dirName
        && row.containerPath === mount.containerPath));
  }

  private resolvedMountRowsMatch(
    mounts: readonly ResolvedMount[],
    rows: readonly ContainerMountRecord[],
  ): boolean {
    return this.mountRowsMatch(mounts, rows)
      && mounts.every((mount) => rows.some((row) =>
        row.resourceId === mount.resourceId
        && row.sourceIdentity === mount.sourceIdentity
        && row.containerPath === mount.containerPath));
  }

  private nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private numberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value !== 'string' || value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
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

  private async runContainerInteraction<T>(
    containerId: string,
    work: () => Promise<T>,
  ): Promise<T> {
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

  private auditAction(action: ContainerAction): AuditAction {
    switch (action) {
      case 'start': return AuditAction.StartContainer;
      case 'stop': return AuditAction.StopContainer;
      case 'restart': return AuditAction.RestartContainer;
      case 'delete': return AuditAction.DeleteContainer;
      case 'reconcileSsh': return AuditAction.ReconcileContainerSsh;
      case 'updateMounts':
        throw new BadRequestException(
          'Container mounts are immutable; delete and recreate the container',
        );
      case 'stats':
      case 'console':
        throw new BadRequestException(`Container action ${action} has no lifecycle audit`);
    }
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isPgUniqueViolationForConstraint(
  error: unknown,
  constraint: string,
): boolean {
  return !!error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === '23505'
    && (error as { constraint?: unknown }).constraint === constraint;
}
