import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  FailureCode,
  IntentKind,
  IntentResourceType,
  type AttachVolumeRequest,
  type CreateContainerRequest,
} from '@nyabase/common';
import { sql, type Transaction } from 'kysely';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import type { Actor } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import { admitGpuCreate } from '../gpu/admit.js';
import { GpuClaimsRepository } from '../gpu/gpu-claims.repository.js';
import { IpPoolsRepository } from '../ip-pools/ip-pools.repository.js';
import { numberValue } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { VolumeAttachmentsService } from '../volumes/volume-attachments.service.js';
import {
  ContainerControlRepository,
  type ImageRow,
  type ServerRow,
} from './container-control.repository.js';
import {
  assertComputeGrant,
  createContainerIntent,
  gpuDeviceClaimed,
  isUniqueViolation,
  stringArray,
} from './container-rules.js';

type Tx = Transaction<NyabaseDatabase>;

type CreateAccess = NonNullable<
  Awaited<ReturnType<AccessResolverService['resolveContainerCreateAccessInTransaction']>>
>;

/**
 * Admission check for growing root-disk commitments: the owner's server
 * storage grant, then the pool's overcommitted capacity. Locks the server and
 * pool rows so concurrent admissions serialise.
 */
export async function assertRootCapacity(
  repository: ContainerControlRepository,
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
  // Custom volumes belong to the volumes module; only their committed size is read here.
  const sumVolumes = async (filter: { ownerId?: string; serverId?: string; poolId?: string }) => {
    let query = transaction.selectFrom('control.volumes')
      .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('bytes'))
      .where('lifecycle_phase', 'not in', ['failed', 'deleting']);
    if (filter.ownerId !== undefined) query = query.where('owner_id', '=', filter.ownerId);
    if (filter.serverId !== undefined) {
      query = query.where('server_id', '=', filter.serverId).where('shared_backend_id', 'is', null);
    }
    if (filter.poolId !== undefined) query = query.where('pool_id', '=', filter.poolId);
    return numberValue((await query.executeTakeFirstOrThrow()).bytes);
  };
  const used = await repository.sumLiveRootBytes({ ownerId, serverId }, transaction)
    + await sumVolumes({ ownerId, serverId });
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
  const committed = await repository.sumLiveRootBytes({ poolId }, transaction)
    + await sumVolumes({ poolId });
  const server = await transaction.selectFrom('infra.servers')
    .select('storage_overcommit_ratio')
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
  const capacity = numberValue(pool.total_bytes) * numberValue(server.storage_overcommit_ratio);
  if (committed + delta > capacity) {
    throw new ConflictException({
      code: FailureCode.StoragePoolExhausted,
      message: 'Storage pool capacity exceeded',
      details: {
        poolId,
        requestedBytes: delta,
        availableBytes: Math.max(0, capacity - committed),
        overcommitRatio: numberValue(server.storage_overcommit_ratio),
      },
    });
  }
}

@Injectable()
export class ContainerCreateService {
  constructor(
    private readonly repository: ContainerControlRepository,
    private readonly access: AccessResolverService,
    private readonly intents: IntentRepository,
    private readonly audit: AuditService,
    private readonly ipPools: IpPoolsRepository,
    private readonly volumes: VolumeAttachmentsService,
    private readonly gpuClaims: GpuClaimsRepository,
  ) {}

  /** The active, non-deleting image row, locked for the rest of the transaction. */
  private lockActiveImage(transaction: Tx, id: string): Promise<ImageRow | undefined> {
    return transaction.selectFrom('infra.images')
      .selectAll()
      .where('id', '=', id)
      .where('is_active', '=', true)
      .where('deleting', '=', false)
      .forUpdate()
      .executeTakeFirst() as Promise<ImageRow | undefined>;
  }

  /** Lock the target server and image and refuse a missing, duplicate-named or unavailable target. */
  private async lockCreateTargets(
    transaction: Tx,
    request: CreateContainerRequest,
  ): Promise<{ server: ServerRow; image: ImageRow & { fingerprint: string } }> {
    const server = await transaction.selectFrom('infra.servers')
      .selectAll()
      .where('id', '=', request.serverId)
      .forUpdate()
      .executeTakeFirst() as ServerRow | undefined;
    if (await this.repository.nameTaken(request.serverId, request.name, transaction)) {
      throw new ConflictException({
        code: FailureCode.InvalidInput,
        message: 'A container with this name already exists on the server',
        details: { serverId: request.serverId, name: request.name },
      });
    }
    const image = await this.lockActiveImage(transaction, request.imageId);
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
    return { server, image: image as ImageRow & { fingerprint: string } };
  }

