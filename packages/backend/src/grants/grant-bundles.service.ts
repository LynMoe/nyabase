import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AuditAction,
  FailureCode,
  Role,
  type CreateGrantBundleRequest,
  type GrantBundleDto,
  type GrantBundlePreviewDto,
  type GrantBundlePreviewEntryDto,
  type GrantBundleQuotas,
  type PatchGrantBundleRequest,
  type PreviewGrantBundleRequest,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { afterCommit } from '../platform/post-commit.js';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import type { Actor } from '../iam/actor.js';
import { requireUserId } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import { assertActorRole } from '../iam/administration.js';
import { GpuClaimsRepository } from '../gpu/gpu-claims.repository.js';
import {
  GRANT_QUOTA_FIELDS,
  bundleDto,
  effectiveQuotas,
  overridesFromColumns,
  pickGrantGpus,
  quotaColumns,
  quotasFromColumns,
  sameDataDisks,
  type BundleRow,
} from './grant-fields.js';
import {
  assertDataDisksOnServer,
  loadBundleDataDisks,
  loadGrantDataDisks,
  writeBundleDataDisks,
} from './grant-data-disks.js';
import { loadServerUsageByUser } from './grant-usage.read-model.js';
import { diskEntryWarnings } from './grant-preview.js';

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

function bundleConflict(): ConflictException {
  return new ConflictException({
    code: FailureCode.GrantBundleConflict,
    message: 'A bundle with this name already exists on the server',
  });
}

/**
 * Bundles: named server quotas and data disks bound to one server. A server
 * grant follows every bundle field it does not override, so editing a bundle
 * takes effect at once for those grants (the effective views read the
 * bundle): a data disk added to the list is provisioned for every follower,
 * one taken out lapses for them. The preview shows beforehand which grants
 * change, which keep an override, and what users hold that a smaller bundle
 * no longer covers.
 */
