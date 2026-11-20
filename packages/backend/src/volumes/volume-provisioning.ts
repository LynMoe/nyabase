import { overcommitAvailableBytes } from './volume-rules.js';

/**
 * Elastic quotas: one data-disk grant gives a user `limit` bytes across the
 * volumes on its disks (a shared backend grant is a group of one). The user
 * never sizes the volumes; each pass sizes them from what they hold:
 *
 *   R = limit − Σ used
 *   R > 0:  quota = used + R / n       every disk keeps R / n free, so the
 *                                      user can write to any of them until
 *                                      the group holds `limit`
 *   R ≤ 0:  quota = limit × used / Σ used   (over the grant: every disk
 *                                      shrinks by the same ratio)
 *
 * A filesystem that accepts a quota below the data it holds (dir with project
 * quotas, CephFS; checked on Incus 7.6) gets that quota at once: the volume
 * can be read and emptied, not written. Others (ZFS refuses a quota below
 * `used`) ratchet: the quota drops to the data and follows it down as the
 * user deletes, never up, until it reaches the target.
 *
 * Shrinks go first: a shrink keeps the old size reserved until a reconcile
 * verifies it (`shrinkReservation`), and a grow only takes what is left of
 * `limit` beside every volume's committed size, so Incus never holds more
 * than `limit` (beyond the per-volume floor). A multi-volume group whose usage is
 * unknown (its server is unreachable) is left alone for the pass.
 */

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * The smallest quota a volume of a group gets: Incus and XFS read a zero
 * quota as "no quota". 1 GiB, but never more than the group's equal share of
 * a small limit (a 200 MiB grant is a 200 MiB quota), and at least 1 MiB.
 */
export function quotaFloor(limitBytes: number, volumeCount: number): number {
  return Math.max(MIB, Math.min(GIB, Math.floor(limitBytes / Math.max(1, volumeCount))));
}

/** Changes smaller than this wait: 1 GiB (a tenth of a small limit), or 5 % of a volume's share of the headroom. */
function quotaStep(limitBytes: number, headroomPerVolume: number): number {
  return Math.max(MIB, Math.min(GIB, Math.floor(limitBytes / 10)), Math.floor(0.05 * Math.max(0, headroomPerVolume)));
}

export interface AllocationVolume {
  id: string;
  /** Observed data; null = unknown. A volume not created yet holds 0. */
  usedBytes: number | null;
  /** The desired quota now. */
  sizeBytes: number;
  /** max(size, shrink reservation): what Incus may still hold. */
  committedBytes: number;
  /** The filesystem accepts a quota below its data (else the quota ratchets). */
  belowUsage: boolean;
  /** The largest quota the disk can give this volume (capacity and overcommit); null = unknown, no cap. */
  capBytes: number | null;
}

/** The sizes to set, for the volumes whose size changes. */
export function allocateQuotas(limitBytes: number, volumes: readonly AllocationVolume[]): Map<string, number> {
  const result = new Map<string, number>();
  if (volumes.length === 0) return result;
  if (volumes.length === 1) {
    const volume = volumes[0]!;
    const floor = quotaFloor(limitBytes, 1);
    const size = singleTarget(limitBytes, floor, volume);
    if (size === null) return result;
    const capped = growCap(size, volume, limitBytes - volume.committedBytes);
    // A ratchet follows deletions in steps, not byte by byte; reaching the limit is exact.
    const ratcheting = capped < volume.sizeBytes && capped > Math.max(floor, limitBytes);
    if (ratcheting && volume.sizeBytes - capped < quotaStep(limitBytes, 0)) return result;
    if (capped !== volume.sizeBytes) result.set(volume.id, capped);
    return result;
  }
  if (volumes.some((volume) => volume.usedBytes === null)) return result;
  const used = volumes.map((volume) => volume.usedBytes!);
  const totalUsed = used.reduce((sum, value) => sum + value, 0);
  const headroom = limitBytes - totalUsed;
  const targets = headroom > 0
    ? waterFill(volumes, used, headroom)
    : volumes.map((volume, index) => overTarget(limitBytes, volume, used[index]!, totalUsed, volumes.length));
  const step = quotaStep(limitBytes, headroom / volumes.length);
  const floor = quotaFloor(limitBytes, volumes.length);
  // Shrinks are applied as computed; grows share what the committed sizes leave of the limit.
  let room = limitBytes - volumes.reduce((sum, volume) => sum + volume.committedBytes, 0);
  const grows: number[] = [];
  volumes.forEach((volume, index) => {
    const target = Math.max(floor, Math.floor(targets[index]!));
    if (Math.abs(target - volume.sizeBytes) < step) return;
    if (target < volume.sizeBytes) result.set(volume.id, target);
    else if (target > volume.sizeBytes) grows.push(index);
  });
  for (const index of grows) {
    const volume = volumes[index]!;
    const target = Math.max(floor, Math.floor(targets[index]!));
    const size = growCap(target, volume, room);
    if (size - volume.sizeBytes < step) continue;
    room -= Math.max(0, size - volume.committedBytes);
    result.set(volume.id, size);
  }
  return result;
}

