import { ConflictException, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { FailureCode, StoragePoolResizeFamily, mountPathsOverlap } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { isLocalPoolRow } from './storage-pool-capability.js';

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

/**
 * A disk is a local data pool or a shared backend. Enabled (it has a mount
 * path), every covered user gets one volume on it, mounted at that path in
 * all their containers; under maintenance it is left out of the containers.
 */
export type DiskRef = { kind: 'pool'; id: string; serverId: string } | { kind: 'backend'; id: string };

export interface DiskChange {
  disk: DiskRef;
  /** Maintenance flipped: containers mounting the disk must be rewritten. */
  maintenanceChanged: boolean;
}

/**
 * In-process signal that a disk's mount path or maintenance changed. Writers
 * fire it through `afterCommit`; the volume provisioner listens, creates and
 * mounts volumes and rewrites containers. A missed signal only costs latency:
 * the provisioner also runs periodically and the container scan rewrites any
 * instance whose devices differ.
 */
@Injectable()
export class DiskChangeNotifier {
  private readonly listeners = new Set<(change: DiskChange) => void>();

  notify(change: DiskChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A listener failure must not fail the committed write.
      }
    }
  }

  onChange(listener: (change: DiskChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Whether a local pool can be a data disk: registered, local and with an
 * online quota that Incus enforces (a block-backed volume cannot be shrunk
 * while mounted, nor mounted in several running containers).
 */
export function assertPoolMountable(pool: {
  registered: boolean;
  shareable: boolean;
  driver: string;
  shared_backend_id: string | null;
  resize_family: string;
  quota_effective: boolean | null;
}): void {
  const reason = !pool.registered
    ? 'unregistered'
    : !isLocalPoolRow(pool)
      ? 'not_local'
      : pool.resize_family !== StoragePoolResizeFamily.QuotaOnline
        ? 'block_backed'
        : pool.quota_effective !== true
          ? 'quota_ineffective'
          : null;
  if (reason) {
    throw new ConflictException({
      code: FailureCode.StorageMountUnsupported,
      message: 'This storage pool cannot be a data disk',
      details: { reason },
    });
  }
}

/**
 * Every disk that can appear in one container must mount at a path no other
 * disk's path equals or nests in: local pools of the same server, and every
 * shared backend (a backend can be mounted on any server).
 */
export async function assertMountPathFree(
  executor: Executor,
  mountPath: string,
  disk: DiskRef,
): Promise<void> {
  const pools = await executor.selectFrom('infra.storage_pools')
    .select(['id', 'server_id', 'mount_path'])
    .where('mount_path', 'is not', null)
    .execute();
  const backends = await executor.selectFrom('infra.shared_backends')
    .select(['id', 'mount_path'])
    .where('mount_path', 'is not', null)
    .execute();
  const others = [
    ...pools
      .filter((pool) => !(disk.kind === 'pool' && pool.id === disk.id))
      .filter((pool) => disk.kind === 'backend' || pool.server_id === disk.serverId)
      .map((pool) => ({ kind: 'pool' as const, id: pool.id, path: pool.mount_path! })),
    ...backends
      .filter((backend) => !(disk.kind === 'backend' && backend.id === disk.id))
      .map((backend) => ({ kind: 'backend' as const, id: backend.id, path: backend.mount_path! })),
  ];
  const clash = others.find((other) => mountPathsOverlap(other.path, mountPath));
  if (clash) {
    throw new ConflictException({
      code: FailureCode.StorageMountPathConflict,
      message: 'Another disk already mounts at or around this path',
      details: { mountPath, conflict: clash },
    });
  }
}
