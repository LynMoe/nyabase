import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  FailureCode,
  StoragePoolDriver,
  StoragePoolResizeFamily,
  type StoragePoolCapabilityDto,
  type StoragePoolDto,
} from '@nyabase/common';
import type { IncusClientFactory } from '../runtime/reconcile-worker.service.js';
import { INCUS_CLIENT_FACTORY } from '../runtime/reconcile-worker.service.js';
import {
  StoragePoolsRepository,
  type StorageExecutor,
  type StoragePoolDiscovery,
} from './storage-pools.repository.js';
import { numberValue, isoDate } from '../domain/domain-utils.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { sql, type Kysely } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { classifyGrantExpiry } from '../access/grant-expiry.js';

export function deriveStoragePoolDiscovery(input: {
  serverId: string;
  incusName: string;
  driver: string;
  config?: Record<string, string | undefined>;
  totalBytes?: number | null;
  usedBytes?: number | null;
  quotaEffective?: boolean | null;
}): StoragePoolDiscovery {
  const driver = input.driver as StoragePoolDiscovery['driver'];
  if (!Object.values(StoragePoolDriver).includes(driver as StoragePoolDriver)) {
    throw new BadRequestException(`Unsupported Incus storage driver: ${input.driver}`);
  }
  const config = input.config ?? {};
  const configuredFilesystem = (
    config['volume.block.filesystem']
    ?? config['block.filesystem']
    ?? null
  )?.trim().toLowerCase() ?? null;
  const zfsBlockMode = driver === StoragePoolDriver.Zfs
    && configValue(config, 'volume.zfs.block_mode')?.toLowerCase() === 'true';
  const quotaOnline =
    driver === StoragePoolDriver.Dir
    || driver === StoragePoolDriver.Btrfs
    || driver === StoragePoolDriver.CephFs
    || (driver === StoragePoolDriver.Zfs && !zfsBlockMode);
  const blockBacked =
    driver === StoragePoolDriver.Lvm
    || driver === StoragePoolDriver.LvmCluster
    || driver === StoragePoolDriver.Ceph
    || zfsBlockMode;
  const resizeFamily = quotaOnline
    ? StoragePoolResizeFamily.QuotaOnline
    : blockBacked
      ? StoragePoolResizeFamily.BlockBacked
      : (() => {
        throw new BadRequestException(`Unsupported Incus storage driver: ${input.driver}`);
      })();
  const blockFilesystem = resizeFamily === StoragePoolResizeFamily.BlockBacked
    ? configuredFilesystem ?? 'ext4'
    : null;
  if (
    resizeFamily === StoragePoolResizeFamily.BlockBacked
    && blockFilesystem?.toLowerCase() !== 'ext4'
  ) {
    throw new BadRequestException({
      code: FailureCode.InvalidInput,
      message: 'Block-backed storage pools must use ext4',
    });
  }
  const shareable = driver === StoragePoolDriver.CephFs;
  return {
    serverId: input.serverId,
    incusName: input.incusName,
    driver,
    resizeFamily,
    rootDiskCapable: driver !== StoragePoolDriver.CephFs,
    shareable,
    blockFilesystem,
    totalBytes: input.totalBytes ?? null,
    usedBytes: input.usedBytes ?? null,
    quotaEffective: input.quotaEffective
      ?? (driver === StoragePoolDriver.Dir ? false : quotaOnline),
  };
}

function configValue(
  config: Record<string, string | undefined>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = config[key]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * CephFS identity is based on the Incus pool configuration, never on the
 * local pool name.  FSID is intentionally not part of this value: Incus does
 * not expose it reliably and administrators register it out of band.
 */
export function deriveSharedBackendIdentity(
  driver: string,
  config: Record<string, string | undefined> = {},
): string | null {
  if (driver !== StoragePoolDriver.CephFs) return null;
  const cluster = configValue(config, 'cephfs.cluster_name', 'ceph.cluster_name');
  const source = configValue(config, 'source', 'cephfs.source');
  const path = configValue(config, 'cephfs.path', 'volume.cephfs.path');
  if (!cluster || !source || !path) return null;
  return `cephfs:${cluster}/${source}/${path.replace(/^\/+/, '')}`;
}

function deriveDiscoveredFsid(
  config: Record<string, string | undefined>,
): string | null {
  return configValue(
    config,
    'cephfs.fsid',
    'cephfs.cluster_fsid',
    'ceph.cluster_fsid',
  )?.toLowerCase() ?? null;
}

function hasPostgresCode(error: unknown, codes: readonly string[]): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && codes.includes(record.code)) return true;
    current = record.cause;
  }
  return false;
}