/** A group of one: the quota is the limit (capable filesystems), or the ratchet toward it. */
function singleTarget(limitBytes: number, floor: number, volume: AllocationVolume): number | null {
  const limit = Math.max(floor, limitBytes);
  if (volume.belowUsage || limit >= volume.sizeBytes) return limit;
  if (volume.usedBytes === null) return null;
  return Math.max(limit, Math.min(volume.sizeBytes, volume.usedBytes));
}

/** Over the limit: the same ratio for every volume; a ratcheting one never below its data, never up. */
function overTarget(
  limitBytes: number,
  volume: AllocationVolume,
  used: number,
  totalUsed: number,
  count: number,
): number {
  const share = totalUsed > 0 ? Math.floor((limitBytes * used) / totalUsed) : Math.floor(limitBytes / count);
  return volume.belowUsage ? share : Math.max(share, Math.min(volume.sizeBytes, used));
}

/** used + an equal share of the headroom; a disk that cannot take its share passes the rest on. */
function waterFill(volumes: readonly AllocationVolume[], used: readonly number[], headroom: number): number[] {
  const share = new Array<number>(volumes.length).fill(0);
  let open = volumes.map((_, index) => index);
  let left = headroom;
  while (open.length > 0 && left > 0) {
    const each = left / open.length;
    const capped = open.filter((index) => {
      const cap = volumes[index]!.capBytes;
      return cap !== null && cap - used[index]! - share[index]! <= each;
    });
    if (capped.length === 0) {
      for (const index of open) share[index]! += each;
      break;
    }
    for (const index of capped) {
      const room = Math.max(0, volumes[index]!.capBytes! - used[index]! - share[index]!);
      share[index]! += room;
      left -= room;
    }
    open = open.filter((index) => !capped.includes(index));
  }
  return volumes.map((_, index) => used[index]! + share[index]!);
}

/** A grow up to `target`, within the disk's capacity and the room the group's committed sizes leave. */
function growCap(target: number, volume: AllocationVolume, room: number): number {
  if (target <= volume.sizeBytes) return target;
  let size = target;
  if (volume.capBytes !== null) size = Math.min(size, Math.max(volume.sizeBytes, volume.capBytes));
  // Up to the reservation costs nothing; past it, only what the limit leaves.
  size = Math.min(size, Math.max(volume.committedBytes, volume.sizeBytes) + Math.max(0, room));
  return Math.max(volume.sizeBytes, size);
}

// --- provisioning plan --------------------------------------------------------

/**
 * What the platform wants for every user's storage, computed from one
 * snapshot (pure, so the provisioner, its preview and the tests share it):
 *
 *  - each enabled disk (it has a mount path) a user's grant covers holds one
 *    volume of theirs;
 *  - every active container of the user mounts each of their active volumes
 *    it can reach (local: on its server; shared: through the one registered
 *    executor pool of the backend there) at the disk's mount path, unless the
 *    container already mounts something else there;
 *  - every grant's volumes are sized by `allocateQuotas`.
 *
 * A disk under maintenance gets no new volumes or mounts (its existing mounts
 * are left out of the containers by the container reconciler). Failed and
 * deleting volumes are left alone; volumes on disks no grant covers are the
 * access-lapse processor's.
 */

export type DiskKind = 'pool' | 'backend';

export interface PlanDisk {
  kind: DiskKind;
  id: string;
  /** The pool's server; null for a shared backend. */
  serverId: string | null;
  mountPath: string | null;
  maintenance: boolean;
  /** The filesystem accepts a quota below its data. */
  belowUsage: boolean;
  totalBytes: number | null;
  overcommitRatio: number;
  /** Everything committed on the disk by every user (system disks too, for a pool). */
  committedBytes: number;
}

