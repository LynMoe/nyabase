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
  UserStatus,
  type PatchServerGrantRequest,
  type ServerGrantDto,
  type ServerGrantOverrides,
  type SharedBackendGrantDto,
  type StoragePoolGrantDto,
  Role,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { afterCommit } from '../platform/post-commit.js';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import type { Actor } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import { GpuClaimsRepository } from '../gpu/gpu-claims.repository.js';
import { isLocalPoolRow } from '../storage-pools/storage-pool-capability.js';
import { assertActorRole } from '../iam/administration.js';
import { requireUserId } from '../iam/actor.js';
import {
  effectiveQuotas,
  overrideColumns,
  overridesFromColumns,
  quotasFromColumns,
  type QuotaColumns,
} from './grant-fields.js';

export interface ServerGrantInput {
  bundleId: string;
  overrides: ServerGrantOverrides;
  expiresAt: string | null;
  replace: boolean;
}

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;
type Tx = Transaction<NyabaseDatabase>;

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function poolGrantDto(row: {
  id: string;
  server_grant_id: string;
  user_id: string;
  server_id: string;
  pool_id: string;
  limit_bytes: string | number | null;
  created_at: Date;
  updated_at: Date;
}): StoragePoolGrantDto {
  return {
    id: row.id,
    serverGrantId: row.server_grant_id,
    userId: row.user_id,
    serverId: row.server_id,
    poolId: row.pool_id,
    limitBytes: row.limit_bytes === null ? null : Number(row.limit_bytes),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * A user's grants: one bundle per server (with overrides), the data-disk
 * quotas under each server grant, and shared-backend grants. Deleting a grant
 * never refuses because the user owns resources: it is an immediate lapse,
 * handled by the access-lapse processor after commit. Replacing a server
 * grant's bundle keeps the grant (and its data disks), so coverage never
 * lapses in between.
 */
@Injectable()
export class GrantsService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly audit: AuditService,
    private readonly gpuClaims: GpuClaimsRepository,
    private readonly changes: AccessChangeNotifier,
  ) {}

  async assertUserExists(userId: string): Promise<void> {
    await this.requireUser(this.database, userId);
  }

  // Server grants ------------------------------------------------------------

  async listServerGrants(userId: string): Promise<ServerGrantDto[]> {
    await this.requireUser(this.database, userId);
    return this.serverGrantDtos(this.database, { userId });
  }

  async putServerGrant(
    actor: Actor,
    userId: string,
    serverId: string,
    input: ServerGrantInput,
  ): Promise<ServerGrantDto> {
    const grantId = await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, userId);
      const bundle = await transaction.selectFrom('iam.grant_bundles')
        .selectAll()
        .where('id', '=', input.bundleId)
        .forShare()
        .executeTakeFirst();
      if (!bundle || bundle.server_id !== serverId) throw new NotFoundException('Bundle not found');
      await this.assertGpuApplicable(transaction, serverId, effectiveQuotas(quotasFromColumns(bundle), input.overrides).gpuCount, input.overrides);
      const existing = await transaction.selectFrom('iam.server_grants')
        .select(['id', 'bundle_id'])
        .where('user_id', '=', userId)
        .where('server_id', '=', serverId)
        .forUpdate()
        .executeTakeFirst();
      if (existing && !input.replace) {
        throw new ConflictException({
          code: FailureCode.ServerGrantExists,
          message: 'The user already holds a bundle on this server',
          details: { grantId: existing.id, bundleId: existing.bundle_id },
        });
      }
      const values = {
        bundle_id: bundle.id,
        ...overrideColumns(input.overrides),
        expires_at: input.expiresAt,
      };
      const id = existing
        ? (await transaction.updateTable('iam.server_grants')
          .set(values)
          .where('id', '=', existing.id)
          .returning('id')
          .executeTakeFirstOrThrow()).id
        : (await transaction.insertInto('iam.server_grants')
          .values({ id: randomUUID(), user_id: userId, server_id: serverId, ...values })
          .returning('id')
          .executeTakeFirstOrThrow()).id;
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.UpsertServerGrant,
        userId,
        'user',
        {
          serverId,
          bundleId: bundle.id,
          overrides: input.overrides,
          expiresAt: input.expiresAt,
          ...(existing ? { replacedBundleId: existing.bundle_id } : {}),
        },
      );
      afterCommit(transaction, () => this.changes.notify());
      return id;
    });
    return this.requireServerGrantDto(grantId);
  }

  async patchServerGrant(
    actor: Actor,
    userId: string,
    serverId: string,
    input: PatchServerGrantRequest,
  ): Promise<ServerGrantDto> {
    const grantId = await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, userId);
      const grant = await transaction.selectFrom('iam.server_grants as grant')
        .innerJoin('iam.grant_bundles as bundle', 'bundle.id', 'grant.bundle_id')
        .select([
          'grant.id',
          'bundle.cpu_cores',
          'bundle.mem_bytes',
          'bundle.root_disk_bytes',
          'bundle.gpu_count',
        ])
        .where('grant.user_id', '=', userId)
        .where('grant.server_id', '=', serverId)
        .forUpdate('grant')
        .executeTakeFirst();
      if (!grant) throw new NotFoundException('Server grant not found');
      if (input.overrides !== undefined) {
        const gpuCount = effectiveQuotas(quotasFromColumns(grant), input.overrides).gpuCount;
        await this.assertGpuApplicable(transaction, serverId, gpuCount, input.overrides);
      }
      await transaction.updateTable('iam.server_grants')
        .set({
          ...(input.overrides === undefined ? {} : overrideColumns(input.overrides)),
          ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt }),
        })
        .where('id', '=', grant.id)
        .execute();
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.UpsertServerGrant,
        userId,
        'user',
        { serverId, ...input },
      );
      afterCommit(transaction, () => this.changes.notify());
      return grant.id;
    });
    return this.requireServerGrantDto(grantId);
  }

  /** Its data-disk grants go with it (foreign key cascade); server and pool coverage lapse. */
  async deleteServerGrant(actor: Actor, userId: string, serverId: string): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, userId);
      const deleted = await transaction.deleteFrom('iam.server_grants')
        .where('user_id', '=', userId)
        .where('server_id', '=', serverId)
        .returning('bundle_id')
        .executeTakeFirst();
      if (!deleted) return;
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.DeleteServerGrant,
        userId,
        'user',
        { serverId, bundleId: deleted.bundle_id },
      );
      afterCommit(transaction, () => this.changes.notify());
    });
  }

  // Data-disk grants ---------------------------------------------------------

  /** Create or change the user's quota on a local pool; needs their grant on the pool's server. */
  async putStoragePoolGrant(
    actor: Actor,
    userId: string,
    poolId: string,
    limitBytes: number | null,
  ): Promise<StoragePoolGrantDto> {
    const row = await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, userId);
      const pool = await transaction.selectFrom('infra.storage_pools')
        .select(['id', 'server_id', 'shareable', 'driver', 'shared_backend_id'])
        .where('id', '=', poolId)
        .forShare()
        .executeTakeFirst();
      if (!pool || !isLocalPoolRow(pool)) throw new NotFoundException('Storage pool not found');
      const serverGrant = await transaction.selectFrom('iam.server_grants')
        .select('id')
        .where('user_id', '=', userId)
        .where('server_id', '=', pool.server_id)
        .forShare()
        .executeTakeFirst();
      if (!serverGrant) {
        throw new ConflictException({
          code: FailureCode.ServerGrantRequired,
          message: 'Assign a bundle on the pool\'s server first',
          details: { serverId: pool.server_id, poolId },
        });
      }
      const saved = await transaction.insertInto('iam.storage_pool_grants')
        .values({
          id: randomUUID(),
          server_grant_id: serverGrant.id,
          user_id: userId,
          server_id: pool.server_id,
          pool_id: poolId,
          limit_bytes: limitBytes,
        })
        .onConflict((conflict) => conflict
          .columns(['user_id', 'pool_id'])
          .doUpdateSet({ limit_bytes: limitBytes }))
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.UpsertStoragePoolGrant,
        poolId,
        'user',
        { scopeId: userId, poolId, serverId: pool.server_id, limitBytes },
      );
      afterCommit(transaction, () => this.changes.notify());
      return saved;
    });
    return poolGrantDto(row);
  }

  async deleteStoragePoolGrant(actor: Actor, userId: string, poolId: string): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, userId);
      const deleted = await transaction.deleteFrom('iam.storage_pool_grants')
        .where('user_id', '=', userId)
        .where('pool_id', '=', poolId)
        .returning('server_id')
        .executeTakeFirst();
      if (!deleted) return;
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.DeleteStoragePoolGrant,
        poolId,
        'user',
        { scopeId: userId, poolId, serverId: deleted.server_id },
      );
      afterCommit(transaction, () => this.changes.notify());
    });
  }

  // Shared backend grants (capacity limit) -------------------------------------

  async listSharedBackendGrants(userId: string): Promise<SharedBackendGrantDto[]> {
    await this.requireUser(this.database, userId);
    const rows = await this.database.selectFrom('iam.shared_backend_grants')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('shared_backend_id')
      .execute();
    return rows.map((row) => this.backendGrantDto(row));
  }

  async putSharedBackendGrant(
    actor: Actor,
    userId: string,
    backendId: string,
    input: { limitBytes: number | null; expiresAt: string | null },
  ): Promise<SharedBackendGrantDto> {
    const row = await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, userId);
      const backend = await transaction.selectFrom('infra.shared_backends')
        .select('id')
        .where('id', '=', backendId)
        .executeTakeFirst();
      if (!backend) throw new NotFoundException('Shared backend not found');
      const values = { limit_bytes: input.limitBytes, expires_at: input.expiresAt };
      const saved = await transaction.insertInto('iam.shared_backend_grants')
        .values({ id: randomUUID(), user_id: userId, shared_backend_id: backendId, ...values })
        .onConflict((conflict) => conflict
          .columns(['user_id', 'shared_backend_id'])
          .doUpdateSet(values))
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.UpsertSharedBackendGrant,
        backendId,
        'user',
        { scopeId: userId, sharedBackendId: backendId, limitBytes: input.limitBytes },
      );
      afterCommit(transaction, () => this.changes.notify());
      return saved;
    });
    return this.backendGrantDto(row);
  }

  async deleteSharedBackendGrant(actor: Actor, userId: string, backendId: string): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, userId);
      const deleted = await transaction.deleteFrom('iam.shared_backend_grants')
        .where('user_id', '=', userId)
        .where('shared_backend_id', '=', backendId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) return;
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.DeleteSharedBackendGrant,
        backendId,
        'user',
        { scopeId: userId, sharedBackendId: backendId },
      );
      afterCommit(transaction, () => this.changes.notify());
    });
  }

  // Shared helpers -----------------------------------------------------------

  /** Every grant mutation needs the user admin role (re-read in the transaction) and an existing user. */
  private async beginMutation(transaction: Tx, actor: Actor, userId: string): Promise<void> {
    await assertActorRole(transaction, requireUserId(actor), Role.UserAdmin);
    await this.requireUser(transaction, userId);
  }

  private async requireUser(executor: Executor, userId: string): Promise<void> {
    const user = await executor.selectFrom('iam.users')
      .select(['id', 'status'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || user.status === UserStatus.Deleted) throw new NotFoundException('User not found');
  }

  /** GPUs can only be granted (a count other than 0) where the server has GPU enabled. */
  private async assertGpuApplicable(
    transaction: Tx,
    serverId: string,
    gpuCount: number | null,
    overrides: ServerGrantOverrides,
  ): Promise<void> {
    if (!('gpuCount' in overrides) || gpuCount === null || gpuCount === 0) return;
    if (await this.gpuClaims.isEnabled(serverId, transaction)) return;
    throw new ConflictException({
      code: FailureCode.GpuGrantNotApplicable,
      message: 'GPU is not enabled on this server',
      details: { serverId },
    });
  }

  private async requireServerGrantDto(grantId: string): Promise<ServerGrantDto> {
    const [dto] = await this.serverGrantDtos(this.database, { grantId });
    if (!dto) throw new NotFoundException('Server grant not found');
    return dto;
  }

  private async serverGrantDtos(
    executor: Executor,
    filter: { userId: string } | { grantId: string },
  ): Promise<ServerGrantDto[]> {
    let query = executor.selectFrom('iam.server_grants as grant')
      .innerJoin('iam.grant_bundles as bundle', 'bundle.id', 'grant.bundle_id')
      .select([
        'grant.id',
        'grant.user_id',
        'grant.server_id',
        'grant.bundle_id',
        'grant.overridden',
        'grant.cpu_cores',
        'grant.mem_bytes',
        'grant.root_disk_bytes',
        'grant.gpu_count',
        'grant.expires_at',
        'grant.created_at',
        'grant.updated_at',
        'bundle.name as bundle_name',
        'bundle.cpu_cores as bundle_cpu_cores',
        'bundle.mem_bytes as bundle_mem_bytes',
        'bundle.root_disk_bytes as bundle_root_disk_bytes',
        'bundle.gpu_count as bundle_gpu_count',
      ]);
    query = 'userId' in filter
      ? query.where('grant.user_id', '=', filter.userId)
      : query.where('grant.id', '=', filter.grantId);
    const rows = await query.orderBy('grant.server_id').execute();
    if (rows.length === 0) return [];
    const pools = await executor.selectFrom('iam.storage_pool_grants')
      .selectAll()
      .where('server_grant_id', 'in', rows.map((row) => row.id))
      .orderBy('pool_id')
      .execute();
    const poolsByGrant = new Map<string, StoragePoolGrantDto[]>();
    for (const pool of pools) {
      const list = poolsByGrant.get(pool.server_grant_id) ?? [];
      list.push(poolGrantDto(pool));
      poolsByGrant.set(pool.server_grant_id, list);
    }
    return rows.map((row) => {
      const overrides = overridesFromColumns(row);
      const bundle: QuotaColumns = {
        cpu_cores: row.bundle_cpu_cores,
        mem_bytes: row.bundle_mem_bytes,
        root_disk_bytes: row.bundle_root_disk_bytes,
        gpu_count: row.bundle_gpu_count,
      };
      return {
        id: row.id,
        userId: row.user_id,
        serverId: row.server_id,
        bundleId: row.bundle_id,
        bundleName: row.bundle_name,
        overrides,
        ...effectiveQuotas(quotasFromColumns(bundle), overrides),
        expiresAt: iso(row.expires_at),
        storagePools: poolsByGrant.get(row.id) ?? [],
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    });
  }

  private backendGrantDto(row: {
    id: string;
    user_id: string;
    shared_backend_id: string;
    limit_bytes: string | number | null;
    expires_at: Date | string | null;
    created_at: Date;
    updated_at: Date;
  }): SharedBackendGrantDto {
    return {
      id: row.id,
      userId: row.user_id,
      sharedBackendId: row.shared_backend_id,
      limitBytes: row.limit_bytes === null ? null : Number(row.limit_bytes),
      expiresAt: iso(row.expires_at),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
