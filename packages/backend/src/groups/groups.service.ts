import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AuditAction,
  Role,
  UserStatus,
  type GroupDto,
  type GroupMemberDto,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { afterCommit } from '../platform/post-commit.js';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import type { Actor } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import { assertActorRole } from '../iam/administration.js';
import { requireUserId } from '../iam/actor.js';

type GroupTransaction = Transaction<NyabaseDatabase>;

export interface IamGroup {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toIamGroup(row: {
  id: string;
  name: string;
  description: string | null;
  revision: string | number;
  created_at: Date;
  updated_at: Date;
}): IamGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Groups and their members; a group only batches resource grants. Managing
 * groups is admin-only. Removing a member or deleting a group never refuses because the user owns
 * resources: coverage simply lapses and the access-lapse processor stops and
 * later purges the resources (14-day grace).
 */
@Injectable()
export class GroupsService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly audit: AuditService,
    private readonly changes: AccessChangeNotifier,
  ) {}

  async findAll(): Promise<GroupDto[]> {
    const rows = await this.database.selectFrom('iam.groups')
      .selectAll()
      .orderBy('name')
      .execute();
    const members = await this.database.selectFrom('iam.group_members as member')
      .innerJoin('iam.users as user', 'user.id', 'member.user_id')
      .select([
        'member.group_id',
        'user.id as user_id',
        'user.username',
        'user.display_name',
      ])
      .execute();
    const byGroup = new Map<string, GroupMemberDto[]>();
    for (const member of members) {
      const list = byGroup.get(member.group_id) ?? [];
      list.push({
        userId: member.user_id,
        username: member.username,
        displayName: member.display_name,
      });
      byGroup.set(member.group_id, list);
    }
    return rows.map((row) => ({
      ...this.toDto(toIamGroup(row)),
      members: byGroup.get(row.id) ?? [],
      memberCount: byGroup.get(row.id)?.length ?? 0,
    }));
  }

  async findById(id: string): Promise<IamGroup> {
    const row = await this.database.selectFrom('iam.groups')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Group not found');
    return toIamGroup(row);
  }

  async getDto(id: string): Promise<GroupDto> {
    const group = await this.findById(id);
    const members = await this.listMembers(id);
    return { ...this.toDto(group), members, memberCount: members.length };
  }

  async create(
    actor: Actor,
    input: { name: string; description?: string },
  ): Promise<GroupDto> {
    const group = await this.transactions.run(async (transaction) => {
      await assertActorRole(transaction, requireUserId(actor), Role.Admin);
      const duplicate = await transaction.selectFrom('iam.groups')
        .select('id')
        .where('name', '=', input.name)
        .executeTakeFirst();
      if (duplicate) throw new ConflictException('Group name already exists');
      const row = await transaction.insertInto('iam.groups')
        .values({
          id: randomUUID(),
          name: input.name,
          description: input.description ?? null,
          revision: 1,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.CreateGroup,
        row.id,
        'group',
        { name: row.name },
      );
      return toIamGroup(row);
    });
    return this.toDto(group);
  }

  async update(
    actor: Actor,
    id: string,
    input: { name?: string; description?: string | null },
    expectedRevision: number,
  ): Promise<GroupDto> {
    const group = await this.transactions.run(async (transaction) => {
      const current = await transaction.selectFrom('iam.groups')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundException('Group not found');
      const group = toIamGroup(current);
      await assertActorRole(transaction, requireUserId(actor), Role.Admin);
      if (group.revision !== expectedRevision) {
        throw new ConflictException({ code: 'REVISION_CONFLICT', current: this.toDto(group) });
      }
      const row = await transaction.updateTable('iam.groups')
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          revision: String(expectedRevision + 1),
        })
        .where('id', '=', id)
        .where('revision', '=', String(expectedRevision))
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new ConflictException({ code: 'REVISION_CONFLICT' });
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.UpdateGroup,
        id,
        'group',
        input,
      );
      return toIamGroup(row);
    });
    return this.toDto(group);
  }

  /** Members and the group's grants go with it (foreign keys cascade); coverage lapses. */
  async delete(actor: Actor, id: string): Promise<{ deleted: boolean }> {
    await this.transactions.run(async (transaction) => {
      await assertActorRole(transaction, requireUserId(actor), Role.Admin);
      await this.requireGroup(transaction, id);
      await transaction.deleteFrom('iam.groups').where('id', '=', id).execute();
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.DeleteGroup,
        id,
        'group',
      );
      afterCommit(transaction, () => this.changes.notify());
    });
    return { deleted: true };
  }

  async listMembers(groupId: string): Promise<GroupMemberDto[]> {
    await this.findById(groupId);
    return this.database.selectFrom('iam.group_members as member')
      .innerJoin('iam.users as user', 'user.id', 'member.user_id')
      .select([
        'user.id as userId',
        'user.username',
        'user.display_name as displayName',
      ])
      .where('member.group_id', '=', groupId)
      .execute();
  }

  async addMember(actor: Actor, groupId: string, userId: string): Promise<{ changed: boolean }> {
    const changed = await this.transactions.run(async (transaction) => {
      await assertActorRole(transaction, requireUserId(actor), Role.Admin);
      await this.requireGroup(transaction, groupId);
      const user = await transaction.selectFrom('iam.users')
        .select('status')
        .where('id', '=', userId)
        .executeTakeFirst();
      if (!user || user.status === UserStatus.Deleted) throw new NotFoundException('User not found');
      const row = await transaction.insertInto('iam.group_members')
        .values({ id: randomUUID(), group_id: groupId, user_id: userId })
        .onConflict((conflict) => conflict.columns(['group_id', 'user_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row) return false;
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.AddGroupMember,
        groupId,
        'group',
        { userId },
      );
      afterCommit(transaction, () => this.changes.notify());
      return true;
    });
    return { changed };
  }

  async removeMember(actor: Actor, groupId: string, userId: string): Promise<{ changed: boolean }> {
    const changed = await this.transactions.run(async (transaction) => {
      await assertActorRole(transaction, requireUserId(actor), Role.Admin);
      await this.requireGroup(transaction, groupId);
      const deleted = await transaction.deleteFrom('iam.group_members')
        .where('group_id', '=', groupId)
        .where('user_id', '=', userId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) return false;
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.RemoveGroupMember,
        groupId,
        'group',
        { userId },
      );
      afterCommit(transaction, () => this.changes.notify());
      return true;
    });
    return { changed };
  }

  toDto(group: IamGroup): GroupDto {
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      revision: group.revision,
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
    };
  }

  private async requireGroup(transaction: GroupTransaction, id: string): Promise<IamGroup> {
    const row = await transaction.selectFrom('iam.groups')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Group not found');
    return toIamGroup(row);
  }
}
