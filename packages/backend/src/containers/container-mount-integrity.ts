import {
  MAX_CONTAINER_MOUNTS,
  remoteFsSourceIdentity,
} from '@nyabase/common';
import { IsNull, type EntityManager } from 'typeorm';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import {
  normalizeContainerMounts,
  type NormalizedContainerMount,
} from './container-mount-normalizer.js';

export type ContainerMountIntegrityFailureKind =
  | 'desired_invalid'
  | 'index_divergent'
  | 'source_unavailable';

/**
 * A durable mount snapshot is intentionally represented twice: compact JSON is
 * the immutable desired spec, while indexed rows protect relationship deletes
 * and supply physical resource locks. Neither representation is authoritative
 * by itself after corruption or a partial migration, so every replay path must
 * prove their exact correspondence before dispatching physical work.
 */
export class ContainerMountIntegrityError extends Error {
  constructor(
    readonly kind: ContainerMountIntegrityFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'ContainerMountIntegrityError';
  }
}

export type ResolvedContainerMount = NormalizedContainerMount & {
  resourceId: string;
  sourceIdentity: string;
};

/** One durable source-identity interpretation shared by create and replay. */
export async function resolveActiveContainerMountSources(
  manager: EntityManager,
  container: Pick<ContainerEntity, 'serverId' | 'ownerId'>,
  mounts: readonly NormalizedContainerMount[],
): Promise<ResolvedContainerMount[]> {
  const resolved: ResolvedContainerMount[] = [];
  for (const mount of mounts) {
    const dataDirs = await manager.find(DataDirectoryEntity, {
      where: {
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
        name: mount.dirName,
        userId: container.ownerId,
        desiredState: 'active',
        serverId: mount.sourceKind === 'local' ? container.serverId : IsNull(),
      },
      order: { id: 'ASC' },
      take: 2,
    });
    if (dataDirs.length !== 1) {
      throw new ContainerMountIntegrityError(
        'source_unavailable',
        'A durable container mount no longer resolves to one exact active DataDir identity',
      );
    }
    const dataDir = dataDirs[0]!;

    if (mount.sourceKind === 'remote') {
      let assignments: RemoteFsServerAssignmentEntity[];
      let remote: RemoteFsMountEntity | null;
      try {
        [assignments, remote] = await Promise.all([
          manager.find(RemoteFsServerAssignmentEntity, {
            where: {
              remoteFsMountId: mount.sourceId,
              serverId: container.serverId,
              desiredState: 'active',
            },
            order: { id: 'ASC' },
            take: 2,
          }),
          manager.findOne(RemoteFsMountEntity, {
            where: { id: mount.sourceId, desiredState: 'active' },
          }),
        ]);
      } catch (error) {
        throw new ContainerMountIntegrityError(
          'source_unavailable',
          `Durable remote container mount metadata is invalid: ${errorMessage(error)}`,
        );
      }
      let identityMatches = false;
      try {
        identityMatches = Boolean(
          remote
          && remoteFsSourceIdentity(remote.params) === dataDir.sourceIdentity,
        );
      } catch {
        identityMatches = false;
      }
      if (assignments.length !== 1 || !identityMatches) {
        throw new ContainerMountIntegrityError(
          'source_unavailable',
          'A durable remote container mount no longer has one exact active Server assignment',
        );
      }
    }

    resolved.push({
      ...mount,
      resourceId: dataDir.id,
      sourceIdentity: dataDir.sourceIdentity,
    });
  }
  return resolved;
}

export async function resolveContainerMountIntegrity(
  manager: EntityManager,
  container: Pick<ContainerEntity, 'id' | 'serverId' | 'ownerId' | 'name'>,
  desired: Pick<ContainerDesiredSpecEntity, 'mountsJson'>,
): Promise<ResolvedContainerMount[]> {
  let desiredMounts: NormalizedContainerMount[];
  try {
    desiredMounts = normalizeContainerMounts(desired.mountsJson);
  } catch (error) {
    throw new ContainerMountIntegrityError(
      'desired_invalid',
      `Durable desired mount snapshot is invalid: ${errorMessage(error)}`,
    );
  }

  const rows = await manager.find(ContainerMountEntity, {
    where: { containerId: container.id },
    order: { containerPath: 'ASC', id: 'ASC' },
    take: MAX_CONTAINER_MOUNTS + 1,
  });
  if (rows.length > MAX_CONTAINER_MOUNTS) {
    throw new ContainerMountIntegrityError(
      'index_divergent',
      'Durable container mount index exceeds the supported bound',
    );
  }
  if (rows.some((row) =>
    row.containerId !== container.id
    || row.serverId !== container.serverId
    || row.userId !== container.ownerId
    || row.containerName !== container.name
    || typeof row.sourceIdentity !== 'string'
    || row.sourceIdentity.length === 0)) {
    throw new ContainerMountIntegrityError(
      'index_divergent',
      'Durable container mount index ownership metadata is inconsistent',
    );
  }

  let indexedMounts: NormalizedContainerMount[];
  try {
    indexedMounts = normalizeContainerMounts(rows.map((row) => ({
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      dirName: row.dirName,
      containerPath: row.containerPath,
    })));
  } catch (error) {
    throw new ContainerMountIntegrityError(
      'index_divergent',
      `Durable container mount index is invalid: ${errorMessage(error)}`,
    );
  }
  if (
    rows.some((row, index) => row.containerPath !== indexedMounts[index]?.containerPath)
    || rows.length !== desiredMounts.length
  ) {
    throw new ContainerMountIntegrityError(
      'index_divergent',
      'Durable desired mount snapshot and mount index have different entries',
    );
  }

  const rowByIdentity = new Map<string, ContainerMountEntity>();
  for (let index = 0; index < rows.length; index += 1) {
    rowByIdentity.set(mountIdentity(indexedMounts[index]!), rows[index]!);
  }
  if (desiredMounts.some((mount) => !rowByIdentity.has(mountIdentity(mount)))) {
    throw new ContainerMountIntegrityError(
      'index_divergent',
      'Durable desired mount snapshot and mount index have different entries',
    );
  }

  const resolved = await resolveActiveContainerMountSources(manager, container, desiredMounts);
  for (const mount of resolved) {
    const indexed = rowByIdentity.get(mountIdentity(mount))!;
    if (mount.sourceIdentity !== indexed.sourceIdentity) {
      throw new ContainerMountIntegrityError(
        'source_unavailable',
        'A durable container mount no longer resolves to its indexed DataDir identity',
      );
    }
  }
  return resolved;
}

function mountIdentity(mount: NormalizedContainerMount): string {
  return [
    mount.sourceKind,
    mount.sourceId,
    mount.dirName,
    mount.containerPath,
  ].join('\u0000');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
