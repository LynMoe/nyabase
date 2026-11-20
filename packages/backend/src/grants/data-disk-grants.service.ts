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
  FailureCode,
  type CreateDataDiskGrantRequest,
  type DataDiskGrantChangeDto,
  type DataDiskGrantDto,
  type PatchDataDiskGrantRequest,
} from '@nyabase/common';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import type { Actor } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { afterCommit } from '../platform/post-commit.js';
import { isLocalPoolRow } from '../storage-pools/storage-pool-capability.js';
import { beginGrantMutation, requireGrantUser } from './grant-mutation.js';

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;
type Tx = Transaction<NyabaseDatabase>;

interface Moves {
  movedPools: Array<{ poolId: string; fromGrantId: string }>;
  deletedGrantIds: string[];
}

/** The data-disk grants under the given server grants, with their pools, by server grant id. */
export async function loadDataDiskGrantDtos(
  executor: Executor,
  serverGrantIds: readonly string[],
): Promise<Map<string, DataDiskGrantDto[]>> {
  const result = new Map<string, DataDiskGrantDto[]>();
  if (serverGrantIds.length === 0) return result;
  const [grants, members] = await Promise.all([
    executor.selectFrom('iam.data_disk_grants')
      .selectAll()
      .where('server_grant_id', 'in', serverGrantIds)
      .orderBy('created_at')
      .orderBy('id')
      .execute(),
    executor.selectFrom('iam.storage_pool_grants')
      .select(['data_disk_grant_id', 'pool_id'])
      .where('server_grant_id', 'in', serverGrantIds)
      .orderBy('pool_id')
      .execute(),
  ]);
  const poolsByGrant = new Map<string, string[]>();
  for (const member of members) {
    const list = poolsByGrant.get(member.data_disk_grant_id) ?? [];
    list.push(member.pool_id);
    poolsByGrant.set(member.data_disk_grant_id, list);
  }
  for (const grant of grants) {
    const list = result.get(grant.server_grant_id) ?? [];
    list.push({
      id: grant.id,
      serverGrantId: grant.server_grant_id,
      userId: grant.user_id,
      serverId: grant.server_id,
      poolIds: poolsByGrant.get(grant.id) ?? [],
      limitBytes: Number(grant.limit_bytes),
      createdAt: grant.created_at.toISOString(),
      updatedAt: grant.updated_at.toISOString(),
    });
    result.set(grant.server_grant_id, list);
  }
  return result;
}

/**
 * Data-disk grants: local pools of one server sharing one quota, under the
 * user's server grant. Each pool of a user belongs to at most one grant; a
 * write that names a pool held by another grant moves it (with `movePools`),
 * so its coverage never lapses, and deletes grants left without pools. A pool
 * no grant covers any more lapses like any revoked grant. Quotas take effect
 * through the volume quota balancer: never by stopping or unmounting.
 */
