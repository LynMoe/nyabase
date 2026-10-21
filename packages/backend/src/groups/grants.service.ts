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
  Capability,
  FailureCode,
  UserStatus,
  type ServerGrantDto,
  type SharedBackendGrantDto,
  type StoragePoolGrantDto,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { afterCommit } from '../platform/post-commit.js';
import { AccessChangeNotifier } from '../iam/access-change-notifier.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import type { Actor } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import { GpuClaimsRepository } from '../gpu/gpu-claims.repository.js';
import { isLocalPoolRow } from '../storage-pools/storage-pool-capability.js';

/** A grant is held by one subject: a user, or a group whose members inherit it. */
export interface GrantSubject {
  kind: 'user' | 'group';
  id: string;
}

export interface ServerGrantInput {
  cpuMillis: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  gpuPciAddresses: string[];
  expiresAt: string | null;
}

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

function subjectValues(subject: GrantSubject) {
  return subject.kind === 'user'
    ? { user_id: subject.id, group_id: null }
    : { user_id: null, group_id: subject.id };
}

function subjectColumn(subject: GrantSubject) {
  return subject.kind === 'user' ? ('user_id' as const) : ('group_id' as const);
}

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * CRUD of the three kinds of resource grants (server, storage pool, shared
 * backend). A grant's holder is a parameter (`GrantSubject`), so a user and a
 * group use the same functions. Deleting a grant never refuses because the
 * user owns resources: it is an immediate lapse, handled by the access-lapse
 * processor after commit.
 */
