import type { ServerGrantOverrides } from './rest-schema.js';

// Resource grants: bundles (server quotas bound to one server), a user's one
// bundle per server with overrides, its data-disk quotas, shared-backend grants.

/** A named set of server quotas bound to one server; null = unlimited. */
export interface GrantBundleDto {
  id: string;
  serverId: string;
  name: string;
  /** Whole logical CPUs pinned for the user; null = every unreserved CPU. */
  cpuCores: number | null;
  memBytes: number | null;
  /** Sum of the user's system disks on the server. */
  rootDiskBytes: number | null;
  /** GPUs picked from the server's cards; null = every card, 0 = none. */
  gpuCount: number | null;
  revision: number;
  /** Server grants that use this bundle. */
  grantCount: number;
  createdAt: string;
  updatedAt: string;
}

export type GrantBundleField = 'cpuCores' | 'memBytes' | 'rootDiskBytes' | 'gpuCount';

/**
 * Disks (local pools of one server) sharing one quota. Each pool belongs to at
 * most one grant of the user; the grant is current exactly while its server
 * grant is.
 */
export interface DataDiskGrantDto {
  id: string;
  serverGrantId: string;
  userId: string;
  serverId: string;
  poolIds: string[];
  limitBytes: number;
  createdAt: string;
  updatedAt: string;
}

/** What a data-disk grant write did besides the grant itself. */
export interface DataDiskGrantChangeDto {
  /** The grant written; null after a delete. */
  grant: DataDiskGrantDto | null;
  /** Disks taken out of other grants of the user. */
  movedPools: Array<{ poolId: string; fromGrantId: string }>;
  /** Grants left without disks by the move, and deleted. */
  deletedGrantIds: string[];
  /** Disks no grant covers any more: their volumes lapse (unmounted now, deleted after the grace). */
  revokedPoolIds: string[];
}

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
  rootDiskBytes: number | null;
  gpuCount: number | null;
  /** null = never expires. */
  expiresAt: string | null;
  dataDisks: DataDiskGrantDto[];
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
  field: GrantBundleField;
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
  overridden: Array<{ field: GrantBundleField; value: number | null }>;
  /** Committed usage the new memory / system-disk quota no longer covers (running memory, system disks). */
  memBytesInUse: number | null;
  rootDiskBytesInUse: number | null;
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
  /** Registered local pools of the server; `system` marks the one system disks live on. */
  pools: Array<{
    poolId: string;
    name: string;
    driver: string;
    system: boolean;
    totalBytes: number | null;
    usedBytes: number | null;
  }>;
  gpu: {
    enabled: boolean;
    /** NVIDIA cards: live with their model, else the last observed list without one. */
    cards: Array<{ pciAddress: string; model: string | null }>;
  };
}

/** One data-disk grant of the caller: the disks sharing `limitBytes`, and their data. */
export interface DataDiskUsageDto {
  grantId: string;
  poolIds: string[];
  limitBytes: number;
  /** Observed data on the group's volumes (unknown usage counts as 0). */
  usedBytes: number;
  /** max(0, limitBytes − usedBytes). */
  availableBytes: number;
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
