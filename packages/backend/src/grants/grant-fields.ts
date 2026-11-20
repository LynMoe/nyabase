import { createHash } from 'node:crypto';
import type {
  GrantBundleDto,
  GrantBundleQuotas,
  GrantBundleScalarField,
  GrantDataDisk,
  ServerGrantOverrides,
} from '@nyabase/common';

/**
 * The server quotas holding one number that a bundle defines and a grant may
 * override: the DTO key, the token stored in `iam.server_grants.overridden`,
 * and the column (same name on `iam.grant_bundles` and `iam.server_grants`).
 * The data-disk list (`dataDisks`, token `data_disks`) is the one field kept
 * in rows: `iam.grant_bundle_disks` and `iam.storage_pool_grants`.
 */
export const GRANT_QUOTA_FIELDS = [
  { key: 'cpuCores', token: 'cpu', column: 'cpu_cores' },
  { key: 'memBytes', token: 'mem', column: 'mem_bytes' },
  { key: 'diskBytes', token: 'disk', column: 'disk_bytes' },
  { key: 'rootDiskBytes', token: 'root_disk', column: 'root_disk_bytes' },
  { key: 'gpuCount', token: 'gpu', column: 'gpu_count' },
] as const satisfies ReadonlyArray<{ key: GrantBundleScalarField; token: string; column: string }>;

export const DATA_DISKS_TOKEN = 'data_disks';

export type ScalarQuotas = Omit<GrantBundleQuotas, 'dataDisks'>;

export type QuotaColumns = {
  cpu_cores: number | null;
  mem_bytes: string | number | null;
  /** Never null on a bundle; on a grant, set exactly when `disk` is overridden. */
  disk_bytes: string | number | null;
  root_disk_bytes: string | number | null;
  gpu_count: number | null;
};

function quota(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

/** A bundle's scalar quotas (its `disk_bytes` is never null). */
export function quotasFromColumns(row: QuotaColumns): ScalarQuotas {
  if (row.disk_bytes === null) throw new Error('A bundle always has a disk total');
  return {
    cpuCores: row.cpu_cores,
    memBytes: quota(row.mem_bytes),
    diskBytes: Number(row.disk_bytes),
    rootDiskBytes: quota(row.root_disk_bytes),
    gpuCount: row.gpu_count,
  };
}

export function quotaColumns(quotas: ScalarQuotas): QuotaColumns & { disk_bytes: number } {
  return {
    cpu_cores: quotas.cpuCores,
    mem_bytes: quotas.memBytes,
    disk_bytes: quotas.diskBytes,
    root_disk_bytes: quotas.rootDiskBytes,
    gpu_count: quotas.gpuCount,
  };
}

/**
 * The `overridden` tokens and override columns of a grant; a field not
 * overridden stores NULL. `dataDisks` only adds its token: its list goes to
 * `iam.storage_pool_grants` (`writeGrantDataDisks`).
 */
export function overrideColumns(overrides: ServerGrantOverrides): QuotaColumns & { overridden: string[] } {
  const columns: QuotaColumns = {
    cpu_cores: null, mem_bytes: null, disk_bytes: null, root_disk_bytes: null, gpu_count: null,
  };
  const overridden: string[] = [];
  for (const field of GRANT_QUOTA_FIELDS) {
    if (!(field.key in overrides)) continue;
    overridden.push(field.token);
    (columns as Record<string, number | null>)[field.column] = overrides[field.key] ?? null;
  }
  if (overrides.dataDisks !== undefined) overridden.push(DATA_DISKS_TOKEN);
  return { ...columns, overridden };
}

/** A grant's overrides from its row and, when it overrides `data_disks`, its own list. */
export function overridesFromColumns(
  row: QuotaColumns & { overridden: string[] },
  ownDataDisks: GrantDataDisk[] = [],
): ServerGrantOverrides {
  const overrides: ServerGrantOverrides = {};
  const values: Record<GrantBundleScalarField, number | null> = {
    cpuCores: row.cpu_cores,
    memBytes: quota(row.mem_bytes),
    diskBytes: quota(row.disk_bytes),
    rootDiskBytes: quota(row.root_disk_bytes),
    gpuCount: row.gpu_count,
  };
  for (const field of GRANT_QUOTA_FIELDS) {
    if (!row.overridden.includes(field.token)) continue;
    (overrides as Record<string, number | null>)[field.key] = values[field.key];
  }
  if (row.overridden.includes(DATA_DISKS_TOKEN)) overrides.dataDisks = ownDataDisks;
  return overrides;
}

/** A grant's effective quotas: its override where it has one, else the bundle's (as the effective views compute). */
export function effectiveQuotas<T extends ScalarQuotas & { dataDisks?: GrantDataDisk[] }>(
  bundle: T,
  overrides: ServerGrantOverrides,
): T {
  const result = { ...bundle };
  for (const field of GRANT_QUOTA_FIELDS) {
    if (field.key in overrides) (result as unknown as Record<string, number | null>)[field.key] = overrides[field.key] ?? null;
  }
  if (overrides.dataDisks !== undefined) result.dataDisks = overrides.dataDisks;
  return result;
}

export type BundleRow = QuotaColumns & {
  id: string;
  server_id: string;
  name: string;
  revision: string | number;
  created_at: Date;
  updated_at: Date;
};

export function bundleDto(row: BundleRow, grantCount: number, dataDisks: GrantDataDisk[]): GrantBundleDto {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    ...quotasFromColumns(row),
    dataDisks,
    revision: Number(row.revision),
    grantCount,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The same data disks with the same ceilings, in any order. */
export function sameDataDisks(left: readonly GrantDataDisk[], right: readonly GrantDataDisk[]): boolean {
  if (left.length !== right.length) return false;
  const caps = new Map(left.map((disk) => [disk.poolId, disk.capBytes]));
  return right.every((disk) => caps.has(disk.poolId) && caps.get(disk.poolId) === disk.capBytes);
}

/**
 * The cards a grant of `count` GPUs (null = all) allows `userId`: the server's
 * observed cards ranked by md5(user id, PCI address). This is the rule of
 * `iam.effective_server_access`, which decides admission; the TypeScript twin
 * only lets a preview say which held cards a new count would drop.
 */
export function pickGrantGpus(
  userId: string,
  observed: readonly string[],
  count: number | null,
): string[] {
  const ranked = [...observed]
    .map((address) => ({
      address,
      rank: createHash('md5').update(`${userId}/${address}`).digest('hex'),
    }))
    .sort((left, right) => compare(left.rank, right.rank) || compare(left.address, right.address));
  return ranked
    .slice(0, count ?? ranked.length)
    .map((entry) => entry.address)
    .sort(compare);
}

function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
