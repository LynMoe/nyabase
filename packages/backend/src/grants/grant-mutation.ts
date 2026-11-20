import { NotFoundException } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { Role, UserStatus } from '@nyabase/common';
import { assertActorRole } from '../iam/administration.js';
import { requireUserId, type Actor } from '../iam/actor.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

/** Every grant mutation needs the user admin role (re-read under the IAM lock) and an existing user. */
export async function beginGrantMutation(
  transaction: Transaction<NyabaseDatabase>,
  actor: Actor,
  userId: string,
): Promise<void> {
  await assertActorRole(transaction, requireUserId(actor), Role.UserAdmin);
  await requireGrantUser(transaction, userId);
}

export async function requireGrantUser(executor: Executor, userId: string): Promise<void> {
  const user = await executor.selectFrom('iam.users')
    .select(['id', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user || user.status === UserStatus.Deleted) throw new NotFoundException('User not found');
}
