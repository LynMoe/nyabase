import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import type { Transaction } from 'kysely';
import type { AccessResolverService } from '../iam/access-resolver.service.js';
import { isSystemActor, type Actor } from '../iam/actor.js';
import type { ServerAccess } from '../iam/effective-access.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

export type ContainerAccess = 'owner' | 'admin' | 'system';

/**
 * The one container authorisation rule: a holder of `ManageContainersAny`
 * (administrator rules: no server-grant limits), else the owner (owner rules:
 * live server grant and its limits), or the system. Everyone else is refused
 * with the status the owner-only route always used (403 for reads and power
 * actions, 404 where the row is hidden). A holder who also owns the row keeps
 * the administrator rules, as the old /admin route gave them.
 */
export function assertCanAccess(
  actor: Actor,
  row: { owner_id: string },
  denied: 'forbidden' | 'not-found' = 'forbidden',
): ContainerAccess {
  if (isSystemActor(actor)) return 'system';
  if (actor.capabilities.has(Capability.ManageContainersAny)) return 'admin';
  if (row.owner_id === actor.userId) return 'owner';
  if (denied === 'not-found') throw new NotFoundException('Container not found');
  throw new ForbiddenException('Container is not owned by current user');
}

/** Re-checks `ManageContainersAny` against the database inside the transaction. */
export async function assertAdminInTransaction(
  access: AccessResolverService,
  transaction: Transaction<NyabaseDatabase>,
  actor: Actor,
): Promise<void> {
  await access.assertActorCapabilitiesInTransaction(
    transaction,
    actor.userId,
    [Capability.ManageContainersAny],
  );
}

/** The owner must hold current coverage of the container's server. */
export async function requireLiveGrant(
  access: AccessResolverService,
  transaction: Transaction<NyabaseDatabase>,
  actor: Actor,
  container: { server_id: string },
): Promise<ServerAccess> {
  const grant = await access.resolveServerInTransaction(
    transaction,
    actor.userId,
    container.server_id,
  );
  if (!grant) throw new ForbiddenException('Server access was revoked');
  return grant;
}

/**
 * Owners must still hold a live server grant, administrators must still hold
 * the capability; the system needs neither. Returns the owner's grant.
 */
export async function enforceInTransaction(
  access: AccessResolverService,
  transaction: Transaction<NyabaseDatabase>,
  actor: Actor,
  container: { server_id: string },
  level: ContainerAccess,
): Promise<ServerAccess | null> {
  if (level === 'admin') await assertAdminInTransaction(access, transaction, actor);
  if (level === 'owner') return requireLiveGrant(access, transaction, actor, container);
  return null;
}