  /** The user's live access to the server and image, and a ready image assignment on that server. */
  private async resolveCreateAccess(
    transaction: Tx,
    userId: string,
    request: CreateContainerRequest,
    image: ImageRow & { fingerprint: string },
  ): Promise<CreateAccess> {
    const access = await this.access.resolveContainerCreateAccessInTransaction(
      transaction,
      userId,
      request.serverId,
      request.imageId,
    );
    if (!access) {
      throw new ForbiddenException({
        code: FailureCode.PermissionDenied,
        message: 'The user has no current access to this server',
        details: { serverId: request.serverId },
      });
    }
    if (!access.imageAvailable) {
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
    return access;
  }

  private assertServerReady(server: ServerRow): void {
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
  }

  /** The server's system pool, locked, when it can host a root disk of this image. */
  private async lockRootPool(
    transaction: Tx,
    server: ServerRow,
    request: CreateContainerRequest,
    image: ImageRow,
  ): Promise<string> {
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
    return rootPoolId;
  }

  /** First free address across the server's IP pools. */
  private async allocateAddress(
    transaction: Tx,
    serverId: string,
    containerId: string,
    pools: Awaited<ReturnType<IpPoolsRepository['listForServer']>>,
  ): Promise<{ networkKey: string; address: string }> {
    let lastExhaustedKey: string | null = null;
    for (const pool of pools) {
      try {
        const address = await this.repository.findAvailableAddress(
          pool.cidr,
          pool.allocation_cidr,
          [pool.gateway, ...stringArray(pool.reserved_ips)],
          containerId,
          transaction,
        );
        return { networkKey: pool.cidr, address };
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
    throw new ConflictException({
      code: FailureCode.NetworkAddressExhausted,
      message: 'No IP address is available in the server IP pools',
      details: { serverId, networkKey: lastExhaustedKey },
    });
  }

  /**
   * Admit a new container inside the caller's serializable transaction: validate
   * the target and the user's access, reserve storage and an address, insert the
   * row (with GPU claims and create-time volumes) and queue the create intent.
   */
  async admit(
    transaction: Tx,
    actor: Actor,
    request: CreateContainerRequest,
    id: string,
  ) {
    const userId = actor.userId;
    const ownerId = userId;
    const { server, image } = await this.lockCreateTargets(transaction, request);
    const access = await this.resolveCreateAccess(transaction, userId, request, image);
    assertComputeGrant(access.grant, request.cpuMillis, request.memBytes);
    this.assertServerReady(server);
    const pools = await this.ipPools.listForServer(request.serverId, transaction);
    if (pools.length === 0) {
      throw new ConflictException({
        code: FailureCode.IpPoolNotConfigured,
        message: 'The server is not bound to any IP pool',
        details: { serverId: request.serverId },
      });
    }
    const rootPoolId = await this.lockRootPool(transaction, server, request, image);
    await assertRootCapacity(
      this.repository,
      transaction,
      ownerId,
      request.serverId,
      rootPoolId,
      request.rootSizeBytes,
      access.grant.diskBytes ?? null,
    );
    const { networkKey, address } = await this.allocateAddress(
      transaction,
      request.serverId,
      id,
      pools,
    );
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
      powerIntent: request.powerIntent,
      networkKey,
      address,
    }, transaction);
    const gpuEnabled = await this.gpuClaims.isEnabled(request.serverId, transaction);
    try {
      const { state } = await admitGpuCreate({
        serverId: request.serverId,
        actor: { userId, admin: false },
        grantPciAddresses: access.grant.gpuPciAddresses ?? [],
        claims: this.gpuClaims.forContainer(request.serverId, id, transaction),
        health: this.gpuClaims.health(request.serverId, transaction),
        containerId: id,
        requestedPciAddresses: request.gpuPciAddresses,
        enabled: gpuEnabled,
      });
      if (state) row = await this.repository.setGpuState(row.id, state, transaction);
    } catch (error) {
      if (isUniqueViolation(error, 'container_gpu_claims')) throw gpuDeviceClaimed();
      throw error;
    }
    if (request.volumes && request.volumes.length > 0) {
      await this.volumes.bindCreateTimeVolumes(
        transaction,
        actor,
        { id: row.id, owner_id: row.owner_id, server_id: row.server_id },
        request.volumes as AttachVolumeRequest[],
      );
    }
    const intent = await createContainerIntent(this.intents, {
      kind: IntentKind.ContainerCreate,
      resourceType: IntentResourceType.Container,
      resourceId: row.id,
      serverId: row.server_id,
      requestedBy: userId,
      targetRevision: row.revision,
      request: { operation: 'create' },
    }, transaction);
    await this.audit.append(transaction, userId, AuditAction.CreateContainer, row.id, 'container', {
      serverId: row.server_id,
      imageId: row.image_id,
    });
    return { row, intent };
  }
}
