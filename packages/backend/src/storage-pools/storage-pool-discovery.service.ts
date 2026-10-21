import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import {
  FailureCode,
  StoragePoolDriver,
  StoragePoolResizeFamily,
  type StorageDiscoverIssueDto,
  type StoragePoolDiscoverResult,
} from '@nyabase/common';
import type { IncusClientFactory } from '../incus/incus-client.factory.js';
import { INCUS_CLIENT_FACTORY } from '../incus/incus-client.factory.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { toAdminPoolDto } from './storage-pool-dtos.js';
import { isLocalPoolDto } from './storage-pool-capability.js';
import { StoragePoolsRepository, type StoragePoolDiscovery } from './storage-pools.repository.js';

type Tx = Transaction<NyabaseDatabase>;

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

export function configValue(
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

export function deriveDiscoveredFsid(
  config: Record<string, string | undefined>,
): string | null {
  return configValue(
    config,
    'cephfs.fsid',
    'cephfs.cluster_fsid',
    'ceph.cluster_fsid',
  )?.toLowerCase() ?? null;
}

export const SHAREABLE_MAPPING_UNIQUE = 'storage_pools_shared_backend_server_unique';

export function isShareableMappingUniqueViolation(error: unknown): boolean {
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

export type PendingDiscovery = {
  discovery: StoragePoolDiscovery;
  identityKey: string | null;
  discoveredFsid: string | null;
};

export type StoragePoolRow = NonNullable<Awaited<ReturnType<StoragePoolsRepository['findById']>>>;

export function toDiscoverIssue(input: {
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

export function optionalByteCount(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return String(Math.trunc(value));
  }
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    return value;
  }
  return null;
}

/** How a discovered CephFS pool maps onto the known shared backends. */
interface IdentityResolution {
  sharedBackendId: string | null;
  discoveredFsidOwnerId: string | null;
  issue?: StorageDiscoverIssueDto;
}

/**
 * Reads the pools an Incus server reports and reconciles them with the
 * `infra.storage_pools` inventory, including mapping CephFS pools onto shared
 * backends by cluster identity and FSID.
 */
@Injectable()
export class StoragePoolDiscoveryService {
  private readonly logger = new Logger(StoragePoolDiscoveryService.name);

  constructor(
    private readonly repository: StoragePoolsRepository,
    private readonly transactions: PgTransactionManager,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
  ) {}

  /** Discover one server's pools and return the local ones. */
  async discover(serverId: string): Promise<StoragePoolDiscoverResult> {
    const { rows, identityConflicts } = await this.discoverAndApply(serverId);
    return {
      pools: rows.map((row) => toAdminPoolDto(row)).filter(isLocalPoolDto),
      identityConflicts,
    };
  }

  async discoverAndApply(
    serverId: string,
  ): Promise<{ rows: StoragePoolRow[]; identityConflicts: StorageDiscoverIssueDto[] }> {
    const pending = await this.collectDiscoveries(serverId);
    return this.applyDiscoveries(serverId, pending);
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

  private applyDiscoveries(
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
            const outcome = await this.applyInSavepoint(serverId, item, current, transaction);
            if (outcome.issue) identityConflicts.push(outcome.issue);
            if (outcome.row) discovered.push(outcome.row);
            continue;
          }
          discovered.push(await this.upsertUnmapped(serverId, item, current, transaction));
        }
        return { rows: discovered, identityConflicts };
      },
      { isolationLevel: 'serializable', maxAttempts: 5 },
    );
  }

  /** A pool with no shared backend: lock any existing row, then upsert it. */
  private async upsertUnmapped(
    serverId: string,
    item: PendingDiscovery,
    current: StoragePoolRow | undefined,
    transaction: Tx,
  ): Promise<StoragePoolRow> {
    if (current) {
      await this.repository.lockCapacityScope(current.id, serverId, [], transaction);
    }
    return this.repository.upsertDiscovery(
      randomUUID(),
      { ...item.discovery, sharedBackendId: null },
      transaction,
    );
  }

  /**
   * Shared mapping runs in a savepoint so a unique-mapping race becomes a
   * reported conflict instead of aborting the whole discovery transaction.
   */
  private async applyInSavepoint(
    serverId: string,
    item: PendingDiscovery,
    current: StoragePoolRow | undefined,
    transaction: Tx,
  ): Promise<{ row?: StoragePoolRow; issue?: StorageDiscoverIssueDto }> {
    await sql`SAVEPOINT shareable_map`.execute(transaction);
    try {
      const outcome = await this.applySharedExecutorMapping(serverId, item, current, transaction);
      if (outcome.issue) this.warnDiscoverIssue(outcome.issue);
      await sql`RELEASE SAVEPOINT shareable_map`.execute(transaction);
      return outcome;
    } catch (error) {
      if (!isShareableMappingUniqueViolation(error)) throw error;
      await sql`ROLLBACK TO SAVEPOINT shareable_map`.execute(transaction);
      const issue = toDiscoverIssue({
        code: FailureCode.StoragePoolInUse,
        message: 'The shared backend already has a pool on this server',
        serverId,
        incusName: item.discovery.incusName,
        poolId: current?.id ?? null,
      });
      this.warnDiscoverIssue(issue);
      return { issue };
    }
  }

  /** Which backend the pool belongs to, and the first identity problem found (if any). */
  private async resolveIdentity(
    serverId: string,
    item: PendingDiscovery,
    current: StoragePoolRow | undefined,
    transaction: Tx,
  ): Promise<IdentityResolution> {
    let sharedBackendId: string | null = null;
    let issue: StorageDiscoverIssueDto | undefined;
    let discoveredFsidOwnerId: string | null = null;

    if (item.identityKey) {
      const backend = await this.repository.findSharedBackendByIdentity(item.identityKey, transaction);
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
      const mappedBackend = await this.repository.findSharedBackendById(
        current.shared_backend_id,
        transaction,
      );
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
      const fsidOwner = await this.repository.findSharedBackendByFsid(item.discoveredFsid, transaction);
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
    return { sharedBackendId, discoveredFsidOwnerId, issue };
  }

  private async applySharedExecutorMapping(
    serverId: string,
    item: PendingDiscovery,
    current: StoragePoolRow | undefined,
    transaction: Tx,
  ): Promise<{ row?: StoragePoolRow; issue?: StorageDiscoverIssueDto }> {
    const { sharedBackendId, discoveredFsidOwnerId, issue } = await this.resolveIdentity(
      serverId,
      item,
      current,
      transaction,
    );

    if (issue) {
      if (current?.shared_backend_id) {
        return { issue };
      }
      return { row: await this.upsertUnmapped(serverId, item, current, transaction), issue };
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
      const mapping = await this.repository.findShareableMapping(
        sharedBackendId,
        serverId,
        current?.id,
        transaction,
      );
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
      await this.repository.refreshSharedBackendCapacity(row.shared_backend_id, transaction);
    }
    return { row };
  }

  private warnDiscoverIssue(issue: StorageDiscoverIssueDto): void {
    this.logger.warn(
      `${issue.code} serverId=${issue.serverId} incusName=${issue.incusName} identityKey=${issue.identityKey}`,
    );
  }
}
