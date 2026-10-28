import { createHash } from 'node:crypto';
import type {
  GrantBundleDto,
  GrantBundleField,
  GrantBundleQuotas,
  ServerGrantOverrides,
} from '@nyabase/common';

/**
 * The four server quotas a bundle defines and a grant may override: the DTO
 * key, the token stored in `iam.server_grants.overridden`, and the column
 * (same name on `iam.grant_bundles` and `iam.server_grants`).
 */
export const GRANT_QUOTA_FIELDS = [
  { key: 'cpuCores', token: 'cpu', column: 'cpu_cores' },
  { key: 'memBytes', token: 'mem', column: 'mem_bytes' },
  { key: 'rootDiskBytes', token: 'root_disk', column: 'root_disk_bytes' },
  { key: 'gpuCount', token: 'gpu', column: 'gpu_count' },
] as const satisfies ReadonlyArray<{ key: GrantBundleField; token: string; column: string }>;

export type QuotaColumns = {
  cpu_cores: number | null;
  mem_bytes: string | number | null;
  root_disk_bytes: string | number | null;
  gpu_count: number | null;
};

function quota(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

export function quotasFromColumns(row: QuotaColumns): GrantBundleQuotas {
  return {
    cpuCores: row.cpu_cores,
    memBytes: quota(row.mem_bytes),
    rootDiskBytes: quota(row.root_disk_bytes),
    gpuCount: row.gpu_count,
  };
}

export function quotaColumns(quotas: GrantBundleQuotas): QuotaColumns {
  return {
    cpu_cores: quotas.cpuCores,
    mem_bytes: quotas.memBytes,
    root_disk_bytes: quotas.rootDiskBytes,
    gpu_count: quotas.gpuCount,
  };
}

/** The `overridden` tokens and override columns of a grant; a field not overridden stores NULL. */
export function overrideColumns(overrides: ServerGrantOverrides): QuotaColumns & { overridden: string[] } {
  const columns: QuotaColumns = { cpu_cores: null, mem_bytes: null, root_disk_bytes: null, gpu_count: null };
  const overridden: string[] = [];
  for (const field of GRANT_QUOTA_FIELDS) {
    if (!(field.key in overrides)) continue;
    overridden.push(field.token);
    (columns as Record<string, number | null>)[field.column] = overrides[field.key] ?? null;
  }
  return { ...columns, overridden };
}

export function overridesFromColumns(row: QuotaColumns & { overridden: string[] }): ServerGrantOverrides {
  const values = quotasFromColumns(row);
  const overrides: ServerGrantOverrides = {};
  for (const field of GRANT_QUOTA_FIELDS) {
    if (row.overridden.includes(field.token)) overrides[field.key] = values[field.key];
  }
  return overrides;
}

/** A grant's effective quotas: its override where it has one, else the bundle's (as the effective view computes). */
export function effectiveQuotas(
  bundle: GrantBundleQuotas,
  overrides: ServerGrantOverrides,
): GrantBundleQuotas {
  const result = { ...bundle };
  for (const field of GRANT_QUOTA_FIELDS) {
    if (field.key in overrides) result[field.key] = overrides[field.key] ?? null;
  }
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

export function bundleDto(row: BundleRow, grantCount: number): GrantBundleDto {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    ...quotasFromColumns(row),
    revision: Number(row.revision),
    grantCount,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
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
