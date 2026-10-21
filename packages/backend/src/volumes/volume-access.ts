import { NotFoundException } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { isSystemActor, type Actor } from '../iam/actor.js';
import type { VolumeRow } from './volume-dtos.js';

export type VolumeAccess = 'owner' | 'admin';
export type VolumeKind = 'local' | 'shared';

/**
 * The one volume authorisation rule: a holder of the kind's administrator
 * capability (`ManageVolumes` / `ManageSharedVolumes`) gets the administrator
 * rules (no per-user grant limits, as the old /admin routes); otherwise the
 * owner gets the owner rules. Everything else, including a row of the other
 * kind, is a 404.
 */
export function assertCanAccess(
  actor: Actor,
  row: VolumeRow | undefined,
  kind: VolumeKind,
): { row: VolumeRow; access: VolumeAccess } {
  const rightKind = row !== undefined && (kind === 'local'
    ? row.shared_backend_id === null && row.server_id !== null && row.pool_id !== null
    : row.shared_backend_id !== null && row.server_id === null);
  if (!rightKind) throw new NotFoundException('Volume not found');
  return { row, access: accessOf(actor, row.owner_id, kind, 'Volume not found') };
}

/** Attaching needs the container's owner, or the kind's volume capability. */
export function assertCanAttach(
  actor: Actor,
  container: { owner_id: string },
  kind: VolumeKind,
): VolumeAccess {
  return accessOf(actor, container.owner_id, kind, 'Container not found');
}

function accessOf(
  actor: Actor,
  ownerId: string,
  kind: VolumeKind,
  notFound: string,
): VolumeAccess {
  if (
    isSystemActor(actor)
    || actor.capabilities.has(kind === 'local' ? Capability.ManageVolumes : Capability.ManageSharedVolumes)
  ) {
    return 'admin';
  }
  if (ownerId === actor.userId) return 'owner';
  throw new NotFoundException(notFound);
}

export function assertSharedExists(row: VolumeRow | undefined): asserts row is VolumeRow {
  if (!row || row.shared_backend_id === null || row.server_id !== null) {
    throw new NotFoundException('Volume not found');
  }
}