export function storagePoolCapability(
  family: StoragePoolResizeFamily,
  quotaEffective: boolean | null,
  blockFilesystem: string | null = null,
): StoragePoolCapabilityDto {
  if (family === StoragePoolResizeFamily.QuotaOnline) {
    return {
      growOnline: true,
      shrinkOnline: quotaEffective === true,
      shrinkRequiresStop: false,
      shrinkNever: false,
      enforceUsageFloor: quotaEffective === true,
    };
  }
  const shrinkNever = blockFilesystem?.toLowerCase() === 'xfs';
  return {
    growOnline: true,
    shrinkOnline: false,
    shrinkRequiresStop: !shrinkNever,
    shrinkNever,
    enforceUsageFloor: true,
  };
}

/** When the pool row is missing, refuse shrink rather than implying an online path. */
export function missingStoragePoolCapability(): StoragePoolCapabilityDto {
  return {
    growOnline: true,
    shrinkOnline: false,
    shrinkRequiresStop: false,
    shrinkNever: true,
    enforceUsageFloor: true,
  };
}

@Injectable()
export class StoragePoolsService {
  constructor(
    private readonly repository: StoragePoolsRepository,
    private readonly transactions: PgTransactionManager,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
  ) {}

  async list(serverId?: string, includeUnregistered = false): Promise<StoragePoolDto[]> {
    const rows = await this.repository.list(serverId, includeUnregistered);
    return rows.map((row) => this.toDto(row));
  }

  async listForUser(userId: string, serverId?: string): Promise<StoragePoolDto[]> {
    const rows = await this.repository.list(serverId);
    const [serverGrants, poolGrants, backendGrants] = await Promise.all([
      this.database.selectFrom('iam.server_grants as grant')
        .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
        .select(['grant.server_id', 'grant.expires_at'])
        .where((expression) => expression.or([
          expression('grant.user_id', '=', userId),
          expression('member.user_id', '=', userId),
        ]))
        .execute(),
      this.database.selectFrom('iam.storage_pool_grants as grant')
        .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
        .select(['grant.pool_id', 'grant.expires_at'])
        .where((expression) => expression.or([
          expression('grant.user_id', '=', userId),
          expression('member.user_id', '=', userId),
        ]))
        .execute(),
      this.database.selectFrom('iam.shared_backend_grants as grant')
        .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
        .select(['grant.shared_backend_id', 'grant.expires_at'])
        .where((expression) => expression.or([
          expression('grant.user_id', '=', userId),
          expression('member.user_id', '=', userId),
        ]))
        .execute(),
    ]);
    const serverIds = new Set(serverGrants
      .filter((grant) => classifyGrantExpiry(grant.expires_at) !== 'lost')
      .map((grant) => grant.server_id));
    const poolIds = new Set(poolGrants
      .filter((grant) => classifyGrantExpiry(grant.expires_at) !== 'lost')
      .map((grant) => grant.pool_id));
    const backendIds = new Set(backendGrants
      .filter((grant) => classifyGrantExpiry(grant.expires_at) !== 'lost')
      .map((grant) => grant.shared_backend_id));
    return rows
      .filter((row) => row.shared_backend_id
        ? backendIds.has(row.shared_backend_id)
        : serverIds.has(row.server_id) && poolIds.has(row.id))
      .map((row) => this.toDto(row));
  }

  async get(id: string, includeUnregistered = false): Promise<StoragePoolDto> {
    const row = await this.repository.findById(id);
    if (!row || (!includeUnregistered && !row.registered)) {
      throw new NotFoundException('Storage pool not found');
    }
    return this.toDto(row);
  }

  async getForUser(
    id: string,
    userId: string,
    serverId?: string,
  ): Promise<StoragePoolDto> {
    const row = await this.repository.findById(id);
    if (!row || !row.registered || (serverId !== undefined && row.server_id !== serverId)) {
      throw new NotFoundException('Storage pool not found');
    }
    const visible = (await this.listForUser(userId, row.server_id))
      .some((pool) => pool.id === id);
    if (!visible) throw new NotFoundException('Storage pool not found');
    return this.toDto(row);
  }

