import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  ContainerPowerIntent,
  FailureCode,
  IntentKind,
  IntentResourceType,
  RootPlacementExclusion,
  type CreateContainerRequest,
  type RootPlacement,
} from '@nyabase/common';
import { randomInt } from 'node:crypto';
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
import { lockOwnerServerQuota } from '../platform/persistence-pg/advisory-locks.js';
import { committedVolumeBytesSql } from '../platform/persistence-pg/committed-bytes.js';
import { VolumeProvisioner } from '../volumes/volume-provisioner.service.js';
import { overcommitAvailableBytes } from '../volumes/volume-rules.js';
import {
  ContainerControlRepository,
  type ImageRow,
  type ServerRow,
} from './container-control.repository.js';
import {
  assertMemoryGrant,
  createContainerIntent,
  rootSizeMinimum,
  stringArray,
  containerNameConflict,
} from './container-rules.js';
import { requireUserId } from '../iam/actor.js';
import { chooseRootPool, type RootPlacementDecision, type RootPlacementPool } from '../storage-pools/root-placement.js';

type Tx = Transaction<NyabaseDatabase>;

type CreateAccess = NonNullable<
  Awaited<ReturnType<AccessResolverService['resolveContainerCreateAccessInTransaction']>>
>;

/** Locks the server row (root admissions on a server serialise on it) and reads its overcommit ratio. */
async function lockServerForRootAdmission(transaction: Transaction<NyabaseDatabase>, serverId: string): Promise<number> {
  const server = await transaction.selectFrom('infra.servers')
    .select('storage_overcommit_ratio')
    .where('id', '=', serverId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  return numberValue(server.storage_overcommit_ratio);
}

/** The owner's system-disk quota on the server: system disks on every pool, not data volumes. */
async function assertRootGrant(
  repository: ContainerControlRepository,
  transaction: Transaction<NyabaseDatabase>,
  ownerId: string,
  serverId: string,
  delta: number,
  grantLimit: number | null,
): Promise<void> {
  if (grantLimit === null) return;
  const used = await repository.sumLiveRootBytes({ ownerId, serverId }, transaction);
  if (used + delta > grantLimit) {
    throw new ConflictException({
      code: FailureCode.StorageGrantExceeded,
      message: 'System disk grant exceeded',
      details: {
        requestedBytes: delta,
        availableBytes: Math.max(0, grantLimit - used),
        grantLimitBytes: grantLimit,
      },
    });
  }
}

/**
 * What the pool's overcommitted capacity still admits for the owner (whose own
 * commitments on the pool stay within its physical size); null while the pool's
 * capacity is unknown. The caller holds the pool row lock.
 */
async function rootPoolAvailableBytes(
  repository: ContainerControlRepository,
  transaction: Transaction<NyabaseDatabase>,
  ownerId: string,
  poolId: string,
  totalBytes: string | number | null,
  ratio: number,
): Promise<number | null> {
  if (totalBytes === null) return null;
  // Custom volumes belong to the volumes module; only their committed size on the pool is read here.
  const sumPoolVolumes = async (owner?: string) => {
    let query = transaction.selectFrom('control.volumes')
      .select(sql<string>`coalesce(sum(${committedVolumeBytesSql()}), 0)`.as('bytes'))
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .where('pool_id', '=', poolId);
    if (owner !== undefined) query = query.where('owner_id', '=', owner);
    return numberValue((await query.executeTakeFirstOrThrow()).bytes);
  };
  const committed = await repository.sumLiveRootBytes({ poolId }, transaction) + await sumPoolVolumes();
  const ownerCommitted = await repository.sumLiveRootBytes({ ownerId, poolId }, transaction)
    + await sumPoolVolumes(ownerId);
  return overcommitAvailableBytes(numberValue(totalBytes), ratio, committed, ownerCommitted);
}

/**
 * Admission check for growing a root disk on its pool: the owner's system-disk
 * quota on the server, then the pool's overcommitted capacity. Locks the server
 * and pool rows so concurrent admissions serialise.
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
  const ratio = await lockServerForRootAdmission(transaction, serverId);
  await assertRootGrant(repository, transaction, ownerId, serverId, delta, grantLimit);
  const pool = await transaction.selectFrom('infra.storage_pools')
    .select(['total_bytes'])
    .where('id', '=', poolId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const available = await rootPoolAvailableBytes(repository, transaction, ownerId, poolId, pool.total_bytes, ratio);
  if (available !== null && delta > available) {
    throw new ConflictException({
      code: FailureCode.StoragePoolExhausted,
      message: 'Storage pool capacity exceeded',
      details: { poolId, requestedBytes: delta, availableBytes: available, overcommitRatio: ratio },
    });
  }
}

/** Why no system pool took the root disk, as the API error. */
function rootPlacementFailure(
  decision: Exclude<RootPlacementDecision, { kind: 'chosen' }>,
  requestedBytes: number,
  ratio: number,
): ConflictException {
  if (decision.kind === 'no_system_pool') {
    return new ConflictException({
      code: FailureCode.StoragePoolExhausted,
      message: 'The server has no system root storage pool',
    });
  }
  const only = decision.excluded.length === 1 ? decision.excluded[0]! : null;
  if (decision.excluded.every((pool) => pool.reason === RootPlacementExclusion.QuotaIneffective)) {
    return new ConflictException({
      code: FailureCode.StoragePoolQuotaIneffective,
      message: 'The server system storage pool cannot enforce root quotas',
      details: { ...(only ? { poolId: only.poolId } : {}), pools: decision.excluded },
    });
  }
  return new ConflictException({
    code: FailureCode.StoragePoolExhausted,
    message: 'No system storage pool can take the root disk',
    details: {
      ...(only ? { poolId: only.poolId, availableBytes: only.availableBytes } : {}),
      requestedBytes,
      overcommitRatio: ratio,
      pools: decision.excluded,
    },
  });
}

@Injectable()
export class ContainerCreateService {
  constructor(
    private readonly repository: ContainerControlRepository,
    private readonly access: AccessResolverService,
    private readonly intents: IntentRepository,
    private readonly audit: AuditService,
    private readonly ipPools: IpPoolsRepository,
    private readonly volumes: VolumeProvisioner,
    private readonly gpuClaims: GpuClaimsRepository,
  ) {}

  /** A uniform integer in [0, bound) for random root placement; tests may replace it. */
  randomInt: (bound: number) => number = (bound) => randomInt(bound);

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
    ownerId: string,
    request: CreateContainerRequest,
  ): Promise<{ server: ServerRow; image: ImageRow & { fingerprint: string } }> {
    const server = await transaction.selectFrom('infra.servers')
      .selectAll()
      .where('id', '=', request.serverId)
      .forUpdate()
      .executeTakeFirst() as ServerRow | undefined;
    const conflict = await this.repository.nameConflict(request.serverId, ownerId, request.name, transaction);
    if (conflict) {
      throw containerNameConflict(conflict, request.serverId, request.name);
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

  /**
   * The system pool for the new root disk (AGENTS.md, 存储池用途与系统盘分配):
   * the image's minimum size, the owner's system-disk quota on the server, then
   * the server's placement among its system pools, all rows locked (server
   * first, as every capacity change does).
   */
  private async placeRootDisk(
    transaction: Tx,
    server: ServerRow,
    ownerId: string,
    request: CreateContainerRequest,
    image: ImageRow,
    grantLimit: number | null,
  ): Promise<string> {
    const ratio = await lockServerForRootAdmission(transaction, request.serverId);
    const rows = await transaction.selectFrom('infra.storage_pools')
      .selectAll()
      .where('server_id', '=', request.serverId)
      .where('system_disk', '=', true)
      .where('registered', '=', true)
      .orderBy('id')
      .forUpdate()
      .execute();
    if (rows.length === 0) throw rootPlacementFailure({ kind: 'no_system_pool' }, request.rootSizeBytes, ratio);
    const minimum = rootSizeMinimum(image.min_root_size_bytes);
    if (request.rootSizeBytes < minimum) {
      throw new ConflictException({
        code: FailureCode.RootSizeBelowImageMinimum,
        message: 'Root size is below the minimum',
        details: {
          imageId: request.imageId,
          requestedBytes: request.rootSizeBytes,
          minimumBytes: minimum,
        },
      });
    }
    await assertRootGrant(this.repository, transaction, ownerId, request.serverId, request.rootSizeBytes, grantLimit);
    const pools: RootPlacementPool[] = [];
    for (const row of rows) {
      pools.push({
        id: row.id,
        resizeFamily: row.resize_family,
        quotaEffective: row.quota_effective,
        totalBytes: row.total_bytes === null ? null : numberValue(row.total_bytes),
        usedBytes: row.used_bytes === null ? null : numberValue(row.used_bytes),
        weight: row.system_weight,
        maxUsedPercent: row.system_max_used_percent,
        availableBytes: await rootPoolAvailableBytes(
          this.repository,
          transaction,
          ownerId,
          row.id,
          row.total_bytes,
          ratio,
        ),
      });
    }
    const decision = chooseRootPool({
      placement: server.root_placement as RootPlacement,
      sticky: server.root_placement_sticky,
      pools,
      ownerRootBytesByPool: await this.repository.liveRootBytesByPool(ownerId, request.serverId, transaction),
      requestedBytes: request.rootSizeBytes,
      randomInt: this.randomInt,
    });
    if (decision.kind !== 'chosen') throw rootPlacementFailure(decision, request.rootSizeBytes, ratio);
    return decision.poolId;
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
   * row (with GPU claims and the owner's volumes mounted) and queue the create intent.
   */
  async admit(
    transaction: Tx,
    actor: Actor,
    request: CreateContainerRequest,
    id: string,
  ) {
    const userId = requireUserId(actor);
    const ownerId = userId;
    const { server, image } = await this.lockCreateTargets(transaction, ownerId, request);
    const access = await this.resolveCreateAccess(transaction, userId, request, image);
    await lockOwnerServerQuota(transaction, ownerId, request.serverId);
    if (request.powerIntent === ContainerPowerIntent.Running) {
      assertMemoryGrant(
        access.grant,
        request.memBytes,
        await this.repository.sumRunningMemBytes({ ownerId, serverId: request.serverId }, transaction),
      );
    }
    this.assertServerReady(server);
    const pools = await this.ipPools.listForServer(request.serverId, transaction);
    if (pools.length === 0) {
      throw new ConflictException({
        code: FailureCode.IpPoolNotConfigured,
        message: 'The server is not bound to any IP pool',
        details: { serverId: request.serverId },
      });
    }
    const rootPoolId = await this.placeRootDisk(
      transaction,
      server,
      ownerId,
      request,
      image,
      access.grant.rootDiskBytes ?? null,
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
      memBytes: request.memBytes,
      powerIntent: request.powerIntent,
      networkKey,
      address,
    }, transaction);
    const gpuEnabled = await this.gpuClaims.isEnabled(request.serverId, transaction);
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
    // The owner's volumes on the server's disks come up with the container.
    await this.volumes.bindNewContainer(transaction, {
      id: row.id,
      owner_id: row.owner_id,
      server_id: row.server_id,
    });
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
