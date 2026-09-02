import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AuditAction,
  Capability,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  FailureCode,
  IntentKind,
  IntentResourceType,
  StoragePoolResizeFamily,
  type ContainerDto,
  type AttachVolumeRequest,
  type CreateContainerRequest,
  type CreateExecSessionRequest,
  type IntentAcceptedDto,
  type PatchContainerLimitsRequest,
  type PatchContainerRootSizeRequest,
  type VolumeAttachmentDto,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import { acceptedIntent, isoDate, nullableNumber, numberValue, poolLabel } from '../domain/domain-utils.js';
import { IntentRepository } from '../runtime/intent.repository.js';
import { ReconcileWakeService } from '../runtime/reconcile-wake.service.js';
import { ConsoleSessionService } from '../runtime/console-session.service.js';
import { ContainerSshConvergenceService } from '../ssh/container-ssh-convergence.service.js';
import {
  ContainerControlRepository,
  type ContainerExecutor,
  type ContainerRow,
} from './container-control.repository.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import { IpPoolsRepository } from '../ip-pools/ip-pools.repository.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import {
  missingStoragePoolCapability,
  storagePoolCapability,
} from '../storage-pools/storage-pools.service.js';
import { VolumesService } from '../volumes/volumes.service.js';
import { ExtensionDeviceClaimsRepository } from '../server-card-extensions/claims.repository.js';
import { asJsonObject } from '../server-card-extensions/json.js';
import { ServerCardExtensionRegistry } from '../server-card-extensions/registry.js';
import type { ExtensionGrantView } from '../server-card-extensions/types.js';

type ContainerAction = 'start' | 'stop' | 'restart' | 'delete';

interface ImageRow {
  id: string;
  name: string;
  alias: string;
  fingerprint: string | null;
  login_user: string;
  min_root_size_bytes: string | number | null;
  network_managed_externally: boolean;
  is_active: boolean;
  deleting: boolean;
}

interface ServerRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  system_pool_id: string | null;
  parent_interface: string | null;
  preflight_status: string;
}

function date(value: Date | string | null | undefined): string | null {
  return isoDate(value);
}

function phase(value: string): ContainerPhase {
  return value as ContainerPhase;
}

export function containerStatus(
  value: string | null | undefined,
  power: ContainerPowerIntent,
): ContainerStatus {
  const normalized = value?.toLowerCase();
  if (normalized === 'running') return ContainerStatus.Running;
  if (normalized === 'stopped') return ContainerStatus.Stopped;
  if (normalized === 'frozen') return ContainerStatus.Frozen;
  if (normalized === 'error') return ContainerStatus.Error;
  if (value !== null && value !== undefined) return ContainerStatus.Unknown;
  if (power === ContainerPowerIntent.Stopped) return ContainerStatus.Stopped;
  return ContainerStatus.Unknown;
}

export function assertContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(name)) {
    throw new BadRequestException({
      code: FailureCode.InvalidInput,
      message: 'Container name must be 1-63 characters and use letters, numbers, or hyphen',
    });
  }
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (record.code === '23505') {
      if (!constraint) return true;
      return String(record.constraint ?? '').includes(constraint);
    }
    current = record.cause;
  }
  return false;
}

function extensionDeviceClaimed(deviceKey?: string): ConflictException {
  return new ConflictException({
    code: FailureCode.ExtensionDeviceClaimed,
    message: 'A requested extension device is already claimed',
    details: deviceKey ? { deviceKey } : {},
  });
}

function assertCreateNumbers(request: CreateContainerRequest): void {
  if (!Number.isSafeInteger(request.rootSizeBytes) || request.rootSizeBytes <= 0
    || !Number.isSafeInteger(request.cpuMillis) || request.cpuMillis < 0
    || !Number.isSafeInteger(request.memBytes) || request.memBytes < 0) {
    throw new BadRequestException({
      code: FailureCode.InvalidInput,
      message: 'Container resource limits must be non-negative safe integers with a positive root size',
    });
  }
}

function stringArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return [...value];
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

