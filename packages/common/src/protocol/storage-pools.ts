import type {
  FailureCode,
  ServerStatus,
  StoragePoolDriver,
  StoragePoolResizeFamily,
} from '../enums.js';
import type { DataDiskUsageDto } from './grants.js';

// Local storage pools of a server (system disks, data disks) and shared backend executors.

export interface StoragePoolCapabilityDto {
  growOnline: boolean;
  shrinkOnline: boolean;
  shrinkRequiresStop: boolean;
  shrinkNever: boolean;
  enforceUsageFloor: boolean;
}

export interface StoragePoolSystemDiskDto {
  /** Relative chance under random placement (1–100). */
  weight: number;
  /** No new root disk once observed used / total reaches this percentage; null = no mark. */
  maxUsedPercent: number | null;
}

export interface StoragePoolRootDisksDto {
  /** Containers (neither failed nor deleting) whose root disk is on the pool. */
  count: number;
  /** Their committed root sizes (including unapplied shrink reservations). */
  committedBytes: number;
}

export interface StoragePoolDto {
  id: string;
  serverId: string;
  incusName: string;
  displayName: string | null;
  /** Incus config.source. Admin list/discover/PATCH only; user GET is always null. */
  source: string | null;
  driver: StoragePoolDriver;
  resizeFamily: StoragePoolResizeFamily;
  rootDiskCapable: boolean;
  shareable: boolean;
  blockFilesystem: string | null;
  sharedBackendId: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
  quotaEffective: boolean | null;
  registered: boolean;
  /** Where the pool mounts as a data disk in every container of its users; null = not a data disk. */
  mountPath: string | null;
  /** A disk under maintenance is left out of every container. */
  maintenance: boolean;
  /** The system disk role and its parameters; null = new root disks never land here. */
  systemDisk: StoragePoolSystemDiskDto | null;
  /** Live root disks on the pool (administrators only; null for users). */
  rootDisks: StoragePoolRootDisksDto | null;
  capability: StoragePoolCapabilityDto;
  lastObservedAt: string | null;
  revision: number;
}

export interface StorageCapacityPoolDto {
  poolId: string;
  displayName: string | null;
  driver: StoragePoolDriver;
  shareable: boolean;
  totalBytes: number | null;
  committedBytes: number;
  availableBytes: number | null;
  quotaEffective: boolean | null;
  overcommitRatio: number;
  capability: StoragePoolCapabilityDto;
  mountPath: string | null;
  maintenance: boolean;
  /**
   * `scope=mine`: the caller's data-disk grant covering this pool, for its whole
   * group of disks; null without one (and always in the `scope=all` view).
   */
  grant: DataDiskUsageDto | null;
}

export interface StorageCapacityDto {
  /** `scope=mine`: the caller's system-disk quota on the server (null = unlimited, and in `scope=all`). */
  rootDiskLimitBytes: number | null;
  usedByRootDisksBytes: number;
  rootDiskAvailableBytes: number | null;
  usedByLocalVolumesBytes: number;
  pools: StorageCapacityPoolDto[];
}

export interface SharedBackendExecutorDto {
  id: string;
  backendId: string;
  serverId: string;
  serverName: string;
  serverStatus: ServerStatus;
  incusName: string;
  registered: boolean;
  totalBytes: number | null;
  usedBytes: number | null;
  lastObservedAt: string | null;
  revision: number;
}

export interface StorageDiscoverIssueDto {
  code:
    | typeof FailureCode.SharedBackendIdentityConflict
    | typeof FailureCode.StoragePoolInUse
    | typeof FailureCode.ServerUnreachable;
  message: string;
  identityKey: string | null;
  expectedFsid: string | null;
  discoveredFsid: string | null;
  existingIdentityKey: string | null;
  serverId: string | null;
  incusName: string | null;
  poolId: string | null;
}

export interface StoragePoolDiscoverResult {
  pools: StoragePoolDto[];
  identityConflicts: StorageDiscoverIssueDto[];
}