@Injectable()
export class GrantBundlesService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly audit: AuditService,
    private readonly gpuClaims: GpuClaimsRepository,
    private readonly changes: AccessChangeNotifier,
  ) {}

  async list(serverId?: string): Promise<GrantBundleDto[]> {
    let query = this.database.selectFrom('iam.grant_bundles as bundle')
      .innerJoin('infra.servers as server', 'server.id', 'bundle.server_id')
      .selectAll('bundle')
      .select((eb) => eb.selectFrom('iam.server_grants as grant')
        .select(sql<string>`count(*)`.as('count'))
        .whereRef('grant.bundle_id', '=', 'bundle.id')
        .as('grant_count'));
    if (serverId !== undefined) query = query.where('bundle.server_id', '=', serverId);
    const rows = await query.orderBy('server.name').orderBy('bundle.name').orderBy('bundle.id').execute();
    const disks = await loadBundleDataDisks(this.database, rows.map((row) => row.id));
    return rows.map((row) => bundleDto(row, Number(row.grant_count ?? 0), disks.get(row.id) ?? []));
  }

  async get(id: string): Promise<GrantBundleDto> {
    return this.dto(this.database, await this.requireBundle(this.database, id));
  }

  async create(actor: Actor, input: CreateGrantBundleRequest): Promise<GrantBundleDto> {
    try {
      const row = await this.transactions.run(async (transaction) => {
        await assertActorRole(transaction, requireUserId(actor), Role.UserAdmin);
        const server = await transaction.selectFrom('infra.servers')
          .select('id')
          .where('id', '=', input.serverId)
          .forKeyShare()
          .executeTakeFirst();
        if (!server) throw new NotFoundException('Server not found');
        await this.assertGpuApplicable(transaction, input.serverId, input.gpuCount);
        await assertDataDisksOnServer(transaction, input.serverId, input.dataDisks);
        const saved = await transaction.insertInto('iam.grant_bundles')
          .values({
            id: randomUUID(),
            server_id: input.serverId,
            name: input.name,
            ...quotaColumns(input),
            revision: 1,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeBundleDataDisks(transaction, { id: saved.id, serverId: saved.server_id }, input.dataDisks);
        await this.audit.append(
          transaction,
          actor.userId,
          AuditAction.CreateGrantBundle,
          saved.id,
          'grant_bundle',
          { ...input },
        );
        return saved;
      });
      return this.dto(this.database, row);
    } catch (error) {
      if (isUniqueViolation(error)) throw bundleConflict();
      throw error;
    }
  }

  async update(actor: Actor, id: string, input: PatchGrantBundleRequest): Promise<GrantBundleDto> {
    const { expectedRevision, ...changes } = input;
    try {
      const row = await this.transactions.run(async (transaction) => {
        await assertActorRole(transaction, requireUserId(actor), Role.UserAdmin);
        const current = await this.requireBundle(transaction, id, { lock: true });
        const before = await this.dto(transaction, current);
        if (Number(current.revision) !== expectedRevision) {
          throw new ConflictException({
            code: FailureCode.RevisionConflict,
            message: 'The bundle changed; review the preview again',
            current: before,
          });
        }
        const { dataDisks, name, ...scalars } = changes;
        const next = { ...quotasFromColumns(current), ...scalars };
        if (scalars.gpuCount !== undefined) {
          await this.assertGpuApplicable(transaction, current.server_id, next.gpuCount);
        }
        const saved = await transaction.updateTable('iam.grant_bundles')
          .set({
            ...(name === undefined ? {} : { name }),
            ...quotaColumns(next),
            revision: String(expectedRevision + 1),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        if (dataDisks !== undefined) {
          await assertDataDisksOnServer(transaction, current.server_id, dataDisks);
          await writeBundleDataDisks(transaction, { id, serverId: current.server_id }, dataDisks);
        }
        await this.audit.append(
          transaction,
          actor.userId,
          AuditAction.UpdateGrantBundle,
          id,
          'grant_bundle',
          { serverId: current.server_id, before: { ...before, grantCount: undefined }, changes },
        );
        afterCommit(transaction, () => this.changes.notify());
        return saved;
      });
      return this.dto(this.database, row);
    } catch (error) {
      if (isUniqueViolation(error)) throw bundleConflict();
      throw error;
    }
  }

  /** Refused while any server grant uses the bundle: replace or delete those grants first. */
  async delete(actor: Actor, id: string): Promise<{ deleted: boolean }> {
    await this.transactions.run(async (transaction) => {
      await assertActorRole(transaction, requireUserId(actor), Role.UserAdmin);
      const bundle = await this.requireBundle(transaction, id, { lock: true });
      const users = await transaction.selectFrom('iam.server_grants as grant')
        .innerJoin('iam.users as user', 'user.id', 'grant.user_id')
        .select(['user.id', 'user.username'])
        .where('grant.bundle_id', '=', id)
        .orderBy('user.username')
        .execute();
      if (users.length > 0) {
        throw new ConflictException({
          code: FailureCode.GrantBundleInUse,
          message: 'The bundle is still assigned to users',
          details: { users: users.map((user) => ({ userId: user.id, username: user.username })) },
        });
      }
      await transaction.deleteFrom('iam.grant_bundles').where('id', '=', id).execute();
      await this.audit.append(
        transaction,
        actor.userId,
        AuditAction.DeleteGrantBundle,
        id,
        'grant_bundle',
        { serverId: bundle.server_id, name: bundle.name },
      );
    });
    return { deleted: true };
  }

  /** What a proposed change would do to every grant of the bundle, without changing anything. */
  async preview(id: string, input: PreviewGrantBundleRequest): Promise<GrantBundlePreviewDto> {
    const current = await this.requireBundle(this.database, id);
    const bundle = await this.dto(this.database, current);
    const before: GrantBundleQuotas = { ...quotasFromColumns(current), dataDisks: bundle.dataDisks };
    const after: GrantBundleQuotas = { ...before };
    for (const field of GRANT_QUOTA_FIELDS) {
      if (input[field.key] !== undefined) (after as Record<string, unknown>)[field.key] = input[field.key] ?? null;
    }
    if (input.dataDisks !== undefined) after.dataDisks = input.dataDisks;
    const changed = GRANT_QUOTA_FIELDS.filter((field) => before[field.key] !== after[field.key]);
    const disksChanged = !sameDataDisks(before.dataDisks, after.dataDisks);
    const grants = await this.database.selectFrom('iam.server_grants as grant')
      .innerJoin('iam.users as user', 'user.id', 'grant.user_id')
      .select([
        'grant.id',
        'grant.user_id',
        'grant.overridden',
        'grant.cpu_cores',
        'grant.mem_bytes',
        'grant.disk_bytes',
        'grant.root_disk_bytes',
        'grant.gpu_count',
        'user.username',
        'user.display_name',
      ])
      .where('grant.bundle_id', '=', id)
      .orderBy('user.username')
      .orderBy('grant.id')
      .execute();
    const server = await this.database.selectFrom('infra.servers')
      .select(['cpu_topology', 'reserved_cpus', 'observed_gpu_pci_addresses'])
      .where('id', '=', current.server_id)
      .executeTakeFirstOrThrow();
    const [usage, ownDisks] = await Promise.all([
      loadServerUsageByUser(this.database, current.server_id, grants.map((grant) => grant.user_id)),
      loadGrantDataDisks(this.database, grants.map((grant) => grant.id)),
    ]);
    const entries: GrantBundlePreviewEntryDto[] = [];
    for (const grant of grants) {
      const overrides = overridesFromColumns(grant, ownDisks.get(grant.id) ?? []);
      const effectiveBefore = effectiveQuotas(before, overrides);
      const effectiveAfter = effectiveQuotas(after, overrides);
      const entry: GrantBundlePreviewEntryDto = {
        grantId: grant.id,
        userId: grant.user_id,
        username: grant.username,
        displayName: grant.display_name,
        changes: [],
        overridden: [],
        dataDisks: disksChanged ? (overrides.dataDisks === undefined ? 'follows' : 'overridden') : null,
        memBytesInUse: null,
        rootDiskBytesInUse: null,
        diskBytesInUse: null,
        dataDisksRevoked: [],
        dataDisksOverCap: [],
        gpusInUseRemoved: [],
      };
      for (const field of changed) {
        if (field.key in overrides) {
          entry.overridden.push({ field: field.key, value: overrides[field.key] ?? null });
        } else {
          entry.changes.push({ field: field.key, before: before[field.key], after: after[field.key] });
        }
      }
      if (entry.changes.length === 0 && entry.overridden.length === 0 && entry.dataDisks === null) continue;
      const memory = usage.runningMemBytes.get(grant.user_id) ?? 0;
      if (effectiveAfter.memBytes !== null && memory > effectiveAfter.memBytes
        && effectiveAfter.memBytes !== effectiveBefore.memBytes) {
        entry.memBytesInUse = memory;
      }
      Object.assign(entry, diskEntryWarnings({
        before: effectiveBefore,
        after: effectiveAfter,
        rootBytes: usage.rootDiskBytes.get(grant.user_id) ?? 0,
        dataByPool: usage.dataBytes.get(grant.user_id) ?? new Map(),
      }));
      if (effectiveAfter.gpuCount !== effectiveBefore.gpuCount) {
        const allowed = new Set(pickGrantGpus(grant.user_id, server.observed_gpu_pci_addresses, effectiveAfter.gpuCount));
        entry.gpusInUseRemoved = (usage.gpuClaims.get(grant.user_id) ?? [])
          .filter((address) => !allowed.has(address));
      }
      entries.push(entry);
    }
    const reserved = new Set(server.reserved_cpus);
    const topology = server.cpu_topology ?? [];
    return {
      bundle,
      proposed: {
        ...bundle,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...after,
      },
      serverCpuCores: topology.length === 0 ? null : topology.filter((cpu) => !reserved.has(cpu.id)).length,
      serverGpuCount: server.observed_gpu_pci_addresses.length,
      entries,
    };
  }

  private async dto(executor: Executor, row: BundleRow): Promise<GrantBundleDto> {
    const [count, disks] = await Promise.all([
      this.grantCount(executor, row.id),
      loadBundleDataDisks(executor, [row.id]),
    ]);
    return bundleDto(row, count, disks.get(row.id) ?? []);
  }

  private async requireBundle(
    executor: Executor,
    id: string,
    options: { lock?: boolean } = {},
  ): Promise<BundleRow> {
    let query = executor.selectFrom('iam.grant_bundles').selectAll().where('id', '=', id);
    if (options.lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new NotFoundException('Bundle not found');
    return row;
  }

  private async grantCount(executor: Executor, bundleId: string): Promise<number> {
    const row = await executor.selectFrom('iam.server_grants')
      .select(sql<string>`count(*)`.as('count'))
      .where('bundle_id', '=', bundleId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** A bundle grants GPUs (a count other than 0) only where the server has GPU enabled. */
  private async assertGpuApplicable(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    gpuCount: number | null,
  ): Promise<void> {
    if (gpuCount === null || gpuCount === 0) return;
    if (await this.gpuClaims.isEnabled(serverId, transaction)) return;
    throw new ConflictException({
      code: FailureCode.GpuGrantNotApplicable,
      message: 'GPU is not enabled on this server',
      details: { serverId },
    });
  }
}
