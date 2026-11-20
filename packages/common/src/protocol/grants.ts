import type { GrantDataDisk, ServerGrantOverrides } from './rest-schema.js';

// Resource grants: bundles (server quotas and data disks bound to one server),
// a user's one bundle per server with overrides, shared-backend grants.

/** A named set of server quotas bound to one server; null = unlimited. */
export interface GrantBundleDto {
  id: string;
  serverId: string;
  name: string;
  /** Whole logical CPUs pinned for the user; null = every unreserved CPU. */
  cpuCores: number | null;
  memBytes: number | null;
  /**
   * The user's system disks (committed size) and data disks (their data) on
   * the server together; never unlimited.
   */
  diskBytes: number;
  /** Ceiling of the system disks alone; null = only `diskBytes`. */
  rootDiskBytes: number | null;
  /** GPUs picked from the server's cards; null = every card, 0 = none. */
  gpuCount: number | null;
  /** Local pools of the server the user gets a data disk on, each with an optional ceiling. */
  dataDisks: GrantDataDisk[];
  revision: number;
  /** Server grants that use this bundle. */
  grantCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Bundle fields holding one number (null = unlimited where allowed). */
export type GrantBundleScalarField = 'cpuCores' | 'memBytes' | 'diskBytes' | 'rootDiskBytes' | 'gpuCount';
export type GrantBundleField = GrantBundleScalarField | 'dataDisks';

/** A user's bundle on one server (at most one per server). */
export interface ServerGrantDto {
  id: string;
  userId: string;
  serverId: string;
  bundleId: string;
  bundleName: string;
  /** Fields this grant overrides (null = unlimited); absent fields follow the bundle. */
  overrides: ServerGrantOverrides;
  /** Effective quotas: the override where there is one, else the bundle's. */
  cpuCores: number | null;
  memBytes: number | null;
  diskBytes: number;
  rootDiskBytes: number | null;
  gpuCount: number | null;
  /** Effective data disks: the grant's own list while it overrides `dataDisks`, else the bundle's. */
  dataDisks: GrantDataDisk[];
  /** null = never expires. */
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SharedBackendGrantDto {
  id: string;
  userId: string;
  sharedBackendId: string;
  limitBytes: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GrantBundleFieldChangeDto {
  field: GrantBundleScalarField;
  before: number | null;
  after: number | null;
}

/** How one server grant reacts to a proposed bundle change. */
export interface GrantBundlePreviewEntryDto {
  grantId: string;
  userId: string;
  username: string;
  displayName: string;
  /** Followed fields whose effective value changes. */
  changes: GrantBundleFieldChangeDto[];
  /** Changed bundle fields this grant overrides, so it keeps its own value. */
  overridden: Array<{ field: GrantBundleScalarField; value: number | null }>;
  /** How a changed data-disk list reaches this grant; null when the list does not change. */
  dataDisks: 'follows' | 'overridden' | null;
  /** Committed usage the new memory / system-disk ceiling no longer covers (running memory, system disks). */
  memBytesInUse: number | null;
  rootDiskBytesInUse: number | null;
  /** System disks plus data on the data disks, where the new total no longer covers them. */
  diskBytesInUse: number | null;
  /** Data disks leaving the grant on which the user has a volume: it lapses (unmounted now, deleted after the grace). */
  dataDisksRevoked: string[];
  /** Data disks whose new ceiling is below the user's data there (the rest can only be deleted). */
  dataDisksOverCap: Array<{ poolId: string; usedBytes: number; capBytes: number }>;
  /** Cards the user's containers hold that the new GPU count no longer allows. */
  gpusInUseRemoved: string[];
}

export interface GrantBundlePreviewDto {
  bundle: GrantBundleDto;
  /** The bundle after the proposed change. */
  proposed: GrantBundleDto;
  /** Unreserved CPUs and observed GPUs of the bundle's server (null until reported). */
  serverCpuCores: number | null;
  serverGpuCount: number;
  /** Grants with at least one change or one shielding override, ordered by username. */
  entries: GrantBundlePreviewEntryDto[];
}

/**
 * The hardware and storage of a bundle's server, for reference while editing a
 * bundle. Hardware is read live from the server's Incus (`live`); while the
 * server is unreachable only what the database keeps is filled in.
 */
export interface GrantServerProfileDto {
  serverId: string;
  /** True when the hardware fields come from a live Incus read just now. */
  live: boolean;
  cpu: {
    /** Socket product names, one entry per distinct model with its count. */
    models: Array<{ name: string; sockets: number }>;
    /** Logical CPUs (threads) of the last reported topology; null until reported. */
    logical: number | null;
    /** Logical CPUs no container is pinned to. */
    reserved: number;
    /** What a bundle can pin: logical minus reserved; null until reported. */
    allocatable: number | null;
  };
  /** Physical memory in bytes; null when not read live. */
  memoryBytes: number | null;
  /** Registered local pools of the server; a pool can be a system disk and a data disk at once. */
  pools: Array<{
    poolId: string;
    name: string;
    driver: string;
    /** New root disks may land on it. */
    system: boolean;
    /** Where it mounts as a data disk; null = not a data disk. */
    mountPath: string | null;
    totalBytes: number | null;
    usedBytes: number | null;
  }>;
  gpu: {
    enabled: boolean;
    /** NVIDIA cards: live with their model, else the last observed list without one. */
    cards: Array<{ pciAddress: string; model: string | null }>;
  };
}

/** A data disk the caller's server grant covers: its ceiling and the data on the caller's volume there. */
export interface DataDiskUsageDto {
  poolId: string;
  /** null = only the grant's total. */
  capBytes: number | null;
  /** Observed data on the volume (unknown usage, or no volume yet, counts as 0). */
  usedBytes: number;
}

/** What enabling a disk at a mount path would do now (no Incus calls: path checks in containers happen when mounting). */
export interface StorageMountPreviewDto {
  /** Users who get a volume on the disk. */
  volumes: Array<{ userId: string; username: string }>;
  /** Containers the disk would be mounted into. */
  mounts: Array<{ containerId: string; containerName: string; ownerId: string; serverId: string }>;
  /** Containers skipped because another of their volumes already mounts at the path. */
  pathConflicts: Array<{ containerId: string; containerName: string; ownerId: string; serverId: string }>;
}

/**
 * What a new or grown system disk may still take under a server grant
 * (AGENTS.md, 授权模型): system disks count by their committed size, data
 * disks by the data on them, and the system disks also stay under their own
 * ceiling. The Backend admits with this rule; the forms show it.
 */
export function systemDiskRoom(input: {
  diskBytes: number;
  rootDiskBytes: number | null;
  rootCommittedBytes: number;
  dataUsedBytes: number;
}): number {
  const total = input.diskBytes - input.rootCommittedBytes - input.dataUsedBytes;
  const ceiling = input.rootDiskBytes === null ? total : input.rootDiskBytes - input.rootCommittedBytes;
  return Math.max(0, Math.min(total, ceiling));
}