export interface PlanGrant {
  /** The data-disk grant id, or `backend:<user>:<backend>`. */
  key: string;
  userId: string;
  limitBytes: number;
  kind: DiskKind;
  diskIds: string[];
}

export interface PlanVolume {
  id: string;
  ownerId: string;
  kind: DiskKind;
  diskId: string;
  /** Local volumes only. */
  serverId: string | null;
  phase: 'provisioning' | 'active' | 'failed';
  revision: number;
  sizeBytes: number;
  reservedBytes: number | null;
  /** Usage read this pass; null = unknown. */
  usedBytes: number | null;
  /** What else the owner commits on the disk (their system disks on a pool). */
  ownerOtherBytes: number;
}

export interface PlanContainer {
  id: string;
  ownerId: string;
  serverId: string;
  name: string;
}

export interface PlanAttachment {
  containerId: string;
  volumeId: string;
  containerPath: string;
}

export interface PlanSnapshot {
  disks: PlanDisk[];
  grants: PlanGrant[];
  volumes: PlanVolume[];
  /** Active containers. */
  containers: PlanContainer[];
  attachments: PlanAttachment[];
  /** `${backendId}\0${serverId}` → the backend's one registered executor pool on the server. */
  backendPools: Map<string, string>;
}

export interface PlannedCreate {
  ownerId: string;
  kind: DiskKind;
  diskId: string;
  serverId: string | null;
  mountPath: string;
  sizeBytes: number;
}

export interface PlannedMount {
  containerId: string;
  ownerId: string;
  serverId: string;
  volumeId: string;
  containerPath: string;
  /** The pool the volume is reached through on the container's server. */
  poolId: string;
}

export interface PlannedResize {
  volumeId: string;
  revision: number;
  sizeBytes: number;
}

export interface ProvisioningPlan {
  creates: PlannedCreate[];
  mounts: PlannedMount[];
  resizes: PlannedResize[];
  /** Mounts skipped: the container already mounts another volume at the path. */
  pathConflicts: Array<{ containerId: string; volumeId: string; containerPath: string }>;
}

export function diskKey(kind: DiskKind, id: string): string {
  return `${kind}:${id}`;
}

export function backendGrantKey(userId: string, backendId: string): string {
  return `backend:${userId}:${backendId}`;
}

type Member = { disk: PlanDisk; volume: PlanVolume | null };

function indexSnapshot(snapshot: PlanSnapshot) {
  const disks = new Map(snapshot.disks.map((disk) => [diskKey(disk.kind, disk.id), disk]));
  const volumesByOwnerDisk = new Map<string, PlanVolume>();
  for (const volume of snapshot.volumes) {
    volumesByOwnerDisk.set(`${volume.ownerId}\0${diskKey(volume.kind, volume.diskId)}`, volume);
  }
  return { disks, volumesByOwnerDisk };
}

/**
 * The volumes a grant sizes: its disks' live volumes (whether the disk is
 * still enabled or not), and a new one for each enabled disk without one.
 */
function groupMembers(grant: PlanGrant, index: ReturnType<typeof indexSnapshot>): Member[] {
  const members: Member[] = [];
  for (const diskId of grant.diskIds) {
    const disk = index.disks.get(diskKey(grant.kind, diskId));
    if (!disk) continue;
    const volume = index.volumesByOwnerDisk.get(`${grant.userId}\0${diskKey(disk.kind, disk.id)}`) ?? null;
    if (volume?.phase === 'failed') continue;
    if (!volume && (disk.mountPath === null || disk.maintenance)) continue;
    members.push({ disk, volume });
  }
  return members;
}

/**
 * Volumes whose usage this pass must read: the created ones in groups of
 * several disks, and a ratcheting volume above its limit. Every other size
 * follows from the limit alone.
 */
export function volumesNeedingUsage(snapshot: PlanSnapshot): string[] {
  const index = indexSnapshot(snapshot);
  const result: string[] = [];
  for (const grant of snapshot.grants) {
    const members = groupMembers(grant, index);
    for (const { disk, volume } of members) {
      if (!volume || volume.phase !== 'active') continue;
      if (members.length > 1 || (!disk.belowUsage && volume.sizeBytes > grant.limitBytes)) result.push(volume.id);
    }
  }
  return result;
}