@Injectable()
export class ContainerControlService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly repository: ContainerControlRepository,
    private readonly access: AccessResolverService,
    private readonly intents: IntentRepository,
    private readonly wake: ReconcileWakeService,
    private readonly consoleSessions: ConsoleSessionService,
    private readonly audit: AuditService,
    private readonly actions: ContainerActionPolicyService,
    private readonly ipPools: IpPoolsRepository,
    private readonly config: NyabaseConfigService,
    private readonly sshConvergence: ContainerSshConvergenceService,
    @Optional() private readonly volumes?: VolumesService,
    @Optional() private readonly extensions?: ServerCardExtensionRegistry,
    @Optional() private readonly extensionClaims?: ExtensionDeviceClaimsRepository,
  ) {}

  async list(userId: string, filters: { serverId?: string } = {}): Promise<ContainerDto[]> {
    const rows = await this.repository.list({ ownerId: userId, serverId: filters.serverId });
    return this.toDtos(rows);
  }

  async listForAdmin(filters: { serverId?: string } = {}): Promise<ContainerDto[]> {
    return this.toDtos(await this.repository.list(filters));
  }

  async get(containerId: string, userId: string): Promise<ContainerDto> {
    const row = await this.requireContainer(containerId);
    if (row.owner_id !== userId) throw new ForbiddenException('Container is not owned by current user');
    return (await this.toDtos([row]))[0]!;
  }

  async getForAdmin(containerId: string, _actorId: string): Promise<ContainerDto> {
    return (await this.toDtos([await this.requireContainer(containerId)]))[0]!;
  }

  async createForUser(
    userId: string,
    request: CreateContainerRequest,
  ): Promise<IntentAcceptedDto> {
    return this.createInternal(userId, request, false);
  }

  async createForAdmin(
    actorId: string,
    request: CreateContainerRequest,
  ): Promise<IntentAcceptedDto> {
    return this.createInternal(actorId, request, true);
  }

  private async createInternal(
    userId: string,
    request: CreateContainerRequest,
    admin: boolean,
  ): Promise<IntentAcceptedDto> {
    assertContainerName(request.name);
    assertCreateNumbers(request);
    if (admin) {
      if (!request.ownerId) {
        throw new BadRequestException({
          code: FailureCode.InvalidInput,
          message: 'Admin container creation requires ownerId',
        });
      }
    } else if (request.ownerId) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'User container creation cannot specify ownerId',
      });
    }
    const ownerId = admin ? request.ownerId! : userId;
    const requestedExtensions = request.extensions ?? {};
    for (const extensionId of Object.keys(requestedExtensions)) {
      if (!this.extensions?.get(extensionId)) {
        throw new BadRequestException({
          code: FailureCode.ExtensionUnknown,
          message: 'Unknown server-card extension',
          details: { extensionId },
        });
      }
    }
    const id = randomUUID();
    const result = await this.transactions.run(async (transaction) => {
      const server = await transaction.selectFrom('infra.servers')
        .selectAll()
        .where('id', '=', request.serverId)
        .forUpdate()
        .executeTakeFirst() as ServerRow | undefined;
      const nameCollision = await transaction.selectFrom('control.containers')
        .select('id')
        .where('server_id', '=', request.serverId)
        .where('name', '=', request.name)
        .executeTakeFirst();
      if (nameCollision) {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: 'A container with this name already exists on the server',
          details: { serverId: request.serverId, name: request.name },
        });
      }
      const image = await this.lockActiveImage(request.imageId, transaction);
      if (!server) throw new NotFoundException('Server not found');
      if (!image || !image.is_active || image.deleting || !image.fingerprint) {
        throw new ConflictException({
          code: FailureCode.ImageNotAvailable,
          message: 'The image is not active on the target server',
          details: { imageId: request.imageId, serverId: request.serverId },
        });
      }
      // network_managed_externally=true means the guest does not run DHCP/NM;
      // The platform owns networking: IP pool allocation + bridged guest config.
      if (!image.network_managed_externally) {
        throw new ConflictException({
          code: FailureCode.ImageManagesOwnNetwork,
          message: 'The selected image is not marked for platform-managed networking',
          details: { imageId: request.imageId },
        });
      }
      if (admin) {
        const owner = await transaction.selectFrom('iam.users')
          .select(['id', 'status'])
          .where('id', '=', ownerId)
          .executeTakeFirst();
        if (!owner || owner.status !== 'active') {
          throw new NotFoundException('Owner user not found');
        }
      }
      const access = admin
        ? null
        : await this.access.resolveContainerCreateAccessInTransaction(
          transaction,
          userId,
          request.serverId,
          request.imageId,
        );
      if (admin) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          userId,
          [Capability.ManageContainersAny],
        );
      } else if (!access?.imageAvailable) {
        throw new ForbiddenException({
          code: FailureCode.ImageNotAvailable,
          message: 'The image has no active assignment on this server',
          details: { imageId: request.imageId, serverId: request.serverId },
        });
      }
      const assignment = await transaction.selectFrom('infra.image_server_assignments')
        .select(['observed_fingerprint', 'managed_fingerprint', 'lifecycle_phase', 'needs_attention'])
        .where('image_id', '=', request.imageId)
        .where('server_id', '=', request.serverId)
        .where('lifecycle_phase', '=', 'active')
        .executeTakeFirst();
      const assignmentFingerprint = assignment?.observed_fingerprint ?? assignment?.managed_fingerprint;
      if (!assignment || assignment.needs_attention || assignmentFingerprint !== image.fingerprint) {
        throw new ConflictException({
          code: FailureCode.ImageAssignmentFingerprintMismatch,
          message: 'The assigned image fingerprint is not ready on the target server',
          details: {
            imageId: request.imageId,
            serverId: request.serverId,
            expectedFingerprint: image.fingerprint,
          },
        });
      }
      if (!admin && access?.grant.accessPhase !== 'live') {
        throw new ForbiddenException({
          code: FailureCode.PermissionDenied,
          message: 'Server access is in expiry grace',
        });
      }
      if (!admin && access) {
        this.assertComputeGrant(access.grant, request.cpuMillis, request.memBytes);
      }
      if (server.status !== 'online' || server.preflight_status !== 'passed') {
        throw new ConflictException({
          code: FailureCode.PreflightFailed,
          message: 'Server preflight has not passed',
        });
      }
      if (!server.parent_interface) {
        throw new ConflictException({
          code: FailureCode.PreflightFailed,
          message: 'The server has no LAN bridge (parent interface)',
        });
      }
      const pools = await this.ipPools.listForServer(request.serverId, transaction);
      if (pools.length === 0) {
        throw new ConflictException({
          code: FailureCode.IpPoolNotConfigured,
          message: 'The server is not bound to any IP pool',
          details: { serverId: request.serverId },
        });
      }
      const rootPoolId = server.system_pool_id;
      if (!rootPoolId) {
        throw new ConflictException({
          code: FailureCode.StoragePoolExhausted,
          message: 'The server has no system root storage pool',
        });
      }
      const rootPool = await transaction.selectFrom('infra.storage_pools')
        .selectAll()
        .where('id', '=', rootPoolId)
        .where('registered', '=', true)
        .forUpdate()
        .executeTakeFirst();
      if (
        !rootPool
        || rootPool.server_id !== request.serverId
        || !rootPool.root_disk_capable
        || Boolean(rootPool.shared_backend_id)
      ) {
        throw new ConflictException({
          code: FailureCode.StoragePoolExhausted,
          message: 'The server system storage pool is not usable',
        });
      }
      if (rootPool.resize_family === 'quota_online' && rootPool.quota_effective !== true) {
        throw new ConflictException({
          code: FailureCode.StoragePoolQuotaIneffective,
          message: 'The server system storage pool cannot enforce root quotas',
          details: { poolId: rootPoolId },
        });
      }
      const minimum = image.min_root_size_bytes === null
        ? 0
        : numberValue(image.min_root_size_bytes);
      if (request.rootSizeBytes < minimum) {
        throw new ConflictException({
          code: FailureCode.RootSizeBelowImageMinimum,
          message: 'Root size is below the image minimum',
          details: {
            imageId: request.imageId,
            requestedBytes: request.rootSizeBytes,
            minimumBytes: minimum,
          },
        });
      }
      await this.assertRootCapacity(
        transaction,
        ownerId,
        request.serverId,
        rootPoolId,
        request.rootSizeBytes,
        admin ? null : access?.grant.diskBytes ?? null,
      );
      let networkKey: string | null = null;
      let address: string | null = null;
      let lastExhaustedKey: string | null = null;
      for (const pool of pools) {
        try {
          address = await this.repository.findAvailableAddress(
            pool.cidr,
            pool.allocation_cidr,
            [pool.gateway, ...stringArray(pool.reserved_ips)],
            id,
            transaction,
          );
          networkKey = pool.cidr;
          break;
        } catch (error) {
          if (error instanceof Error && error.message === 'No IP address is available') {
            lastExhaustedKey = pool.cidr;
            continue;
          }
          if (error instanceof Error && error.message === 'Invalid IP pool CIDR') {
            throw new ConflictException({
              code: FailureCode.PreflightFailed,
              message: 'The IP pool CIDR is invalid',
              details: { poolId: pool.id, networkKey: pool.cidr },
            });
          }
          throw error;
        }
      }
      if (!networkKey || !address) {
        throw new ConflictException({
          code: FailureCode.NetworkAddressExhausted,
          message: 'No IP address is available in the server IP pools',
          details: { serverId: request.serverId, networkKey: lastExhaustedKey },
        });
      }
      let row = await this.repository.insert({
        id,
        serverId: request.serverId,
        ownerId,
        imageId: request.imageId,
        createdBy: userId,
        name: request.name,
        imageAlias: image.alias,
        imageFingerprint: image.fingerprint,
        rootPoolId,
        rootSizeBytes: request.rootSizeBytes,
        cpuMillis: request.cpuMillis,
        memBytes: request.memBytes,
        extensions: {},
        powerIntent: request.powerIntent,
        networkKey,
        address,
      }, transaction);
      const extensionBag: Record<string, unknown> = {};
      const grantView: ExtensionGrantView = {
        extensionGrants: access?.grant.extensionGrants ?? null,
      };
      for (const ext of this.extensions?.all() ?? []) {
        const enabled = this.extensionClaims
          ? await this.extensionClaims.isEnabled(request.serverId, ext.id, transaction)
          : false;
        const payload = requestedExtensions[ext.id];
        if (!enabled && payload !== undefined) {
          throw new ConflictException({
            code: FailureCode.ExtensionNotEnabled,
            message: 'The server extension is not enabled',
            details: { extensionId: ext.id },
          });
        }
        try {
          const { state } = await ext.admitCreate({
            serverId: request.serverId,
            actor: { userId, admin },
            grant: grantView,
            claims: this.extensionClaims
              ? this.extensionClaims.for(ext.id, request.serverId, id, transaction)
              : {
                replace: async () => undefined,
                listOccupiedKeys: async () => [],
                count: async () => 0,
              },
            health: this.extensionClaims
              ? this.extensionClaims.health(request.serverId, ext.id, transaction)
              : { read: async () => ({}), write: async () => undefined },
            containerId: id,
            payload,
            enabled,
          });
          if (Object.keys(state).length > 0) extensionBag[ext.id] = state;
        } catch (error) {
          if (isUniqueViolation(error, 'extension_device_claims')) throw extensionDeviceClaimed();
          throw error;
        }
      }
      if (Object.keys(extensionBag).length > 0) {
        row = await this.repository.setExtensions(row.id, extensionBag, transaction);
      }
      if (request.volumes && request.volumes.length > 0) {
        if (!this.volumes) {
          throw new ConflictException({
            code: FailureCode.InternalError,
            message: 'Volume binding is unavailable',
          });
        }
        await this.volumes.bindCreateTimeVolumes(
          transaction,
          userId,
          admin ? 'admin' : 'user',
          { id: row.id, owner_id: row.owner_id, server_id: row.server_id },
          request.volumes as AttachVolumeRequest[],
        );
      }
      const intent = await this.intents.createPending({
        kind: IntentKind.ContainerCreate,
        resourceType: IntentResourceType.Container,
        resourceId: row.id,
        serverId: row.server_id,
        requestedBy: userId,
        targetGeneration: row.generation,
        request: { operation: 'create' },
      }, transaction);
      await this.audit.append(transaction, userId, AuditAction.CreateContainer, row.id, 'container', {
        serverId: row.server_id,
        imageId: row.image_id,
      });
      return { row, intent };
    }, { isolationLevel: 'serializable', maxAttempts: 5 });
    this.wake.wake({
      resourceType: IntentResourceType.Container,
      resourceId: result.row.id,
      serverId: result.row.server_id,
      reason: 'intent',
    });
    return acceptedIntent(result.intent);
  }

  action(containerId: string, action: ContainerAction, userId: string): Promise<IntentAcceptedDto> {
    return this.actionInternal(containerId, action, userId, false);
  }

  actionForAdmin(containerId: string, action: ContainerAction, actorId: string): Promise<IntentAcceptedDto> {
    return this.actionInternal(containerId, action, actorId, true);
  }

  /** nyabase-system worker mutations. Skips ManageContainersAny. */
  actionForSystem(containerId: string, action: ContainerAction, actorId: string): Promise<IntentAcceptedDto> {
    return this.actionInternal(containerId, action, actorId, true, false);
  }

  async repairSsh(containerId: string, userId: string): Promise<{ woken: boolean }> {
    const row = await this.requireContainer(containerId);
    if (row.owner_id !== userId) {
      throw new ForbiddenException('Container not found');
    }
    if (row.lifecycle_phase !== 'active') {
      throw new ConflictException({
        code: FailureCode.InvalidInput,
        message: 'SSH repair requires an active container',
      });
    }
    return this.sshConvergence.repairContainer(containerId);
  }

  async repairSshForAdmin(containerId: string, _actorId: string): Promise<{ woken: boolean }> {
    const row = await this.requireContainer(containerId);
    if (row.lifecycle_phase !== 'active') {
      throw new ConflictException({
        code: FailureCode.InvalidInput,
        message: 'SSH repair requires an active container',
      });
    }
    return this.sshConvergence.repairContainer(containerId);
  }

  async updateLimitsForUser(
    containerId: string,
    actorId: string,
    input: PatchContainerLimitsRequest,
  ): Promise<IntentAcceptedDto> {
    return this.updateLimitsInternal(containerId, actorId, input, false);
  }

  async updateLimitsForAdmin(
    containerId: string,
    actorId: string,
    input: PatchContainerLimitsRequest,
  ): Promise<IntentAcceptedDto> {
    return this.updateLimitsInternal(containerId, actorId, input, true);
  }

  private async updateLimitsInternal(
    containerId: string,
    actorId: string,
    input: PatchContainerLimitsRequest,
    admin: boolean,
  ): Promise<IntentAcceptedDto> {
    if (!Number.isSafeInteger(input.cpuMillis) || input.cpuMillis < 0
      || !Number.isSafeInteger(input.memBytes) || input.memBytes < 0) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Container limits must be non-negative safe integers',
      });
    }
    return this.updateDesired(containerId, actorId, admin, {
      cpu_millis: input.cpuMillis,
      mem_bytes: input.memBytes,
    }, { operation: 'limits' }, AuditAction.UpdateContainerLimits, async (transaction, current) => {
      if (admin) return;
      const grant = await this.access.resolveServerInTransaction(transaction, actorId, current.server_id);
      if (!grant || grant.accessPhase !== 'live') throw new ForbiddenException('Server access was revoked');
      this.assertComputeGrant(grant, input.cpuMillis, input.memBytes);
    });
  }

  async resizeRootForUser(
    containerId: string,
    actorId: string,
    input: PatchContainerRootSizeRequest,
  ): Promise<IntentAcceptedDto> {
    return this.resizeRootInternal(containerId, actorId, input, false);
  }

  async resizeRootForAdmin(
    containerId: string,
    actorId: string,
    input: PatchContainerRootSizeRequest,
  ): Promise<IntentAcceptedDto> {
    return this.resizeRootInternal(containerId, actorId, input, true);
  }

  private async resizeRootInternal(
    containerId: string,
    actorId: string,
    input: PatchContainerRootSizeRequest,
    admin: boolean,
  ): Promise<IntentAcceptedDto> {
    const size = input.sizeBytes;
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new BadRequestException({
        code: FailureCode.InvalidInput,
        message: 'Root size must be a positive safe integer',
      });
    }
    return this.updateDesired(
      containerId,
      actorId,
      admin,
      { root_size_bytes: size, root_size_pending_bytes: null },
      { operation: 'root_resize', sizeBytes: size },
      AuditAction.ResizeContainerRoot,
      async (transaction, locked) => {
        if (locked.root_size_pending_bytes !== null) {
          throw new ConflictException({
            code: FailureCode.RootQuotaPending,
            message: 'A previous root quota change is still pending',
            details: { containerId },
          });
        }
        const image = await this.image(locked.image_id, transaction);
        const minimum = image?.min_root_size_bytes === null || image?.min_root_size_bytes === undefined
          ? 0
          : numberValue(image.min_root_size_bytes);
        if (size < minimum) {
          throw new ConflictException({
            code: FailureCode.RootSizeBelowImageMinimum,
            message: 'Root size is below the image minimum',
            details: {
              imageId: locked.image_id,
              requestedBytes: size,
              minimumBytes: minimum,
            },
          });
        }
        const current = numberValue(locked.root_size_bytes);
        if (size >= current) {
          if (size === current) return;
          const resolvedGrant = admin
            ? null
            : await this.access.resolveServerInTransaction(transaction, actorId, locked.server_id);
          if (!admin && (!resolvedGrant || resolvedGrant.accessPhase !== 'live')) {
            throw new ForbiddenException('Server access was revoked');
          }
          await this.assertRootCapacity(
            transaction,
            locked.owner_id,
            locked.server_id,
            locked.root_pool_id,
            size - current,
            resolvedGrant?.diskBytes ?? null,
          );
          return;
        }
        const pool = await transaction.selectFrom('infra.storage_pools')
          .select(['resize_family', 'quota_effective'])
          .where('id', '=', locked.root_pool_id)
          .where('registered', '=', true)
          .forUpdate()
          .executeTakeFirst();
        if (!pool) {
          throw new ConflictException({
            code: FailureCode.StoragePoolExhausted,
            message: 'The root storage pool is no longer usable',
            details: { poolId: locked.root_pool_id },
          });
        }
        if (pool.resize_family === 'quota_online' && pool.quota_effective !== true) {
          throw new ConflictException({
            code: FailureCode.StoragePoolQuotaIneffective,
            message: 'The root storage pool cannot enforce root quotas',
            details: { poolId: locked.root_pool_id },
          });
        }
        if (pool.resize_family === 'block_backed') {
          const route = await this.repository.currentRoute(containerId, transaction);
          if (containerStatus(route?.instance_status, locked.power_intent as ContainerPowerIntent)
            !== ContainerStatus.Stopped) {
            throw new ConflictException({
              code: FailureCode.RootShrinkRequiresStop,
              message: 'Block-backed root shrink requires a stopped container',
              details: { containerId },
            });
          }
        }
      },
    );
  }

  async mutateExtensionForUser(
    containerId: string,
    actorId: string,
    extensionId: string,
    payload: unknown,
  ): Promise<IntentAcceptedDto> {
    return this.mutateExtensionInternal(containerId, actorId, extensionId, payload, false);
  }

  async mutateExtensionForAdmin(
    containerId: string,
    actorId: string,
    extensionId: string,
    payload: unknown,
  ): Promise<IntentAcceptedDto> {
    return this.mutateExtensionInternal(containerId, actorId, extensionId, payload, true);
  }

  private async mutateExtensionInternal(
    containerId: string,
    actorId: string,
    extensionId: string,
    payload: unknown,
    admin: boolean,
  ): Promise<IntentAcceptedDto> {
    const ext = this.extensions?.get(extensionId);
    if (!ext) {
      throw new NotFoundException({
        code: FailureCode.ExtensionUnknown,
        message: 'Unknown server-card extension',
        details: { extensionId },
      });
    }
    return this.transactions.run(async (transaction) => {
      const current = await this.repository.lock(containerId, transaction);
      if (!current || (!admin && current.owner_id !== actorId)) throw new NotFoundException('Container not found');
      if (current.lifecycle_phase === ContainerPhase.Deleting) {
        throw new ConflictException({
          code: FailureCode.InstanceBusy,
          message: 'A deleting container cannot be modified',
        });
      }
      if (admin) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageContainersAny],
        );
      }
      const enabled = this.extensionClaims
        ? await this.extensionClaims.isEnabled(current.server_id, extensionId, transaction)
        : false;
      if (!enabled) {
        throw new ConflictException({
          code: FailureCode.ExtensionNotEnabled,
          message: 'The server extension is not enabled',
          details: { extensionId },
        });
      }
      const route = await this.repository.currentRoute(containerId, transaction);
      const observedStatus = containerStatus(
        route?.instance_status,
        current.power_intent as ContainerPowerIntent,
      );
      let grantView: ExtensionGrantView = { extensionGrants: null };
      if (!admin) {
        const grant = await this.access.resolveServerInTransaction(transaction, actorId, current.server_id);
        if (!grant || grant.accessPhase !== 'live') throw new ForbiddenException('Server access was revoked');
        grantView = { extensionGrants: grant.extensionGrants };
      }
      const currentExtensions = asJsonObject(current.extensions);
      let mutated;
      try {
        mutated = await ext.mutateContainer({
          serverId: current.server_id,
          actor: { userId: actorId, admin },
          grant: grantView,
          claims: this.extensionClaims
            ? this.extensionClaims.for(extensionId, current.server_id, containerId, transaction)
            : {
              replace: async () => undefined,
              listOccupiedKeys: async () => [],
              count: async () => 0,
            },
          health: this.extensionClaims
            ? this.extensionClaims.health(current.server_id, extensionId, transaction)
            : { read: async () => ({}), write: async () => undefined },
          containerId,
          lifecyclePhase: current.lifecycle_phase,
          powerIntent: current.power_intent,
          observedStatus: observedStatus === 'creating' ? 'unknown' : observedStatus,
          currentExtensions,
          payload,
          enabled,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'extension_device_claims')) throw extensionDeviceClaimed();
        throw error;
      }
      const nextBag = { ...currentExtensions };
      if (Object.keys(mutated.state).length === 0) delete nextBag[extensionId];
      else nextBag[extensionId] = mutated.state;
      const updated = await this.repository.updateDesired(
        containerId,
        current.generation,
        { extensions: nextBag },
        transaction,
      );
      if (!updated) throw new ConflictException({ code: FailureCode.RevisionConflict });
      const intent = await this.intents.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId: containerId,
        serverId: current.server_id,
        requestedBy: actorId,
        targetGeneration: updated.generation,
        request: mutated.requestSummary,
      }, transaction);
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.UpdateContainerExtension,
        containerId,
        'container',
        { extensionId, ...mutated.requestSummary },
      );
      return { intent, serverId: current.server_id };
    }, { isolationLevel: 'serializable', maxAttempts: 5 }).then((result) => {
      this.wake.wake({
        resourceType: IntentResourceType.Container,
        resourceId: containerId,
        serverId: result.serverId,
        reason: 'intent',
      });
      return acceptedIntent(result.intent);
    });
  }

  async listVolumesForUser(containerId: string, actorId: string): Promise<VolumeAttachmentDto[]> {
    const row = await this.requireContainer(containerId);
    if (row.owner_id !== actorId) throw new ForbiddenException();
    if (this.volumes) return this.volumes.listAttachmentsForUser(actorId, containerId, 'local');
    return this.listVolumeAttachments(containerId, row.server_id, 'local');
  }

  async listVolumesForAdmin(containerId: string): Promise<VolumeAttachmentDto[]> {
    const row = await this.requireContainer(containerId);
    if (this.volumes) return this.volumes.listAttachmentsForAdmin(containerId, 'local');
    return this.listVolumeAttachments(containerId, row.server_id, 'local');
  }

  async listSharedVolumesForUser(containerId: string, actorId: string): Promise<VolumeAttachmentDto[]> {
    const row = await this.requireContainer(containerId);
    if (row.owner_id !== actorId) throw new ForbiddenException();
    if (this.volumes) return this.volumes.listAttachmentsForUser(actorId, containerId, 'shared');
    return this.listVolumeAttachments(containerId, row.server_id, 'shared');
  }

  async listSharedVolumesForAdmin(containerId: string): Promise<VolumeAttachmentDto[]> {
    const row = await this.requireContainer(containerId);
    if (this.volumes) return this.volumes.listAttachmentsForAdmin(containerId, 'shared');
    return this.listVolumeAttachments(containerId, row.server_id, 'shared');
  }

  private async listVolumeAttachments(
    containerId: string,
    serverId: string,
    kind: 'local' | 'shared',
  ): Promise<VolumeAttachmentDto[]> {
    const attachments = await this.database.selectFrom('control.volume_attachments as attachment')
      .innerJoin('control.volumes as volume', 'volume.id', 'attachment.volume_id')
      .leftJoin('control.volume_placements as placement', (join) => join
        .onRef('placement.volume_id', '=', 'attachment.volume_id')
        .on('placement.server_id', '=', serverId))
      .selectAll('attachment')
      .select([
        'volume.name as volume_name',
        'volume.shared_backend_id as shared_backend_id',
        'placement.catalog_state as catalog_state',
      ])
      .where('attachment.container_id', '=', containerId)
      .orderBy('attachment.created_at')
      .execute();
    return attachments
      .filter((attachment) => (
        kind === 'shared' ? attachment.shared_backend_id !== null : attachment.shared_backend_id === null
      ))
      .map((attachment) => this.toAttachmentDto(attachment, attachment.volume_name, {
        kind,
        catalogState: attachment.catalog_state,
      }));
  }

  async getStats(containerId: string, userId: string) {
    const row = await this.requireContainer(containerId);
    if (row.owner_id !== userId) throw new ForbiddenException();
    return this.stats(row);
  }

  async getStatsForAdmin(containerId: string, _actorId: string) {
    return this.stats(await this.requireContainer(containerId));
  }

  async createExecSession(
    containerId: string,
    userId: string,
    _authVersion: number,
    request: CreateExecSessionRequest,
  ) {
    return this.execSession(containerId, userId, _authVersion, false, request);
  }

  async createExecSessionForAdmin(
    containerId: string,
    actorId: string,
    _authVersion: number,
    request: CreateExecSessionRequest,
  ) {
    return this.execSession(containerId, actorId, _authVersion, true, request);
  }

  private async execSession(
    containerId: string,
    actorId: string,
    authVersion: number,
    admin: boolean,
    request: CreateExecSessionRequest,
  ): Promise<{ sessionId: string; consoleUrl: string; expiresAt: string }> {
    const row = await this.requireContainer(containerId);
    if (!admin && row.owner_id !== actorId) throw new ForbiddenException();
    await this.transactions.run(async (transaction) => {
      const current = await this.repository.lock(containerId, transaction);
      if (!current || (!admin && current.owner_id !== actorId)) {
        throw new NotFoundException('Container not found');
      }
      if (admin) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageContainersAny],
        );
      } else {
        const grant = await this.access.resolveServerInTransaction(transaction, actorId, current.server_id);
        if (!grant || grant.accessPhase !== 'live') throw new ForbiddenException();
      }
      const currentRoute = await this.repository.currentRoute(containerId, transaction);
      if (
        containerStatus(currentRoute?.instance_status, current.power_intent as ContainerPowerIntent)
        !== ContainerStatus.Running
      ) {
        throw new ConflictException({ code: FailureCode.InstanceBusy, message: 'Container is not running' });
      }
      return currentRoute;
    });
    const session = await this.consoleSessions.create(
      actorId,
      authVersion,
      containerId,
      request,
      admin,
    );
    try {
      await this.transactions.run(async (transaction) => {
        await this.audit.append(transaction, actorId, AuditAction.CreateExecSession, containerId, 'container', {
          tty: request.tty,
          cols: request.cols,
          rows: request.rows,
        });
      });
    } catch (error) {
      await this.consoleSessions.release(session.sessionId);
      throw error;
    }
    return session;
  }

  private async actionInternal(
    containerId: string,
    action: ContainerAction,
    actorId: string,
    admin: boolean,
    requireCapability = admin,
  ): Promise<IntentAcceptedDto> {
    const result = await this.transactions.run(async (transaction) => {
      const current = await this.repository.lock(containerId, transaction);
      if (!current) throw new NotFoundException('Container not found');
      if (!admin && current.owner_id !== actorId) throw new ForbiddenException();
      if (admin && requireCapability) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageContainersAny],
        );
      } else if (!admin) {
        const grant = await this.access.resolveServerInTransaction(transaction, actorId, current.server_id);
        if (!grant || grant.accessPhase !== 'live') {
          throw new ForbiddenException('Server access was revoked');
        }
      }
      if (action !== 'delete' && current.lifecycle_phase === ContainerPhase.Deleting) {
        throw new ConflictException({
          code: FailureCode.InstanceBusy,
          message: 'A deleting container cannot receive power actions',
        });
      }
      const route = action === 'restart'
        ? await this.repository.currentRoute(containerId, transaction)
        : undefined;
      if (action === 'restart'
        && containerStatus(route?.instance_status, current.power_intent as ContainerPowerIntent)
          !== ContainerStatus.Running) {
        throw new ConflictException({
          code: FailureCode.InstanceBusy,
          message: 'Restart requires a running container',
        });
      }
      if (action === 'start' || action === 'restart') {
        const detaching = await transaction.selectFrom('control.volume_attachments')
          .select('id')
          .where('container_id', '=', containerId)
          .where('bind_state', '=', 'detaching')
          .executeTakeFirst();
        if (detaching) {
          throw new ConflictException({
            code: FailureCode.InstanceBusy,
            message: '等待卸载完成后再启动',
            details: { containerId, attachmentId: detaching.id },
          });
        }
      }
      const nextPhase = action === 'delete' ? ContainerPhase.Deleting : current.lifecycle_phase;
      const nextPower = action === 'stop'
        ? ContainerPowerIntent.Stopped
        : action === 'start' || action === 'restart'
          ? ContainerPowerIntent.Running
          : ContainerPowerIntent.Stopped;
      const updated = await this.repository.updateDesired(
        containerId,
        Number(current.generation),
        { lifecycle_phase: nextPhase, power_intent: nextPower, failure_code: null, failure_reason: null },
        transaction,
      );
      if (!updated) throw new ConflictException({ code: FailureCode.RevisionConflict });
      if (nextPhase === ContainerPhase.Deleting || nextPhase === ContainerPhase.Failed) {
        await this.extensionClaims?.releaseContainerClaims(containerId, transaction);
      }
      const kind = action === 'delete'
        ? IntentKind.ContainerDelete
        : action === 'restart' || action === 'start' || action === 'stop'
          ? IntentKind.ContainerPower
          : IntentKind.ContainerUpdate;
      const intent = await this.intents.createPending({
        kind,
        resourceType: IntentResourceType.Container,
        resourceId: containerId,
        serverId: current.server_id,
        requestedBy: actorId,
        targetGeneration: updated.generation,
        baseline: action === 'restart'
          ? {
            startedAt: route?.instance_started_at
              ? new Date(route.instance_started_at).toISOString()
              : null,
          }
          : undefined,
        request: { action, operation: action },
      }, transaction);
      await this.audit.append(transaction, actorId, this.auditAction(action), containerId, 'container');
      return { intent, serverId: current.server_id };
    }, {
      // Expiry/system stops must not lose to concurrent reconcile observation writes.
      isolationLevel: requireCapability ? 'serializable' : 'read committed',
      maxAttempts: 5,
    });
    this.wake.wake({
      resourceType: IntentResourceType.Container,
      resourceId: containerId,
      serverId: result.serverId,
      reason: 'intent',
    });
    return acceptedIntent(result.intent);
  }

  private async updateDesired(
    containerId: string,
    actorId: string,
    admin: boolean,
    values: Parameters<ContainerControlRepository['updateDesired']>[2],
    request: Record<string, unknown>,
    action: AuditAction,
    validate?: (
      transaction: Transaction<NyabaseDatabase>,
      current: ContainerRow,
    ) => Promise<void>,
  ): Promise<IntentAcceptedDto> {
    const result = await this.transactions.run(async (transaction) => {
      const current = await this.repository.lock(containerId, transaction);
      if (!current || (!admin && current.owner_id !== actorId)) throw new NotFoundException('Container not found');
      if (current.lifecycle_phase === ContainerPhase.Deleting) {
        throw new ConflictException({
          code: FailureCode.InstanceBusy,
          message: 'A deleting container cannot be modified',
        });
      }
      if (admin) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageContainersAny],
        );
      } else {
        const grant = await this.access.resolveServerInTransaction(transaction, actorId, current.server_id);
        if (!grant || grant.accessPhase !== 'live') {
          throw new ForbiddenException('Server access was revoked');
        }
      }
      await validate?.(transaction, current);
      const updated = await this.repository.updateDesired(
        containerId,
        current.generation,
        values,
        transaction,
      );
      if (!updated) throw new ConflictException({ code: FailureCode.RevisionConflict });
      if (values.lifecycle_phase === ContainerPhase.Deleting
        || values.lifecycle_phase === ContainerPhase.Failed) {
        await this.extensionClaims?.releaseContainerClaims(containerId, transaction);
      }
      const intent = await this.intents.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId: containerId,
        serverId: current.server_id,
        requestedBy: actorId,
        targetGeneration: updated.generation,
        request,
      }, transaction);
      await this.audit.append(transaction, actorId, action, containerId, 'container', request);
      return { intent, serverId: current.server_id };
    }, { isolationLevel: 'serializable', maxAttempts: 5 });
    this.wake.wake({
      resourceType: IntentResourceType.Container,
      resourceId: containerId,
      serverId: result.serverId,
      reason: 'intent',
    });
    return acceptedIntent(result.intent);
  }

  private async assertRootCapacity(
    transaction: Transaction<NyabaseDatabase>,
    ownerId: string,
    serverId: string,
    poolId: string,
    delta: number,
    grantLimit: number | null,
  ): Promise<void> {
    if (delta <= 0) return;
    await transaction.selectFrom('infra.servers')
      .select('id')
      .where('id', '=', serverId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const roots = await transaction.selectFrom('control.containers')
      .select(sql<string>`coalesce(sum(
        case when root_size_pending_bytes is null
          then root_size_bytes
          else greatest(root_size_bytes, root_size_pending_bytes)
        end
      ), 0)`.as('bytes'))
      .where('owner_id', '=', ownerId)
      .where('server_id', '=', serverId)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .executeTakeFirstOrThrow();
    const volumes = await transaction.selectFrom('control.volumes')
      .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('bytes'))
      .where('owner_id', '=', ownerId)
      .where('server_id', '=', serverId)
      .where('shared_backend_id', 'is', null)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .executeTakeFirstOrThrow();
    const used = numberValue(roots.bytes) + numberValue(volumes.bytes);
    if (grantLimit !== null && grantLimit > 0 && used + delta > grantLimit) {
      throw new ConflictException({
        code: FailureCode.StorageGrantExceeded,
        message: 'Server storage grant exceeded',
        details: {
          requestedBytes: delta,
          availableBytes: Math.max(0, grantLimit - used),
          grantLimitBytes: grantLimit,
        },
      });
    }
    const pool = await transaction.selectFrom('infra.storage_pools')
      .select(['total_bytes'])
      .where('id', '=', poolId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (pool.total_bytes === null) return;
    const committed = await transaction.selectFrom('control.containers')
      .select(sql<string>`coalesce(sum(
        case when root_size_pending_bytes is null
          then root_size_bytes
          else greatest(root_size_bytes, root_size_pending_bytes)
        end
      ), 0)`.as('bytes'))
      .where('root_pool_id', '=', poolId)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .executeTakeFirstOrThrow();
    const committedVolumes = await transaction.selectFrom('control.volumes')
      .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('bytes'))
      .where('pool_id', '=', poolId)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .executeTakeFirstOrThrow();
    const server = await transaction.selectFrom('infra.servers')
      .select('storage_overcommit_ratio')
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    if (
      numberValue(committed.bytes) + numberValue(committedVolumes.bytes) + delta
      > numberValue(pool.total_bytes) * numberValue(server.storage_overcommit_ratio)
    ) {
      throw new ConflictException({
        code: FailureCode.StoragePoolExhausted,
        message: 'Storage pool capacity exceeded',
        details: {
          poolId,
          requestedBytes: delta,
          availableBytes: Math.max(
            0,
            numberValue(pool.total_bytes) * numberValue(server.storage_overcommit_ratio)
              - numberValue(committed.bytes) - numberValue(committedVolumes.bytes),
          ),
          overcommitRatio: numberValue(server.storage_overcommit_ratio),
        },
      });
    }
  }

  private assertComputeGrant(
    grant: { cpuMillis: number | null; memBytes: number | null },
    cpuMillis: number,
    memBytes: number,
  ): void {
    if (grant.cpuMillis !== null && cpuMillis > grant.cpuMillis) {
      throw new ForbiddenException({
        code: FailureCode.PermissionDenied,
        message: 'The requested CPU exceeds the server grant',
        details: { requestedCpuMillis: cpuMillis, grantCpuMillis: grant.cpuMillis },
      });
    }
    if (grant.memBytes !== null && memBytes > grant.memBytes) {
      throw new ForbiddenException({
        code: FailureCode.PermissionDenied,
        message: 'The requested memory exceeds the server grant',
        details: { requestedMemBytes: memBytes, grantMemBytes: grant.memBytes },
      });
    }
  }

  private async toDtos(rows: readonly ContainerRow[]): Promise<ContainerDto[]> {
    if (rows.length === 0) return [];
    const servers = new Map<string, ServerRow>();
    const images = new Map<string, ImageRow>();
    const routes = new Map<string, Awaited<ReturnType<ContainerControlRepository['routes']>>[number]>();
    const serverIds = [...new Set(rows.map((row) => row.server_id))];
    const imageIds = [...new Set(rows.map((row) => row.image_id))];
    const [serverRows, imageRows, routeRows] = await Promise.all([
      this.database.selectFrom('infra.servers').selectAll().where('id', 'in', serverIds).execute(),
      this.database.selectFrom('infra.images').selectAll().where('id', 'in', imageIds).execute(),
      this.repository.routes(rows.map((row) => row.id)),
    ]);
    const pendingRows = await this.database.selectFrom('control.intents')
      .select('resource_id')
      .where('resource_type', '=', IntentResourceType.Container)
      .where('resource_id', 'in', rows.map((row) => row.id))
      .where('status', '=', 'pending')
      .execute();
    const pending = new Set(pendingRows.map((item) => item.resource_id));
    for (const server of serverRows) servers.set(server.id, server);
    for (const image of imageRows) images.set(image.id, image);
    for (const route of routeRows) routes.set(route.containerId, route);
    const attachments = await this.database.selectFrom('control.volume_attachments as attachment')
      .innerJoin('control.volumes as volume', 'volume.id', 'attachment.volume_id')
      .leftJoin('control.containers as container', 'container.id', 'attachment.container_id')
      .leftJoin('control.volume_placements as placement', (join) => join
        .onRef('placement.volume_id', '=', 'attachment.volume_id')
        .onRef('placement.server_id', '=', 'container.server_id'))
      .selectAll('attachment')
      .select([
        'volume.name as volume_name',
        'volume.shared_backend_id as shared_backend_id',
        'placement.catalog_state as catalog_state',
      ])
      .where('attachment.container_id', 'in', rows.map((row) => row.id))
      .orderBy('attachment.created_at')
      .execute();
    const attachmentsByContainer = new Map<string, VolumeAttachmentDto[]>();
    const sharedByContainer = new Map<string, VolumeAttachmentDto[]>();
    for (const attachment of attachments) {
      const kind = attachment.shared_backend_id !== null ? 'shared' : 'local';
      const dto = this.toAttachmentDto(attachment, attachment.volume_name, {
        kind,
        catalogState: attachment.catalog_state,
      });
      const target = kind === 'shared' ? sharedByContainer : attachmentsByContainer;
      const list = target.get(attachment.container_id) ?? [];
      list.push(dto);
      target.set(attachment.container_id, list);
    }
    const owners = new Map<string, string>();
    const ownerIds = [...new Set(rows.map((row) => row.owner_id))];
    if (ownerIds.length > 0) {
      const ownerRows = await this.database.selectFrom('iam.users')
        .select(['id', 'username'])
        .where('id', 'in', ownerIds)
        .execute();
      for (const owner of ownerRows) owners.set(owner.id, owner.username);
    }
    const poolIds = [...new Set(rows.map((row) => row.root_pool_id))];
    const poolRows = poolIds.length === 0
      ? []
      : await this.database.selectFrom('infra.storage_pools')
        .select([
          'id',
          'display_name',
          'incus_name',
          'resize_family',
          'quota_effective',
          'block_filesystem',
        ])
        .where('id', 'in', poolIds)
        .execute();
    const pools = new Map(poolRows.map((pool) => [pool.id, pool]));
    return rows.map((row) => {
      const server = servers.get(row.server_id);
      const image = images.get(row.image_id);
      const route = routes.get(row.id);
      const pool = pools.get(row.root_pool_id);
      const actualStatus = containerStatus(route?.runtimeStatus, row.power_intent as ContainerPowerIntent);
      const proxyHost = this.config.get<string>('ssh.proxyPublicHost')?.trim() || null;
      const proxyPort = this.config.get<number>('ssh.proxyPublicPort') || null;
      return {
        id: row.id,
        serverId: row.server_id,
        serverName: server?.name ?? row.server_id,
        ownerId: row.owner_id,
        ownerName: owners.get(row.owner_id),
        name: row.name,
        instanceName: route?.instanceName ?? row.instance_name,
        imageId: row.image_id,
        imageName: image?.name,
        imageFingerprint: row.image_fingerprint,
        rootPoolId: row.root_pool_id,
        rootPoolName: pool ? poolLabel(pool.display_name, pool.incus_name) : row.root_pool_id,
        rootSizeBytes: numberValue(row.root_size_bytes),
        rootSizePendingBytes: row.root_size_pending_bytes === null
          ? null
          : numberValue(row.root_size_pending_bytes),
        rootUsedBytes: nullableNumber(row.root_used_bytes),
        rootCapability: pool
          ? storagePoolCapability(
            pool.resize_family as StoragePoolResizeFamily,
            pool.quota_effective,
            pool.block_filesystem,
          )
          : missingStoragePoolCapability(),
        cpuMillis: row.cpu_millis,
        memBytes: numberValue(row.mem_bytes),
        extensions: asJsonObject(row.extensions),
        powerIntent: row.power_intent as ContainerPowerIntent,
        lifecyclePhase: phase(row.lifecycle_phase),
        routedIp: route?.routedIp ?? null,
        actual: {
          instanceName: route?.instanceName ?? row.instance_name,
          status: actualStatus,
          routedIp: route?.routedIp ?? null,
          observedAt: date(route?.observedAt),
        },
        ssh: {
          enabled: true,
          status: route?.sshStatus ?? 'unknown',
          ready: route?.sshStatus === 'running' && actualStatus === ContainerStatus.Running,
          loginUser: image?.login_user ?? 'root',
          proxyHost,
          proxyPort,
          hostKeyFingerprint: route?.containerHostKeyFingerprint ?? null,
          observedAt: date(route?.observedAt),
          lastError: route?.lastError ?? null,
        },
        volumes: attachmentsByContainer.get(row.id) ?? [],
        sharedVolumes: sharedByContainer.get(row.id) ?? [],
        needsAttention: row.needs_attention,
        failureCode: row.failure_code,
        failureReason: row.failure_reason,
        generation: row.generation,
        observedGeneration: row.observed_generation,
        actions: this.actions.forContainer({
          phase: phase(row.lifecycle_phase),
          runtimeStatus: actualStatus,
          runtimeReady: server?.status === 'online',
          intentPending: pending.has(row.id),
          sshEnabled: true,
        }),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    });
  }

  private async stats(row: ContainerRow): Promise<{
    containerId: string;
    stats: null;
    ts: number;
    lastObservedAt: string;
  }> {
    const route = await this.repository.currentRoute(row.id);
    const observedAt = route?.observed_at ? new Date(route.observed_at) : new Date();
    return {
      containerId: row.id,
      stats: null,
      ts: observedAt.getTime(),
      lastObservedAt: observedAt.toISOString(),
    };
  }

  private async requireContainer(id: string): Promise<ContainerRow> {
    const row = await this.repository.find(id);
    if (!row) throw new NotFoundException('Container not found');
    return row;
  }

  private server(id: string, executor: ContainerExecutor = this.database): Promise<ServerRow | undefined> {
    return executor.selectFrom('infra.servers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst() as Promise<ServerRow | undefined>;
  }

  private image(id: string, transaction: Transaction<NyabaseDatabase>): Promise<ImageRow | undefined> {
    return transaction.selectFrom('infra.images')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst() as Promise<ImageRow | undefined>;
  }

  private lockActiveImage(
    id: string,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<ImageRow | undefined> {
    return transaction.selectFrom('infra.images')
      .selectAll()
      .where('id', '=', id)
      .where('is_active', '=', true)
      .where('deleting', '=', false)
      .forUpdate()
      .executeTakeFirst() as Promise<ImageRow | undefined>;
  }

  private auditAction(action: ContainerAction): AuditAction {
    switch (action) {
      case 'start': return AuditAction.StartContainer;
      case 'stop': return AuditAction.StopContainer;
      case 'restart': return AuditAction.RestartContainer;
      case 'delete': return AuditAction.DeleteContainer;
    }
  }

  private toAttachmentDto(
    attachment: {
      id: string;
      container_id: string;
      volume_id: string;
      device_name: string;
      container_path: string;
      read_only: boolean;
      bind_state: VolumeAttachmentDto['bindState'];
      created_at: Date | string;
      updated_at: Date | string;
    },
    volumeName: string,
    extra: { kind: 'local' | 'shared'; catalogState: string | null },
  ): VolumeAttachmentDto {
    return {
      id: attachment.id,
      containerId: attachment.container_id,
      volumeId: attachment.volume_id,
      volumeName,
      deviceName: attachment.device_name,
      containerPath: attachment.container_path,
      readOnly: attachment.read_only,
      bindState: attachment.bind_state,
      kind: extra.kind,
      onlineCancelAllowed: extra.catalogState !== 'present' && attachment.bind_state === 'attaching',
      createdAt: new Date(attachment.created_at).toISOString(),
      updatedAt: new Date(attachment.updated_at).toISOString(),
    };
  }
}