  async discover(serverId: string): Promise<StoragePoolDto[]> {
    const client = await this.clients.get(serverId);
    const listed = await client.listStoragePools(1);
    const pending: Array<{
      discovery: StoragePoolDiscovery;
      identityKey: string | null;
      discoveredFsid: string | null;
    }> = [];
    for (const pool of listed.metadata) {
      const name = pool.name;
      const driver = pool.driver;
      if (!name || !driver || driver === 'cephobject') continue;
      const resources = await client.getStoragePoolResources(name);
      const space = resources.metadata.space;
      let quotaEffective: boolean | null = null;
      if (driver === StoragePoolDriver.Dir) {
        const customVolumes = await client.listStorageVolumes(name, 'custom', 1);
        const probe = customVolumes.metadata.find((volume) => Boolean(volume.name));
        if (!probe?.name) {
          quotaEffective = false;
        } else {
          const state = await client.getStorageVolumeState(name, 'custom', probe.name);
          const sized = Boolean(probe.config?.size?.trim());
          quotaEffective = (
            state.metadata.usage !== null
            && state.metadata.usage !== undefined
          ) || sized;
        }
      }
      const config = pool.config;
      const discovery = deriveStoragePoolDiscovery({
        serverId,
        incusName: name,
        driver,
        config,
        totalBytes: space?.total ?? null,
        usedBytes: space?.used ?? null,
        quotaEffective,
      });
      pending.push({
        discovery,
        identityKey: deriveSharedBackendIdentity(driver, config ?? {}),
        discoveredFsid: driver === StoragePoolDriver.CephFs
          ? deriveDiscoveredFsid(config ?? {})
          : null,
      });
    }
    let rows;
    try {
      rows = await this.transactions.run(
        async (transaction) => {
        await this.repository.lockServer(serverId, transaction);
        const discovered = [];
        for (const item of pending) {
          const current = await this.repository.findByServerAndName(
            serverId,
            item.discovery.incusName,
            transaction,
          );
          if (
            current?.shared_backend_id
            && item.discovery.driver !== StoragePoolDriver.CephFs
          ) {
            throw new ConflictException({
              code: FailureCode.StoragePoolInUse,
              message: 'A mapped shared backend cannot become a non-CephFS pool',
              details: { poolId: current.id, serverId },
            });
          }

          let sharedBackendId: string | null = null;
          if (item.identityKey) {
            const backend = await transaction
              .selectFrom('infra.shared_backends')
              .select(['id', 'identity_key', 'ceph_fsid'])
              .where('identity_key', '=', item.identityKey)
              .executeTakeFirst();
            if (backend) {
              if (
                item.discoveredFsid
                && backend.ceph_fsid.toLowerCase() !== item.discoveredFsid
              ) {
                throw new ConflictException({
                  code: FailureCode.SharedBackendIdentityConflict,
                  message: 'The discovered CephFS identity is bound to another FSID',
                  details: {
                    identityKey: item.identityKey,
                    expectedFsid: backend.ceph_fsid,
                    discoveredFsid: item.discoveredFsid,
                  },
                });
              }
              sharedBackendId = backend.id;
            }
          }

          if (current?.shared_backend_id && item.discoveredFsid) {
            const mappedBackend = await transaction
              .selectFrom('infra.shared_backends')
              .select(['identity_key', 'ceph_fsid'])
              .where('id', '=', current.shared_backend_id)
              .executeTakeFirst();
            if (
              mappedBackend
              && mappedBackend.ceph_fsid.toLowerCase() !== item.discoveredFsid
            ) {
              throw new ConflictException({
                code: FailureCode.SharedBackendIdentityConflict,
                message: 'The mapped storage pool reported a different FSID',
                details: {
                  poolId: current.id,
                  identityKey: mappedBackend.identity_key,
                  expectedFsid: mappedBackend.ceph_fsid,
                  discoveredFsid: item.discoveredFsid,
                },
              });
            }
          }

          let discoveredFsidOwnerId: string | null = null;
          if (item.discoveredFsid) {
            const fsidOwner = await transaction
              .selectFrom('infra.shared_backends')
              .select(['id', 'identity_key', 'ceph_fsid'])
              .where(sql<boolean>`lower(ceph_fsid) = ${item.discoveredFsid}`)
              .executeTakeFirst();
            discoveredFsidOwnerId = fsidOwner?.id ?? null;
            if (
              fsidOwner
              && (!item.identityKey || fsidOwner.identity_key !== item.identityKey)
            ) {
              throw new ConflictException({
                code: FailureCode.SharedBackendIdentityConflict,
                message: 'The discovered FSID is already bound to another identity',
                details: {
                  identityKey: item.identityKey,
                  discoveredFsid: item.discoveredFsid,
                  existingIdentityKey: fsidOwner.identity_key,
                },
              });
            }
          }

          if (
            current?.shared_backend_id
            && sharedBackendId
            && current.shared_backend_id !== sharedBackendId
          ) {
            throw new ConflictException({
              code: FailureCode.SharedBackendIdentityConflict,
              message: 'A storage pool cannot switch shared backend identity during discovery',
              details: { poolId: current.id, serverId },
            });
          }
          if (current) {
            await this.repository.lockCapacityScope(
              current.id,
              serverId,
              [sharedBackendId, discoveredFsidOwnerId],
              transaction,
            );
          } else {
            await this.repository.lockSharedBackends(
              [sharedBackendId, discoveredFsidOwnerId],
              transaction,
            );
          }
          if (sharedBackendId) {
            let mappingQuery = transaction
              .selectFrom('infra.storage_pools')
              .select('id')
              .where('shared_backend_id', '=', sharedBackendId)
              .where('server_id', '=', serverId)
              .where('shareable', '=', true);
            if (current) mappingQuery = mappingQuery.where('id', '!=', current.id);
            const mapping = await mappingQuery.orderBy('id').forUpdate().executeTakeFirst();
            if (mapping) {
              throw new ConflictException({
                code: FailureCode.StoragePoolInUse,
                message: 'The shared backend already has a pool on this server',
                details: { sharedBackendId, serverId, poolId: mapping.id },
              });
            }
          }

          const row = await this.repository.upsertDiscovery(
            randomUUID(),
            { ...item.discovery, sharedBackendId },
            transaction,
          );
          if (row.shared_backend_id) {
            await this.refreshSharedBackendCapacity(row.shared_backend_id, transaction);
          }
          discovered.push(row);
        }
        return discovered;
        },
        { isolationLevel: 'serializable', maxAttempts: 5 },
      );
    } catch (error) {
      if (hasPostgresCode(error, ['23505'])) {
        throw new ConflictException({
          code: FailureCode.StoragePoolInUse,
          message: 'The shared backend already has a pool on this server',
        });
      }
      throw error;
    }
    return rows.map((row) => this.toDto(row));
  }