export function planProvisioning(snapshot: PlanSnapshot): ProvisioningPlan {
  const index = indexSnapshot(snapshot);
  const plan: ProvisioningPlan = { creates: [], mounts: [], resizes: [], pathConflicts: [] };
  const covered = new Set<string>();
  for (const grant of snapshot.grants) {
    for (const diskId of grant.diskIds) covered.add(`${grant.userId}\0${diskKey(grant.kind, diskId)}`);
    sizeGroup(plan, grant, groupMembers(grant, index));
  }
  planMounts(plan, snapshot, index.disks, covered);
  return plan;
}

/** Sizes the grant's volumes, new ones included (as empty volumes of size 0 growing into the room). */
function sizeGroup(
  plan: ProvisioningPlan,
  grant: PlanGrant,
  members: Member[],
): void {
  const allocation: AllocationVolume[] = members.map(({ disk, volume }, index) => {
    const committed = volume ? Math.max(volume.sizeBytes, volume.reservedBytes ?? 0) : 0;
    return {
      id: volume?.id ?? `new:${index}`,
      usedBytes: !volume || volume.phase === 'provisioning' ? 0 : volume.usedBytes,
      sizeBytes: volume?.sizeBytes ?? 0,
      committedBytes: committed,
      belowUsage: disk.belowUsage,
      capBytes: disk.totalBytes === null
        ? null
        : committed + overcommitAvailableBytes(
          disk.totalBytes,
          disk.overcommitRatio,
          disk.committedBytes,
          committed + (volume?.ownerOtherBytes ?? 0),
        ),
    };
  });
  const sizes = allocateQuotas(grant.limitBytes, allocation);
  members.forEach(({ disk, volume }, index) => {
    if (!volume) {
      plan.creates.push({
        ownerId: grant.userId,
        kind: disk.kind,
        diskId: disk.id,
        serverId: disk.serverId,
        mountPath: disk.mountPath!,
        sizeBytes: Math.max(quotaFloor(grant.limitBytes, members.length), sizes.get(`new:${index}`) ?? 0),
      });
      return;
    }
    const size = sizes.get(volume.id);
    if (size !== undefined && size !== volume.sizeBytes) {
      plan.resizes.push({ volumeId: volume.id, revision: volume.revision, sizeBytes: size });
    }
  });
}

function planMounts(
  plan: ProvisioningPlan,
  snapshot: PlanSnapshot,
  disks: Map<string, PlanDisk>,
  covered: Set<string>,
): void {
  const attached = new Set(snapshot.attachments.map((row) => `${row.containerId}\0${row.volumeId}`));
  const pathOwner = new Map(snapshot.attachments.map((row) => [`${row.containerId}\0${row.containerPath}`, row.volumeId]));
  const volumesByOwner = new Map<string, PlanVolume[]>();
  for (const volume of snapshot.volumes) {
    if (volume.phase !== 'active') continue;
    if (!covered.has(`${volume.ownerId}\0${diskKey(volume.kind, volume.diskId)}`)) continue;
    const list = volumesByOwner.get(volume.ownerId) ?? [];
    list.push(volume);
    volumesByOwner.set(volume.ownerId, list);
  }
  for (const container of snapshot.containers) {
    for (const volume of volumesByOwner.get(container.ownerId) ?? []) {
      const disk = disks.get(diskKey(volume.kind, volume.diskId));
      if (!disk?.mountPath || disk.maintenance) continue;
      const poolId = volume.kind === 'pool'
        ? (volume.serverId === container.serverId ? volume.diskId : null)
        : snapshot.backendPools.get(`${volume.diskId}\0${container.serverId}`) ?? null;
      if (!poolId) continue;
      if (attached.has(`${container.id}\0${volume.id}`)) continue;
      const taken = pathOwner.get(`${container.id}\0${disk.mountPath}`);
      if (taken !== undefined) {
        if (taken !== volume.id) {
          plan.pathConflicts.push({ containerId: container.id, volumeId: volume.id, containerPath: disk.mountPath });
        }
        continue;
      }
      pathOwner.set(`${container.id}\0${disk.mountPath}`, volume.id);
      plan.mounts.push({
        containerId: container.id,
        ownerId: container.ownerId,
        serverId: container.serverId,
        volumeId: volume.id,
        containerPath: disk.mountPath,
        poolId,
      });
    }
  }
}