@Injectable()
export class DataDiskGrantsService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly audit: AuditService,
    private readonly changes: AccessChangeNotifier,
  ) {}

  async list(userId: string): Promise<DataDiskGrantDto[]> {
    await requireGrantUser(this.database, userId);
    const serverGrants = await this.database.selectFrom('iam.server_grants')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    const byServerGrant = await loadDataDiskGrantDtos(this.database, serverGrants.map((row) => row.id));
    return [...byServerGrant.values()].flat();
  }

  async create(actor: Actor, userId: string, input: CreateDataDiskGrantRequest): Promise<DataDiskGrantChangeDto> {
    return this.transactions.run(async (transaction) => {
      await beginGrantMutation(transaction, actor, userId);
      const serverGrant = await transaction.selectFrom('iam.server_grants')
        .select('id')
        .where('user_id', '=', userId)
        .where('server_id', '=', input.serverId)
        .forShare()
        .executeTakeFirst();
      if (!serverGrant) {
        throw new ConflictException({
          code: FailureCode.ServerGrantRequired,
          message: 'Assign a bundle on the server first',
          details: { serverId: input.serverId },
        });
      }
      await this.lockPools(transaction, input.serverId, input.poolIds);
      const id = randomUUID();
      await transaction.insertInto('iam.data_disk_grants').values({
        id,
        server_grant_id: serverGrant.id,
        user_id: userId,
        server_id: input.serverId,
        limit_bytes: input.limitBytes,
      }).execute();
      const moves = await this.takePools(transaction, {
        userId,
        serverId: input.serverId,
        serverGrantId: serverGrant.id,
        grantId: id,
        poolIds: input.poolIds,
        movePools: input.movePools === true,
      });
      const change = await this.finish(transaction, id, moves, []);
      await this.audit.append(transaction, actor.userId, AuditAction.CreateDataDiskGrant, userId, 'user', {
        serverId: input.serverId,
        grantId: id,
        poolIds: input.poolIds,
        limitBytes: input.limitBytes,
        ...moves,
      });
      return change;
    });
  }

  async patch(
    actor: Actor,
    userId: string,
    grantId: string,
    input: PatchDataDiskGrantRequest,
  ): Promise<DataDiskGrantChangeDto> {
    return this.transactions.run(async (transaction) => {
      await beginGrantMutation(transaction, actor, userId);
      const grant = await this.lockGrant(transaction, userId, grantId);
      if (input.limitBytes !== undefined) {
        await transaction.updateTable('iam.data_disk_grants')
          .set({ limit_bytes: input.limitBytes })
          .where('id', '=', grantId)
          .execute();
      }
      let moves: Moves = { movedPools: [], deletedGrantIds: [] };
      let revokedPoolIds: string[] = [];
      if (input.poolIds !== undefined) {
        await this.lockPools(transaction, grant.server_id, input.poolIds);
        const current = (await transaction.selectFrom('iam.storage_pool_grants')
          .select('pool_id')
          .where('data_disk_grant_id', '=', grantId)
          .execute()).map((row) => row.pool_id);
        const wanted = new Set(input.poolIds);
        revokedPoolIds = current.filter((poolId) => !wanted.has(poolId)).sort();
        if (revokedPoolIds.length > 0) {
          await transaction.deleteFrom('iam.storage_pool_grants')
            .where('data_disk_grant_id', '=', grantId)
            .where('pool_id', 'in', revokedPoolIds)
            .execute();
        }
        moves = await this.takePools(transaction, {
          userId,
          serverId: grant.server_id,
          serverGrantId: grant.server_grant_id,
          grantId,
          poolIds: input.poolIds.filter((poolId) => !current.includes(poolId)),
          movePools: input.movePools === true,
        });
      }
      const change = await this.finish(transaction, grantId, moves, revokedPoolIds);
      await this.audit.append(transaction, actor.userId, AuditAction.UpdateDataDiskGrant, userId, 'user', {
        serverId: grant.server_id,
        grantId,
        ...(input.limitBytes === undefined ? {} : { limitBytes: input.limitBytes }),
        ...(input.poolIds === undefined ? {} : { poolIds: input.poolIds }),
        ...moves,
        revokedPoolIds,
      });
      return change;
    });
  }

  async delete(actor: Actor, userId: string, grantId: string): Promise<DataDiskGrantChangeDto> {
    return this.transactions.run(async (transaction) => {
      await beginGrantMutation(transaction, actor, userId);
      const grant = await this.lockGrant(transaction, userId, grantId);
      const pools = await transaction.selectFrom('iam.storage_pool_grants')
        .select('pool_id')
        .where('data_disk_grant_id', '=', grantId)
        .orderBy('pool_id')
        .execute();
      await transaction.deleteFrom('iam.data_disk_grants').where('id', '=', grantId).execute();
      const revokedPoolIds = pools.map((row) => row.pool_id);
      await this.audit.append(transaction, actor.userId, AuditAction.DeleteDataDiskGrant, userId, 'user', {
        serverId: grant.server_id,
        grantId,
        revokedPoolIds,
      });
      afterCommit(transaction, () => this.changes.notify());
      return { grant: null, movedPools: [], deletedGrantIds: [], revokedPoolIds };
    });
  }

  private async lockGrant(transaction: Tx, userId: string, grantId: string) {
    const grant = await transaction.selectFrom('iam.data_disk_grants')
      .select(['id', 'server_id', 'server_grant_id'])
      .where('id', '=', grantId)
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!grant) throw new NotFoundException('Data-disk grant not found');
    return grant;
  }

  /** Every pool must be a local pool of the server; held FOR SHARE against a concurrent remap. */
  private async lockPools(transaction: Tx, serverId: string, poolIds: readonly string[]): Promise<void> {
    const pools = await transaction.selectFrom('infra.storage_pools')
      .select(['id', 'server_id', 'shareable', 'driver', 'shared_backend_id'])
      .where('id', 'in', poolIds)
      .forShare()
      .execute();
    const valid = new Set(pools
      .filter((pool) => pool.server_id === serverId && isLocalPoolRow(pool))
      .map((pool) => pool.id));
    const missing = poolIds.filter((poolId) => !valid.has(poolId));
    if (missing.length > 0) {
      throw new NotFoundException({
        code: FailureCode.InvalidInput,
        message: 'Storage pool not found on the server',
        details: { serverId, poolIds: missing },
      });
    }
  }

  /**
   * Puts the pools into the grant. A pool already in another grant of the
   * user moves only with `movePools` (else 409 naming every such pool,
   * before anything changes).
   */
  private async takePools(transaction: Tx, input: {
    userId: string;
    serverId: string;
    serverGrantId: string;
    grantId: string;
    poolIds: readonly string[];
    movePools: boolean;
  }): Promise<Moves> {
    if (input.poolIds.length === 0) return { movedPools: [], deletedGrantIds: [] };
    const held = await transaction.selectFrom('iam.storage_pool_grants')
      .select(['id', 'pool_id', 'data_disk_grant_id'])
      .where('user_id', '=', input.userId)
      .where('pool_id', 'in', input.poolIds)
      .forUpdate()
      .execute();
    const elsewhere = held.filter((row) => row.data_disk_grant_id !== input.grantId);
    if (elsewhere.length > 0 && !input.movePools) {
      throw new ConflictException({
        code: FailureCode.DataDiskPoolGranted,
        message: 'Some disks already belong to another data-disk grant of the user',
        details: {
          pools: elsewhere.map((row) => ({ poolId: row.pool_id, grantId: row.data_disk_grant_id })),
        },
      });
    }
    const heldPools = new Set(held.map((row) => row.pool_id));
    for (const row of elsewhere) {
      await transaction.updateTable('iam.storage_pool_grants')
        .set({ data_disk_grant_id: input.grantId })
        .where('id', '=', row.id)
        .execute();
    }
    for (const poolId of input.poolIds.filter((poolId) => !heldPools.has(poolId))) {
      await transaction.insertInto('iam.storage_pool_grants').values({
        id: randomUUID(),
        server_grant_id: input.serverGrantId,
        data_disk_grant_id: input.grantId,
        user_id: input.userId,
        server_id: input.serverId,
        pool_id: poolId,
      }).execute();
    }
    const fromGrantIds = [...new Set(elsewhere.map((row) => row.data_disk_grant_id))];
    const emptied = fromGrantIds.length === 0 ? [] : await transaction.deleteFrom('iam.data_disk_grants')
      .where('id', 'in', fromGrantIds)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('iam.storage_pool_grants as member')
        .select('member.id')
        .whereRef('member.data_disk_grant_id', '=', 'iam.data_disk_grants.id'))))
      .returning('id')
      .execute();
    return {
      movedPools: elsewhere
        .map((row) => ({ poolId: row.pool_id, fromGrantId: row.data_disk_grant_id }))
        .sort((left, right) => left.poolId.localeCompare(right.poolId)),
      deletedGrantIds: emptied.map((row) => row.id).sort(),
    };
  }

  private async finish(
    transaction: Tx,
    grantId: string,
    moves: Moves,
    revokedPoolIds: string[],
  ): Promise<DataDiskGrantChangeDto> {
    const grant = await transaction.selectFrom('iam.data_disk_grants')
      .select('server_grant_id')
      .where('id', '=', grantId)
      .executeTakeFirstOrThrow();
    const dtos = await loadDataDiskGrantDtos(transaction, [grant.server_grant_id]);
    afterCommit(transaction, () => this.changes.notify());
    return {
      grant: dtos.get(grant.server_grant_id)?.find((dto) => dto.id === grantId) ?? null,
      ...moves,
      revokedPoolIds,
    };
  }
}
