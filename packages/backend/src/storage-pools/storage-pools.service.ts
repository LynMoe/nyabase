import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  FailureCode,
  ServerStatus,
  StoragePoolDriver,
  StoragePoolResizeFamily,
  type SharedBackendExecutorDiscoverResult,
  type SharedBackendExecutorDto,
  type StorageDiscoverIssueDto,
  type StoragePoolCapabilityDto,
  type PatchStoragePoolRequest,
  type StoragePoolDiscoverResult,
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
import { sql, type Kysely, type Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { classifyGrantExpiry } from '../access/grant-expiry.js';

/**
 * Dir-pool project quota is effective only when Incus reports `usage.used`.
 * `{ total: 0 }` without `used`, or a configured `size=`, is not enough:
 * Incus silently ignores size on filesystems without project quota.
 */
export function dirQuotaEffectiveFromVolumeState(
  usage: { used?: unknown; total?: unknown } | null | undefined,
): boolean {
  if (!usage || typeof usage !== 'object') return false;
  const used = usage.used;
  if (typeof used === 'number') return Number.isFinite(used) && used >= 0;
  if (typeof used === 'string' && used.trim().length > 0) {
    const match = /^([0-9]+)(?:\s*)(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i.exec(used.trim());
    return match !== null;
  }
  return false;
}

export function normalizeObservedStoragePoolSource(
  raw: string | null | undefined,
): { source: string | null; discard: 'too_long' | 'control_char' | null; rawLength: number } {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return { source: null, discard: null, rawLength: 0 };
  if (trimmed.length > 1024) {
    return { source: null, discard: 'too_long', rawLength: trimmed.length };
  }
  if (/[\0\r\n]/.test(trimmed)) {
    return { source: null, discard: 'control_char', rawLength: trimmed.length };
  }
  return { source: trimmed, discard: null, rawLength: trimmed.length };
}

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
    source: normalizeObservedStoragePoolSource(configValue(config, 'source')).source,
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

const SHAREABLE_MAPPING_UNIQUE = 'storage_pools_shared_backend_server_unique';

function isShareableMappingUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (
      record.code === '23505'
      && String(record.constraint ?? '').includes(SHAREABLE_MAPPING_UNIQUE)
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/** infra.storage_pools / repository rows */
export function isLocalPoolRow(row: {
  shareable: boolean;
  driver: string;
  shared_backend_id: string | null;
}): boolean {
  return row.shareable === false
    && row.driver !== StoragePoolDriver.CephFs
    && row.shared_backend_id === null;
}

/** StoragePoolDto — frontend belt helper `isLocalStoragePool` may keep this shape */
export function isLocalPoolDto(pool: {
  shareable: boolean;
  driver: string;
  sharedBackendId: string | null;
}): boolean {
  return pool.shareable === false
    && pool.driver !== StoragePoolDriver.CephFs
    && pool.sharedBackendId === null;
}

type PendingDiscovery = {
  discovery: StoragePoolDiscovery;
  identityKey: string | null;
  discoveredFsid: string | null;
};

type StoragePoolRow = NonNullable<Awaited<ReturnType<StoragePoolsRepository['findById']>>>;

function toDiscoverIssue(input: {
  code: StorageDiscoverIssueDto['code'];
  message: string;
  identityKey?: string | null;
  expectedFsid?: string | null;
  discoveredFsid?: string | null;
  existingIdentityKey?: string | null;
  serverId?: string | null;
  incusName?: string | null;
  poolId?: string | null;
}): StorageDiscoverIssueDto {
  return {
    code: input.code,
    message: input.message,
    identityKey: input.identityKey ?? null,
    expectedFsid: input.expectedFsid ?? null,
    discoveredFsid: input.discoveredFsid ?? null,
    existingIdentityKey: input.existingIdentityKey ?? null,
    serverId: input.serverId ?? null,
    incusName: input.incusName ?? null,
    poolId: input.poolId ?? null,
  };
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
  private readonly logger = new Logger(StoragePoolsService.name);

  constructor(
    private readonly repository: StoragePoolsRepository,
    private readonly transactions: PgTransactionManager,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
  ) {}

  async list(serverId?: string, includeUnregistered = false): Promise<StoragePoolDto[]> {
    const rows = await this.repository.list(serverId, includeUnregistered);
    return rows.map((row) => this.toAdminDto(row)).filter(isLocalPoolDto);
  }

  async listForUser(userId: string, serverId?: string): Promise<StoragePoolDto[]> {
    const rows = await this.repository.list(serverId);
    const [serverGrants, poolGrants] = await Promise.all([
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
    ]);
    const serverIds = new Set(serverGrants
      .filter((grant) => classifyGrantExpiry(grant.expires_at) !== 'lost')
      .map((grant) => grant.server_id));
    const poolIds = new Set(poolGrants
      .filter((grant) => classifyGrantExpiry(grant.expires_at) !== 'lost')
      .map((grant) => grant.pool_id));
    return rows
      .filter((row) => serverIds.has(row.server_id) && poolIds.has(row.id))
      .map((row) => this.toUserDto(row))
      .filter(isLocalPoolDto);
  }

  async get(id: string, includeUnregistered = false): Promise<StoragePoolDto> {
    const row = await this.repository.findById(id);
    if (!row || (!includeUnregistered && !row.registered) || !isLocalPoolRow(row)) {
      throw new NotFoundException('Storage pool not found');
    }
    return this.toAdminDto(row);
  }

  async getForUser(
    id: string,
    userId: string,
    serverId?: string,
  ): Promise<StoragePoolDto> {
    const row = await this.repository.findById(id);
    if (
      !row
      || !row.registered
      || !isLocalPoolRow(row)
      || (serverId !== undefined && row.server_id !== serverId)
    ) {
      throw new NotFoundException('Storage pool not found');
    }
    const visible = (await this.listForUser(userId, row.server_id))
      .some((pool) => pool.id === id);
    if (!visible) throw new NotFoundException('Storage pool not found');
    return this.toUserDto(row);
  }

  async discover(serverId: string): Promise<StoragePoolDiscoverResult> {
    const pending = await this.collectDiscoveries(serverId);
    const { rows, identityConflicts } = await this.applyDiscoveries(serverId, pending);
    return {
      pools: rows.map((row) => this.toAdminDto(row)).filter(isLocalPoolDto),
      identityConflicts,
    };
  }

  async listExecutors(backendId: string): Promise<SharedBackendExecutorDto[]> {
    const backend = await this.database
      .selectFrom('infra.shared_backends')
      .select('id')
      .where('id', '=', backendId)
      .executeTakeFirst();
    if (!backend) throw new NotFoundException('Shared backend not found');
    const mapped = await this.listExecutorsByBackendIds([backendId]);
    return mapped.get(backendId) ?? [];
  }

  async listExecutorsByBackendIds(
    backendIds: readonly string[],
  ): Promise<Map<string, SharedBackendExecutorDto[]>> {
    const result = new Map<string, SharedBackendExecutorDto[]>();
    for (const id of backendIds) result.set(id, []);
    const rows = await this.repository.listExecutorsByBackendIds(backendIds);
    for (const row of rows) {
      if (row.shared_backend_id === null) continue;
      const list = result.get(row.shared_backend_id) ?? [];
      list.push(this.toExecutorDto(row));
      result.set(row.shared_backend_id, list);
    }
    return result;
  }

  async discoverExecutors(
    backendId: string,
    serverId?: string,
  ): Promise<SharedBackendExecutorDiscoverResult> {
    const backend = await this.database
      .selectFrom('infra.shared_backends')
      .select('id')
      .where('id', '=', backendId)
      .executeTakeFirst();
    if (!backend) throw new NotFoundException('Shared backend not found');
    let serverIds: string[];
    if (serverId) {
      const server = await this.database
        .selectFrom('infra.servers')
        .select('id')
        .where('id', '=', serverId)
        .executeTakeFirst();
      if (!server) throw new NotFoundException('Server not found');
      serverIds = [serverId];
    } else {
      const servers = await this.database
        .selectFrom('infra.servers')
        .select('id')
        .where('status', '=', 'online')
        .execute();
      serverIds = servers.map((row) => row.id);
    }
    const identityConflicts: StorageDiscoverIssueDto[] = [];
    for (const id of serverIds) {
      try {
        const pending = await this.collectDiscoveries(id);
        const mapped = await this.applyDiscoveries(id, pending);
        identityConflicts.push(...mapped.identityConflicts);
      } catch (error) {
        if (error instanceof ConflictException || error instanceof BadRequestException) {
          throw error;
        }
        const issue = toDiscoverIssue({
          code: FailureCode.ServerUnreachable,
          message: 'Server Incus endpoint is unreachable',
          serverId: id,
        });
        identityConflicts.push(issue);
        const klass = error instanceof Error ? error.constructor.name : 'Error';
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`SERVER_UNREACHABLE serverId=${id} ${klass}: ${message}`);
      }
    }
    return {
      executors: await this.listExecutors(backendId),
      identityConflicts,
    };
  }

  async patch(id: string, input: PatchStoragePoolRequest): Promise<StoragePoolDto> {
    const result = await this.transactions.run(
      async (transaction) => {
        const observed = await this.repository.findById(id, transaction);
        if (!observed || !isLocalPoolRow(observed)) {
          throw new NotFoundException('Storage pool not found');
        }
        await this.repository.lockCapacityScope(id, observed.server_id, [], transaction);
        const current = await this.repository.findByIdForUpdate(id, transaction);
        if (!current || !isLocalPoolRow(current)) {
          throw new NotFoundException('Storage pool not found');
        }
        if (Number(current.revision) !== input.expectedRevision) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }
        if (input.registered === false && current.registered) {
          if (await this.repository.hasDependencies(id, transaction)) {
            throw new ConflictException({
              code: FailureCode.StoragePoolInUse,
              message: 'Storage pool registration or backend mapping cannot change while referenced',
            });
          }
        }
        const updated = await this.repository.patch(id, input.expectedRevision, {
          shareable: false,
          ...(input.registered === undefined ? {} : { registered: input.registered }),
          ...(input.displayName === undefined
            ? {}
            : { display_name: input.displayName?.trim() ? input.displayName.trim() : null }),
        }, transaction);
        if (!updated) throw new ConflictException({ code: FailureCode.RevisionConflict });
        return updated;
      },
      { isolationLevel: 'serializable', maxAttempts: 5 },
    );
    return this.toAdminDto(result);
  }

  async patchExecutor(
    backendId: string,
    executorId: string,
    input: {
      expectedRevision: number;
      registered: boolean;
    },
  ): Promise<SharedBackendExecutorDto> {
    const updated = await this.transactions.run(
      async (transaction) => {
        const observed = await this.repository.findById(executorId, transaction);
        if (
          !observed
          || observed.shared_backend_id !== backendId
          || observed.shareable !== true
          || observed.driver !== StoragePoolDriver.CephFs
        ) {
          throw new NotFoundException('Storage pool not found');
        }
        await this.repository.lockCapacityScope(
          executorId,
          observed.server_id,
          [observed.shared_backend_id],
          transaction,
        );
        const current = await this.repository.findByIdForUpdate(executorId, transaction);
        if (
          !current
          || current.shared_backend_id !== backendId
          || current.shareable !== true
          || current.driver !== StoragePoolDriver.CephFs
        ) {
          throw new NotFoundException('Storage pool not found');
        }
        if (Number(current.revision) !== input.expectedRevision) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }
        if (input.registered !== current.registered && !input.registered) {
          if (await this.repository.hasDependencies(executorId, transaction)) {
            throw new ConflictException({
              code: FailureCode.StoragePoolInUse,
              message: 'Storage pool registration or backend mapping cannot change while referenced',
            });
          }
        }
        const row = await this.repository.patch(executorId, input.expectedRevision, {
          registered: input.registered,
          shareable: true,
        }, transaction);
        if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
        if (row.shared_backend_id) {
          await this.refreshSharedBackendCapacity(row.shared_backend_id, transaction);
        }
        return row;
      },
      { isolationLevel: 'serializable', maxAttempts: 5 },
    );
    const mapped = await this.listExecutorsByBackendIds([backendId]);
    const dto = (mapped.get(backendId) ?? []).find((item) => item.id === updated.id);
    if (!dto) throw new NotFoundException('Storage pool not found');
    return dto;
  }

  private async collectDiscoveries(serverId: string): Promise<PendingDiscovery[]> {
    const client = await this.clients.get(serverId);
    const listed = await client.listStoragePools(1);
    const pending: PendingDiscovery[] = [];
    for (const pool of listed.metadata) {
      const name = pool.name;
      const driver = pool.driver;
      if (!name || !driver || driver === 'cephobject') continue;
      const resources = await client.getStoragePoolResources(name);
      const space = resources.metadata.space;
      let quotaEffective: boolean | null = null;
      if (driver === StoragePoolDriver.Dir) {
        const customVolumes = await client.listStorageVolumes(name, 'custom', 1);
        quotaEffective = false;
        for (const volume of customVolumes.metadata) {
          if (!volume.name) continue;
          const state = await client.getStorageVolumeState(name, 'custom', volume.name);
          if (dirQuotaEffectiveFromVolumeState(state.metadata.usage)) {
            quotaEffective = true;
            break;
          }
        }
      }
      const config = pool.config;
      const observed = normalizeObservedStoragePoolSource(configValue(config ?? {}, 'source'));
      if (observed.discard) {
        this.logger.warn(
          `storage pool source discarded reason=${observed.discard} `
          + `serverId=${serverId} incusName=${name} length=${observed.rawLength}`,
        );
      }
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
    return pending;
  }

  private async applyDiscoveries(
    serverId: string,
    pending: PendingDiscovery[],
  ): Promise<{ rows: StoragePoolRow[]; identityConflicts: StorageDiscoverIssueDto[] }> {
    return this.transactions.run(
      async (transaction) => {
        await this.repository.lockServer(serverId, transaction);
        const discovered: StoragePoolRow[] = [];
        const identityConflicts: StorageDiscoverIssueDto[] = [];
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
          if (
            item.discovery.shareable
            || item.discovery.driver === StoragePoolDriver.CephFs
          ) {
            await sql`SAVEPOINT shareable_map`.execute(transaction);
            try {
              const outcome = await this.applySharedExecutorMapping(
                serverId,
                item,
                current,
                transaction,
              );
              if (outcome.issue) {
                identityConflicts.push(outcome.issue);
                this.warnDiscoverIssue(outcome.issue);
              }
              if (outcome.row) discovered.push(outcome.row);
              await sql`RELEASE SAVEPOINT shareable_map`.execute(transaction);
            } catch (error) {
              if (isShareableMappingUniqueViolation(error)) {
                await sql`ROLLBACK TO SAVEPOINT shareable_map`.execute(transaction);
                const issue = toDiscoverIssue({
                  code: FailureCode.StoragePoolInUse,
                  message: 'The shared backend already has a pool on this server',
                  serverId,
                  incusName: item.discovery.incusName,
                  poolId: current?.id ?? null,
                });
                identityConflicts.push(issue);
                this.warnDiscoverIssue(issue);
                continue;
              }
              throw error;
            }
            continue;
          }
          if (current) {
            await this.repository.lockCapacityScope(current.id, serverId, [], transaction);
          }
          const row = await this.repository.upsertDiscovery(
            randomUUID(),
            { ...item.discovery, sharedBackendId: null },
            transaction,
          );
          discovered.push(row);
        }
        return { rows: discovered, identityConflicts };
      },
      { isolationLevel: 'serializable', maxAttempts: 5 },
    );
  }

  private async applySharedExecutorMapping(
    serverId: string,
    item: PendingDiscovery,
    current: StoragePoolRow | undefined,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<{ row?: StoragePoolRow; issue?: StorageDiscoverIssueDto }> {
    let sharedBackendId: string | null = null;
    let issue: StorageDiscoverIssueDto | undefined;
    let discoveredFsidOwnerId: string | null = null;

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
          issue = toDiscoverIssue({
            code: FailureCode.SharedBackendIdentityConflict,
            message: 'The discovered CephFS identity is bound to another FSID',
            identityKey: item.identityKey,
            expectedFsid: backend.ceph_fsid,
            discoveredFsid: item.discoveredFsid,
            serverId,
            incusName: item.discovery.incusName,
            poolId: current?.id ?? null,
          });
        } else {
          sharedBackendId = backend.id;
        }
      }
    }

    if (!issue && current?.shared_backend_id && item.discoveredFsid) {
      const mappedBackend = await transaction
        .selectFrom('infra.shared_backends')
        .select(['identity_key', 'ceph_fsid'])
        .where('id', '=', current.shared_backend_id)
        .executeTakeFirst();
      if (
        mappedBackend
        && mappedBackend.ceph_fsid.toLowerCase() !== item.discoveredFsid
      ) {
        issue = toDiscoverIssue({
          code: FailureCode.SharedBackendIdentityConflict,
          message: 'The mapped storage pool reported a different FSID',
          poolId: current.id,
          identityKey: mappedBackend.identity_key,
          expectedFsid: mappedBackend.ceph_fsid,
          discoveredFsid: item.discoveredFsid,
          serverId,
          incusName: item.discovery.incusName,
        });
      }
    }

    if (item.discoveredFsid) {
      const fsidOwner = await transaction
        .selectFrom('infra.shared_backends')
        .select(['id', 'identity_key', 'ceph_fsid'])
        .where(sql<boolean>`lower(ceph_fsid) = ${item.discoveredFsid}`)
        .executeTakeFirst();
      discoveredFsidOwnerId = fsidOwner?.id ?? null;
      if (
        !issue
        && fsidOwner
        && (!item.identityKey || fsidOwner.identity_key !== item.identityKey)
      ) {
        issue = toDiscoverIssue({
          code: FailureCode.SharedBackendIdentityConflict,
          message: 'The discovered FSID is already bound to another identity',
          identityKey: item.identityKey,
          discoveredFsid: item.discoveredFsid,
          existingIdentityKey: fsidOwner.identity_key,
          serverId,
          incusName: item.discovery.incusName,
          poolId: current?.id ?? null,
        });
      }
    }

    if (
      !issue
      && current?.shared_backend_id
      && sharedBackendId
      && current.shared_backend_id !== sharedBackendId
    ) {
      issue = toDiscoverIssue({
        code: FailureCode.SharedBackendIdentityConflict,
        message: 'A storage pool cannot switch shared backend identity during discovery',
        poolId: current.id,
        serverId,
        incusName: item.discovery.incusName,
        identityKey: item.identityKey,
      });
    }

    if (issue) {
      if (current?.shared_backend_id) {
        return { issue };
      }
      if (current) {
        await this.repository.lockCapacityScope(current.id, serverId, [], transaction);
      }
      const row = await this.repository.upsertDiscovery(
        randomUUID(),
        { ...item.discovery, sharedBackendId: null },
        transaction,
      );
      return { row, issue };
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
        return {
          issue: toDiscoverIssue({
            code: FailureCode.StoragePoolInUse,
            message: 'The shared backend already has a pool on this server',
            serverId,
            incusName: item.discovery.incusName,
            poolId: mapping.id,
          }),
        };
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
    return { row };
  }

  private warnDiscoverIssue(issue: StorageDiscoverIssueDto): void {
    this.logger.warn(
      `${issue.code} serverId=${issue.serverId} incusName=${issue.incusName} identityKey=${issue.identityKey}`,
    );
  }

  private toExecutorDto(row: {
    id: string;
    shared_backend_id: string | null;
    server_id: string;
    server_name: string;
    server_status: string;
    incus_name: string;
    registered: boolean;
    total_bytes: string | number | null;
    used_bytes: string | number | null;
    last_observed_at: Date | string | null;
    revision: string | number;
  }): SharedBackendExecutorDto {
    if (row.shared_backend_id === null) {
      throw new NotFoundException('Storage pool not found');
    }
    return {
      id: row.id,
      backendId: row.shared_backend_id,
      serverId: row.server_id,
      serverName: row.server_name,
      serverStatus: row.server_status as ServerStatus,
      incusName: row.incus_name,
      registered: row.registered,
      totalBytes: row.total_bytes === null ? null : numberValue(row.total_bytes),
      usedBytes: row.used_bytes === null ? null : numberValue(row.used_bytes),
      lastObservedAt: isoDate(row.last_observed_at),
      revision: numberValue(row.revision),
    };
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

  private toAdminDto(row: Parameters<StoragePoolsService['toPoolDto']>[0]): StoragePoolDto {
    return this.toPoolDto(row, row.source ?? null);
  }

  private toUserDto(row: Parameters<StoragePoolsService['toPoolDto']>[0]): StoragePoolDto {
    return this.toPoolDto(row, null);
  }

  private toPoolDto(row: {
    id: string;
    server_id: string;
    incus_name: string;
    display_name: string | null;
    source?: string | null;
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
  }, source: string | null): StoragePoolDto {
    return {
      id: row.id,
      serverId: row.server_id,
      incusName: row.incus_name,
      displayName: row.display_name,
      source,
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
