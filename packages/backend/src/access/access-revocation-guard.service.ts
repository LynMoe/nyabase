import { ConflictException, Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { classifyGrantExpiry } from './grant-expiry.js';

export interface UserServerAccess {
  userId: string;
  serverId: string;
}

export interface UserPoolAccess {
  userId: string;
  poolId: string;
}

export interface UserSharedBackendAccess {
  userId: string;
  sharedBackendId: string;
}

function transactionOf(value: unknown): Transaction<NyabaseDatabase> {
  if (
    !value
    || typeof value !== 'object'
    || typeof (value as { selectFrom?: unknown }).selectFrom !== 'function'
  ) {
    throw new Error('Access revocation checks require a PostgreSQL transaction');
  }
  return value as Transaction<NyabaseDatabase>;
}

@Injectable()
export class AccessRevocationGuardService {
  async assertServerAccessRevocationSafe(
    executor: unknown,
    affected: readonly UserServerAccess[],
  ): Promise<void> {
    const transaction = transactionOf(executor);
    const unique = [...new Map(affected.map((entry) => [
      `${entry.userId}\0${entry.serverId}`,
      entry,
    ])).values()];
    for (const entry of unique) {
      if (await this.hasRemainingServerGrant(transaction, entry)) continue;
      const dependency = await transaction.selectFrom('control.authorization_dependencies')
        .select(['dependency_kind', 'dependency_id'])
        .where('user_id', '=', entry.userId)
        .where('server_id', '=', entry.serverId)
        .where((expression) => expression.or([
          expression('dependency_kind', '=', 'container'),
          expression('dependency_kind', '=', 'volume'),
          expression('dependency_kind', '=', 'volume_attachment'),
        ]))
        .orderBy('created_at')
        .orderBy('dependency_id')
        .executeTakeFirst();
      if (!dependency) continue;
      throw new ConflictException({
        code: 'GRANT_REVOCATION_BLOCKED',
        message: 'The user still owns a resource on this server',
        userId: entry.userId,
        serverId: entry.serverId,
        dependencyKind: dependency.dependency_kind,
        dependencyId: dependency.dependency_id,
      });
    }
  }

  async assertStoragePoolAccessRevocationSafe(
    executor: unknown,
    affected: readonly UserPoolAccess[],
  ): Promise<void> {
    const transaction = transactionOf(executor);
    const unique = [...new Map(affected.map((entry) => [
      `${entry.userId}\0${entry.poolId}`,
      entry,
    ])).values()];
    for (const entry of unique) {
      if (await this.hasRemainingStoragePoolGrant(transaction, entry)) continue;
      const dependency = await transaction.selectFrom('control.authorization_dependencies')
        .select(['dependency_kind', 'dependency_id'])
        .where('user_id', '=', entry.userId)
        .where('pool_id', '=', entry.poolId)
        .orderBy('created_at')
        .orderBy('dependency_id')
        .executeTakeFirst();
      if (!dependency) continue;
      throw new ConflictException({
        code: 'GRANT_REVOCATION_BLOCKED',
        message: 'The user still owns a resource on this storage pool',
        userId: entry.userId,
        poolId: entry.poolId,
        dependencyKind: dependency.dependency_kind,
        dependencyId: dependency.dependency_id,
      });
    }
  }

  async assertSharedBackendAccessRevocationSafe(
    executor: unknown,
    affected: readonly UserSharedBackendAccess[],
  ): Promise<void> {
    const transaction = transactionOf(executor);
    const unique = [...new Map(affected.map((entry) => [
      `${entry.userId}\0${entry.sharedBackendId}`,
      entry,
    ])).values()];
    for (const entry of unique) {
      if (await this.hasRemainingSharedBackendGrant(transaction, entry)) continue;
      const dependency = await transaction.selectFrom('control.authorization_dependencies')
        .select(['dependency_kind', 'dependency_id'])
        .where('user_id', '=', entry.userId)
        .where('shared_backend_id', '=', entry.sharedBackendId)
        .orderBy('created_at')
        .orderBy('dependency_id')
        .executeTakeFirst();
      if (!dependency) continue;
      throw new ConflictException({
        code: 'GRANT_REVOCATION_BLOCKED',
        message: 'The user still owns a resource on this shared backend',
        userId: entry.userId,
        sharedBackendId: entry.sharedBackendId,
        dependencyKind: dependency.dependency_kind,
        dependencyId: dependency.dependency_id,
      });
    }
  }

  private async hasRemainingServerGrant(
    transaction: Transaction<NyabaseDatabase>,
    entry: UserServerAccess,
  ): Promise<boolean> {
    const groups = await transaction.selectFrom('iam.group_members')
      .select('group_id')
      .where('user_id', '=', entry.userId)
      .execute();
    let query = transaction.selectFrom('iam.server_grants')
      .select(['id', 'expires_at'])
      .where('server_id', '=', entry.serverId);
    query = groups.length === 0
      ? query.where('user_id', '=', entry.userId)
      : query.where((expression) => expression.or([
        expression('user_id', '=', entry.userId),
        expression('group_id', 'in', groups.map((group) => group.group_id)),
      ]));
    const grants = await query.execute();
    return grants.some((grant) => classifyGrantExpiry(grant.expires_at) !== 'lost');
  }

  private async hasRemainingStoragePoolGrant(
    transaction: Transaction<NyabaseDatabase>,
    entry: UserPoolAccess,
  ): Promise<boolean> {
    const groups = await transaction.selectFrom('iam.group_members')
      .select('group_id')
      .where('user_id', '=', entry.userId)
      .execute();
    let query = transaction.selectFrom('iam.storage_pool_grants')
      .select(['id', 'expires_at'])
      .where('pool_id', '=', entry.poolId);
    query = groups.length === 0
      ? query.where('user_id', '=', entry.userId)
      : query.where((expression) => expression.or([
        expression('user_id', '=', entry.userId),
        expression('group_id', 'in', groups.map((group) => group.group_id)),
      ]));
    const grants = await query.execute();
    return grants.some((grant) => classifyGrantExpiry(grant.expires_at) !== 'lost');
  }

  private async hasRemainingSharedBackendGrant(
    transaction: Transaction<NyabaseDatabase>,
    entry: UserSharedBackendAccess,
  ): Promise<boolean> {
    const groups = await transaction.selectFrom('iam.group_members')
      .select('group_id')
      .where('user_id', '=', entry.userId)
      .execute();
    let query = transaction.selectFrom('iam.shared_backend_grants')
      .select(['id', 'expires_at'])
      .where('shared_backend_id', '=', entry.sharedBackendId);
    query = groups.length === 0
      ? query.where('user_id', '=', entry.userId)
      : query.where((expression) => expression.or([
        expression('user_id', '=', entry.userId),
        expression('group_id', 'in', groups.map((group) => group.group_id)),
      ]));
    const grants = await query.execute();
    return grants.some((grant) => classifyGrantExpiry(grant.expires_at) !== 'lost');
  }
}