@Injectable()
export class GrantsService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly access: AccessResolverService,
    private readonly audit: AuditService,
    private readonly gpuClaims: GpuClaimsRepository,
    private readonly changes: AccessChangeNotifier,
  ) {}

  async assertSubjectExists(subject: GrantSubject): Promise<void> {
    await this.requireSubject(this.database, subject);
  }

  // Server grants ------------------------------------------------------------

  async listServerGrants(subject: GrantSubject): Promise<ServerGrantDto[]> {
    await this.requireSubject(this.database, subject);
    const rows = await this.database.selectFrom('iam.server_grants')
      .selectAll()
      .where(subjectColumn(subject), '=', subject.id)
      .orderBy('server_id')
      .execute();
    return rows.map((row) => this.serverGrantDto(subject, row));
  }

  async putServerGrant(
    actor: Actor,
    subject: GrantSubject,
    serverId: string,
    input: ServerGrantInput,
  ): Promise<ServerGrantDto> {
    const row = await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, subject);
      const server = await transaction.selectFrom('infra.servers')
        .select('id')
        .where('id', '=', serverId)
        .executeTakeFirst();
      if (!server) throw new NotFoundException('Server not found');
      const gpuPciAddresses = input.gpuPciAddresses ?? [];
      if (gpuPciAddresses.length > 0 && !await this.gpuClaims.isEnabled(serverId, transaction)) {
        throw new ConflictException({
          code: FailureCode.GpuGrantNotApplicable,
          message: 'GPU is not enabled on this server',
          details: { serverId },
        });
      }
      const values = {
        cpu_millis: input.cpuMillis,
        mem_bytes: input.memBytes,
        disk_bytes: input.diskBytes,
        gpu_pci_addresses: gpuPciAddresses,
        expires_at: input.expiresAt,
        updated_at: new Date(),
      };
      const column = subjectColumn(subject);
      const saved = await transaction.insertInto('iam.server_grants')
        .values({ id: randomUUID(), ...subjectValues(subject), server_id: serverId, ...values })
        .onConflict((conflict) => conflict
          .columns([column, 'server_id'])
          .where(column, 'is not', null)
          .doUpdateSet(values))
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.UpsertServerGrant,
        subject.id,
        subject.kind,
        { serverId },
      );
      afterCommit(transaction, () => this.changes.notify());
      return saved;
    });
    return this.serverGrantDto(subject, row);
  }

  async deleteServerGrant(actor: Actor, subject: GrantSubject, serverId: string): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, subject);
      const deleted = await transaction.deleteFrom('iam.server_grants')
        .where(subjectColumn(subject), '=', subject.id)
        .where('server_id', '=', serverId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) return;
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.DeleteServerGrant,
        subject.id,
        subject.kind,
        { serverId },
      );
      afterCommit(transaction, () => this.changes.notify());
    });
  }

  // Storage pool grants (admission only) ---------------------------------------

  async listStoragePoolGrants(subject: GrantSubject): Promise<StoragePoolGrantDto[]> {
    await this.requireSubject(this.database, subject);
    const rows = await this.database.selectFrom('iam.storage_pool_grants')
      .selectAll()
      .where(subjectColumn(subject), '=', subject.id)
      .orderBy('pool_id')
      .execute();
    return rows.map((row) => this.poolGrantDto(subject, row));
  }

  async putStoragePoolGrant(
    actor: Actor,
    subject: GrantSubject,
    poolId: string,
    expiresAt: string | null,
  ): Promise<StoragePoolGrantDto> {
    const row = await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, subject);
      const pool = await transaction.selectFrom('infra.storage_pools')
        .select(['id', 'shareable', 'driver', 'shared_backend_id'])
        .where('id', '=', poolId)
        .executeTakeFirst();
      if (!pool || !isLocalPoolRow(pool)) throw new NotFoundException('Storage pool not found');
      const values = { expires_at: expiresAt, updated_at: new Date() };
      const column = subjectColumn(subject);
      const saved = await transaction.insertInto('iam.storage_pool_grants')
        .values({ id: randomUUID(), ...subjectValues(subject), pool_id: poolId, ...values })
        .onConflict((conflict) => conflict
          .columns([column, 'pool_id'])
          .where(column, 'is not', null)
          .doUpdateSet(values))
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.UpsertStoragePoolGrant,
        poolId,
        subject.kind,
        { scopeId: subject.id, poolId },
      );
      afterCommit(transaction, () => this.changes.notify());
      return saved;
    });
    return this.poolGrantDto(subject, row);
  }

  async deleteStoragePoolGrant(actor: Actor, subject: GrantSubject, poolId: string): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, subject);
      const deleted = await transaction.deleteFrom('iam.storage_pool_grants')
        .where(subjectColumn(subject), '=', subject.id)
        .where('pool_id', '=', poolId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) return;
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.DeleteStoragePoolGrant,
        poolId,
        subject.kind,
        { scopeId: subject.id, poolId },
      );
      afterCommit(transaction, () => this.changes.notify());
    });
  }

  // Shared backend grants (capacity limit) -------------------------------------

  async listSharedBackendGrants(subject: GrantSubject): Promise<SharedBackendGrantDto[]> {
    await this.requireSubject(this.database, subject);
    const rows = await this.database.selectFrom('iam.shared_backend_grants')
      .selectAll()
      .where(subjectColumn(subject), '=', subject.id)
      .orderBy('shared_backend_id')
      .execute();
    return rows.map((row) => this.backendGrantDto(subject, row));
  }

  async putSharedBackendGrant(
    actor: Actor,
    subject: GrantSubject,
    backendId: string,
    input: { limitBytes: number; expiresAt: string | null },
  ): Promise<SharedBackendGrantDto> {
    const row = await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, subject);
      const backend = await transaction.selectFrom('infra.shared_backends')
        .select('id')
        .where('id', '=', backendId)
        .executeTakeFirst();
      if (!backend) throw new NotFoundException('Shared backend not found');
      const values = {
        limit_bytes: input.limitBytes,
        expires_at: input.expiresAt,
        updated_at: new Date(),
      };
      const column = subjectColumn(subject);
      const saved = await transaction.insertInto('iam.shared_backend_grants')
        .values({
          id: randomUUID(),
          ...subjectValues(subject),
          shared_backend_id: backendId,
          ...values,
        })
        .onConflict((conflict) => conflict
          .columns([column, 'shared_backend_id'])
          .where(column, 'is not', null)
          .doUpdateSet(values))
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.UpsertSharedBackendGrant,
        backendId,
        subject.kind,
        { scopeId: subject.id, sharedBackendId: backendId, limitBytes: input.limitBytes },
      );
      afterCommit(transaction, () => this.changes.notify());
      return saved;
    });
    return this.backendGrantDto(subject, row);
  }

  async deleteSharedBackendGrant(
    actor: Actor,
    subject: GrantSubject,
    backendId: string,
  ): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await this.beginMutation(transaction, actor, subject);
      const deleted = await transaction.deleteFrom('iam.shared_backend_grants')
        .where(subjectColumn(subject), '=', subject.id)
        .where('shared_backend_id', '=', backendId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) return;
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.DeleteSharedBackendGrant,
        backendId,
        subject.kind,
        { scopeId: subject.id, sharedBackendId: backendId },
      );
      afterCommit(transaction, () => this.changes.notify());
    });
  }

  // Shared helpers -----------------------------------------------------------

  /** Every grant mutation needs `ManageGrants` (re-read in the transaction) and an existing holder. */
  private async beginMutation(
    transaction: Transaction<NyabaseDatabase>,
    actor: Actor,
    subject: GrantSubject,
  ): Promise<void> {
    await this.access.assertActorCapabilitiesInTransaction(
      transaction,
      actor.userId,
      [Capability.ManageGrants],
    );
    await this.requireSubject(transaction, subject);
  }

  private async requireSubject(executor: Executor, subject: GrantSubject): Promise<void> {
    if (subject.kind === 'group') {
      const group = await executor.selectFrom('iam.groups')
        .select('id')
        .where('id', '=', subject.id)
        .executeTakeFirst();
      if (!group) throw new NotFoundException('Group not found');
      return;
    }
    const user = await executor.selectFrom('iam.users')
      .select(['id', 'status'])
      .where('id', '=', subject.id)
      .executeTakeFirst();
    if (!user || user.status === UserStatus.Deleted) throw new NotFoundException('User not found');
  }

  private serverGrantDto(
    subject: GrantSubject,
    row: {
      id: string;
      server_id: string;
      cpu_millis: number | null;
      mem_bytes: string | number | null;
      disk_bytes: string | number | null;
      gpu_pci_addresses: string[];
      expires_at: Date | string | null;
      created_at: Date;
      updated_at: Date;
    },
  ): ServerGrantDto {
    return {
      id: row.id,
      scope: subject.kind,
      scopeId: subject.id,
      serverId: row.server_id,
      cpuMillis: row.cpu_millis,
      memBytes: row.mem_bytes === null ? null : Number(row.mem_bytes),
      diskBytes: row.disk_bytes === null ? null : Number(row.disk_bytes),
      gpuPciAddresses: [...row.gpu_pci_addresses],
      expiresAt: iso(row.expires_at),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private poolGrantDto(
    subject: GrantSubject,
    row: {
      id: string;
      pool_id: string;
      expires_at: Date | string | null;
      created_at: Date;
      updated_at: Date;
    },
  ): StoragePoolGrantDto {
    return {
      id: row.id,
      scope: subject.kind,
      scopeId: subject.id,
      poolId: row.pool_id,
      expiresAt: iso(row.expires_at),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private backendGrantDto(
    subject: GrantSubject,
    row: {
      id: string;
      shared_backend_id: string;
      limit_bytes: string | number;
      expires_at: Date | string | null;
      created_at: Date;
      updated_at: Date;
    },
  ): SharedBackendGrantDto {
    return {
      id: row.id,
      scope: subject.kind,
      scopeId: subject.id,
      sharedBackendId: row.shared_backend_id,
      limitBytes: Number(row.limit_bytes),
      expiresAt: iso(row.expires_at),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