  async patch(
    id: string,
    input: {
      expectedRevision: number;
      registered: boolean;
      displayName?: string | null;
      sharedBackendId?: string | null;
    },
  ): Promise<StoragePoolDto> {
    let result;
    try {
      result = await this.transactions.run(
        async (transaction) => {
        const observed = await this.repository.findById(id, transaction);
        if (!observed) throw new NotFoundException('Storage pool not found');
        const requestedSharedBackendId = input.sharedBackendId === undefined
          ? observed.shared_backend_id
          : input.sharedBackendId;
        await this.repository.lockCapacityScope(
          id,
          observed.server_id,
          [observed.shared_backend_id, requestedSharedBackendId],
          transaction,
        );
        const current = await this.repository.findByIdForUpdate(id, transaction);
        if (!current) throw new NotFoundException('Storage pool not found');
        if (Number(current.revision) !== input.expectedRevision) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }
        const nextSharedBackendId = input.sharedBackendId === undefined
          ? current.shared_backend_id
          : input.sharedBackendId;
        const isCephFs = current.driver === StoragePoolDriver.CephFs;
        const registrationChanged = input.registered !== current.registered;
        const mappingChanged = input.sharedBackendId !== undefined
          && input.sharedBackendId !== current.shared_backend_id;

        if (input.registered && isCephFs && !nextSharedBackendId) {
          throw new ConflictException({
            code: FailureCode.InvalidInput,
            message: 'A shareable CephFS pool must be mapped to a shared backend before registration',
          });
        }
        if (nextSharedBackendId !== null && !isCephFs) {
          throw new BadRequestException('Only CephFS pools may attach a shared backend');
        }
        if ((registrationChanged && !input.registered) || mappingChanged) {
          if (await this.repository.hasDependencies(id, transaction)) {
            throw new ConflictException({
              code: FailureCode.StoragePoolInUse,
              message: 'Storage pool registration or backend mapping cannot change while referenced',
            });
          }
        }
        if (input.sharedBackendId !== undefined && input.sharedBackendId !== null) {
          const backend = await transaction
            .selectFrom('infra.shared_backends')
            .select('id')
            .where('id', '=', input.sharedBackendId)
            .forUpdate()
            .executeTakeFirst();
          if (!backend) throw new NotFoundException('Shared backend not found');
          let mappingQuery = transaction
            .selectFrom('infra.storage_pools')
            .select('id')
            .where('shared_backend_id', '=', input.sharedBackendId)
            .where('server_id', '=', current.server_id)
            .where('shareable', '=', true);
          mappingQuery = mappingQuery.where('id', '!=', id);
          const mapping = await mappingQuery.orderBy('id').forUpdate().executeTakeFirst();
          if (mapping) {
            throw new ConflictException({
              code: FailureCode.StoragePoolInUse,
              message: 'The shared backend already has a shareable pool on this server',
              details: {
                sharedBackendId: input.sharedBackendId,
                serverId: current.server_id,
                poolId: mapping.id,
              },
            });
          }
        }
        const updated = await this.repository.patch(id, input.expectedRevision, {
          registered: input.registered,
          shareable: isCephFs,
          ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
          ...(input.sharedBackendId !== undefined
            ? { shared_backend_id: input.sharedBackendId }
            : {}),
        }, transaction);
        if (!updated) throw new ConflictException({ code: FailureCode.RevisionConflict });
        if (current.shared_backend_id) {
          await this.refreshSharedBackendCapacity(current.shared_backend_id, transaction);
        }
        if (
          updated.shared_backend_id
          && updated.shared_backend_id !== current.shared_backend_id
        ) {
          await this.refreshSharedBackendCapacity(updated.shared_backend_id, transaction);
        }
        return updated;
        },
        { isolationLevel: 'serializable', maxAttempts: 5 },
      );
    } catch (error) {
      if (hasPostgresCode(error, ['23505'])) {
        throw new ConflictException({
          code: FailureCode.StoragePoolInUse,
          message: 'The shared backend already has a shareable pool on this server',
        });
      }
      throw error;
    }
    return this.toDto(result);
  }

  private async refreshSharedBackendCapacity(
    sharedBackendId: string,
    executor: StorageExecutor = this.database,
  ): Promise<void> {
    const capacity = await executor
      .selectFrom('infra.storage_pools')
      .select([
        executor.fn.max('total_bytes').as('total_bytes'),
        executor.fn.max('used_bytes').as('used_bytes'),
      ])
      .where('shared_backend_id', '=', sharedBackendId)
      .where('shareable', '=', true)
      .executeTakeFirstOrThrow();
    await executor
      .updateTable('infra.shared_backends')
      .set({
        total_bytes: capacity.total_bytes,
        used_bytes: capacity.used_bytes,
      })
      .where('id', '=', sharedBackendId)
      .execute();
  }

  private toDto(row: {
    id: string;
    server_id: string;
    incus_name: string;
    display_name: string | null;
    driver: string;
    resize_family: string;
    root_disk_capable: boolean;
    shareable: boolean;
    block_filesystem: string | null;
    shared_backend_id: string | null;
    total_bytes: string | number | null;
    used_bytes: string | number | null;
    quota_effective: boolean | null;
    registered: boolean;
    last_observed_at: Date | string | null;
    revision: string | number;
  }): StoragePoolDto {
    return {
      id: row.id,
      serverId: row.server_id,
      incusName: row.incus_name,
      displayName: row.display_name,
      driver: row.driver as StoragePoolDto['driver'],
      resizeFamily: row.resize_family as StoragePoolDto['resizeFamily'],
      rootDiskCapable: row.root_disk_capable,
      shareable: row.shareable,
      blockFilesystem: row.block_filesystem,
      sharedBackendId: row.shared_backend_id,
      totalBytes: row.total_bytes === null ? null : numberValue(row.total_bytes),
      usedBytes: row.used_bytes === null ? null : numberValue(row.used_bytes),
      quotaEffective: row.quota_effective,
      registered: row.registered,
      capability: storagePoolCapability(
        row.resize_family as StoragePoolResizeFamily,
        row.quota_effective,
        row.block_filesystem,
      ),
      lastObservedAt: isoDate(row.last_observed_at),
      revision: numberValue(row.revision),
    };
  }
}
