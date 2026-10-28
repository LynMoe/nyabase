import { ForbiddenException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { Role, roleAtLeast, UserStatus } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

/**
 * The administration rules, in one place:
 *
 *  - Users, bundles and grants are administered by user admins and admins (the route
 *    guard says so; `assertActorRole` re-checks inside the write transaction).
 *    Only an admin changes roles or administers an admin
 *    (`assertCanAdministerUser`).
 *  - The final active administrator is protected.
 *  - Every IAM write serialises on one advisory lock, so these checks see the
 *    state they will commit against.
 */
const IAM_POLICY_LOCK = 'nyabase:iam-policy';

/** Transaction-scoped; re-entrant for the same transaction. */
export async function lockIamPolicy(transaction: Transaction<NyabaseDatabase>): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${IAM_POLICY_LOCK}, 0))`
    .execute(transaction);
}

/**
 * The actor must be an active user holding at least `minimum`, read inside the
 * transaction so a concurrent demotion or disable cannot slip past the route
 * guard.
 */
export async function assertActorRole(
  transaction: Transaction<NyabaseDatabase>,
  actorId: string,
  minimum: Role,
): Promise<Role> {
  await lockIamPolicy(transaction);
  const actor = await transaction.selectFrom('iam.users')
    .select(['role', 'status'])
    .where('id', '=', actorId)
    .executeTakeFirst();
  if (!actor || actor.status !== UserStatus.Active || !roleAtLeast(actor.role as Role, minimum)) {
    throw new ForbiddenException({
      code: 'ROLE_REQUIRED',
      message: `The actor does not hold the required role: ${minimum}`,
      requiredRole: minimum,
    });
  }
  return actor.role as Role;
}

/**
 * The actor may administer `targetId` (edit, disable, delete, remove SSH
 * keys): user admins administer everyone but admins, admins everyone. The
 * target's role is read under the IAM lock, so a concurrent promotion cannot
 * slip past it.
 */
export async function assertCanAdministerUser(
  transaction: Transaction<NyabaseDatabase>,
  actorId: string,
  targetId: string,
): Promise<void> {
  if (await assertActorRole(transaction, actorId, Role.UserAdmin) === Role.Admin) return;
  const target = await transaction.selectFrom('iam.users')
    .select('role')
    .where('id', '=', targetId)
    .executeTakeFirst();
  if (target?.role === Role.Admin) {
    throw new ForbiddenException({
      code: 'ADMINISTRATOR_PROTECTED',
      message: 'Only an admin can administer an admin',
    });
  }
}

/** Whether an active administrator exists, optionally ignoring `excludedUserId`. */
export async function hasActiveAdministrator(
  executor: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>,
  excludedUserId?: string,
): Promise<boolean> {
  let query = executor.selectFrom('iam.users')
    .select('id')
    .where('role', '=', Role.Admin)
    .where('status', '=', UserStatus.Active);
  if (excludedUserId !== undefined) query = query.where('id', '!=', excludedUserId);
  return (await query.executeTakeFirst()) !== undefined;
}

/**
 * Demoting, disabling or deleting `userId` must leave another active
 * administrator. A target that is not an active administrator is a no-op.
 */
export async function assertNotLastAdministrator(
  transaction: Transaction<NyabaseDatabase>,
  userId: string,
): Promise<void> {
  await lockIamPolicy(transaction);
  const target = await transaction.selectFrom('iam.users')
    .select(['role', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!target || target.role !== Role.Admin || target.status !== UserStatus.Active) return;
  if (!await hasActiveAdministrator(transaction, userId)) {
    throw new ForbiddenException({
      code: 'LAST_ACTIVE_ADMINISTRATOR',
      message: 'The final active administrator cannot be removed',
    });
  }
}
