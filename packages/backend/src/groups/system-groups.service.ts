import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import { Capability, SystemGroupKey, UserStatus } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { lockIamPolicy } from '../iam/administration.js';
import { SYSTEM_ACTOR_USERNAME } from '../iam/actor.js';
import { toIamGroup, type IamGroup } from './groups.service.js';

export const SYSTEM_ACTOR_DISPLAY_NAME = 'Nyabase System';
export const SYSTEM_ACTOR_PREFERRED_NUMERIC_ID = 4096;
const SYSTEM_ACTOR_NUMERIC_ID_MAX = 4096;
/** Numeric ids commonly hardcoded in tests; skip them when 4096 is taken. */
const TEST_RESERVED_NUMERIC_IDS = new Set([1, 100, 1001, 3001]);
/**
 * Same unusable Argon2id sentinel as AuthService's dummy hash. Not a login
 * password; nyabase-system stays disabled and never joins a human group.
 */
const UNUSABLE_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$DCw8KRwf+V7pMnhiRFOb6g$KSjgFxwH2WqyoDT2q5Hz0Z18Zv/+eAHbnRgKiC6dI5A';

const OPERATOR_CAPABILITIES = [
  Capability.ManageServers,
  Capability.ManageImages,
  Capability.ManageGrants,
  Capability.ManageContainersAny,
  Capability.ViewAudit,
  Capability.ViewMetricsAll,
  Capability.ManageSystemSettings,
];

export function pickSystemActorNumericId(used: Iterable<number>): number {
  const occupied = new Set(used);
  if (!occupied.has(SYSTEM_ACTOR_PREFERRED_NUMERIC_ID)) {
    return SYSTEM_ACTOR_PREFERRED_NUMERIC_ID;
  }
  for (let id = SYSTEM_ACTOR_NUMERIC_ID_MAX; id >= 1; id -= 1) {
    if (!occupied.has(id) && !TEST_RESERVED_NUMERIC_IDS.has(id)) return id;
  }
  for (let id = SYSTEM_ACTOR_NUMERIC_ID_MAX; id >= 1; id -= 1) {
    if (!occupied.has(id)) return id;
  }
  throw new ConflictException({
    code: 'USER_LIFETIME_CAPACITY_REACHED',
    message: 'No free numeric_id remains for nyabase-system',
  });
}

/**
 * Seeds the built-in groups (R1: Administrators = every capability,
 * Operators = the operations subset, Users = none) and the `nyabase-system`
 * actor on every start.
 */
@Injectable()
export class SystemGroupsService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
  ) {}

  async ensureSystemGroups(): Promise<{ admins: IamGroup; operators: IamGroup; users: IamGroup }> {
    return this.transactions.run(async (transaction) => {
      await lockIamPolicy(transaction);
      const result = {
        admins: await this.ensureSystemGroup(
          transaction,
          SystemGroupKey.Administrators,
          'Administrators',
          Object.values(Capability),
        ),
        operators: await this.ensureSystemGroup(
          transaction,
          SystemGroupKey.Operators,
          'Operators',
          OPERATOR_CAPABILITIES,
        ),
        users: await this.ensureSystemGroup(transaction, SystemGroupKey.Users, 'Users', []),
      };
      await this.ensureSystemActor(transaction);
      return result;
    });
  }

  /** Bootstrap-only membership insert (no actor): used for the initial administrator. */
  async ensureUserInSystemGroup(systemKey: SystemGroupKey, userId: string): Promise<void> {
    const group = await this.database.selectFrom('iam.groups')
      .select('id')
      .where('system_key', '=', systemKey)
      .executeTakeFirst();
    if (!group) throw new NotFoundException('System group not found');
    await this.transactions.run(async (transaction) => {
      await lockIamPolicy(transaction);
      await transaction.insertInto('iam.group_members')
        .values({ id: randomUUID(), group_id: group.id, user_id: userId })
        .onConflict((conflict) => conflict.columns(['group_id', 'user_id']).doNothing())
        .execute();
    });
  }

  private async ensureSystemActor(transaction: Transaction<NyabaseDatabase>): Promise<string> {
    const existing = await transaction.selectFrom('iam.users')
      .select(['id', 'numeric_id'])
      .where('username', '=', SYSTEM_ACTOR_USERNAME)
      .executeTakeFirst();
    if (existing) {
      await transaction.updateTable('iam.users')
        .set({
          display_name: SYSTEM_ACTOR_DISPLAY_NAME,
          status: UserStatus.Disabled,
          password_hash: UNUSABLE_PASSWORD_HASH,
          updated_at: new Date(),
        })
        .where('id', '=', existing.id)
        .execute();
      await this.stripSystemGroupMembership(transaction, existing.id);
      return existing.id;
    }

    const occupied = await transaction.selectFrom('iam.users').select('numeric_id').execute();
    const numericId = pickSystemActorNumericId(occupied.map((row) => row.numeric_id));
    const now = new Date();
    await transaction.insertInto('iam.users')
      .values({
        id: randomUUID(),
        numeric_id: numericId,
        username: SYSTEM_ACTOR_USERNAME,
        password_hash: UNUSABLE_PASSWORD_HASH,
        display_name: SYSTEM_ACTOR_DISPLAY_NAME,
        status: UserStatus.Disabled,
        auth_version: 0,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.column('username').doNothing())
      .execute();
    const created = await transaction.selectFrom('iam.users')
      .select('id')
      .where('username', '=', SYSTEM_ACTOR_USERNAME)
      .executeTakeFirst();
    if (!created) {
      throw new ConflictException('System actor nyabase-system could not be initialized');
    }
    await this.stripSystemGroupMembership(transaction, created.id);
    return created.id;
  }

  private async stripSystemGroupMembership(
    transaction: Transaction<NyabaseDatabase>,
    userId: string,
  ): Promise<void> {
    const groups = await transaction.selectFrom('iam.groups')
      .select('id')
      .where('system_key', 'in', [
        SystemGroupKey.Administrators,
        SystemGroupKey.Operators,
        SystemGroupKey.Users,
      ])
      .execute();
    if (groups.length === 0) return;
    await transaction.deleteFrom('iam.group_members')
      .where('user_id', '=', userId)
      .where('group_id', 'in', groups.map((group) => group.id))
      .execute();
  }

  private async ensureSystemGroup(
    transaction: Transaction<NyabaseDatabase>,
    systemKey: SystemGroupKey,
    name: string,
    capabilities: Capability[],
  ): Promise<IamGroup> {
    const row = await transaction.insertInto('iam.groups')
      .values({
        id: randomUUID(),
        name,
        description: null,
        is_system: true,
        system_key: systemKey,
        capabilities,
        revision: 1,
      })
      .onConflict((conflict) => conflict.column('system_key').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (row) return toIamGroup(row);

    const existing = await transaction.selectFrom('iam.groups')
      .selectAll()
      .where('system_key', '=', systemKey)
      .executeTakeFirst();
    if (!existing) {
      throw new ConflictException(`System group ${systemKey} could not be initialized`);
    }
    const desired = [...capabilities].sort();
    const current = [...(existing.capabilities ?? [])].sort();
    if (desired.join('\0') === current.join('\0')) return toIamGroup(existing);
    const updated = await transaction.updateTable('iam.groups')
      .set({
        capabilities,
        revision: Number(existing.revision) + 1,
        updated_at: new Date(),
      })
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toIamGroup(updated);
  }
}
