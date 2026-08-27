import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  FailureCode,
  type SharedBackendDto,
} from '@nyabase/common';
import { SharedBackendsRepository } from './shared-backends.repository.js';
import { isoDate, numberValue } from '../domain/domain-utils.js';
import { sql, type Kysely } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { classifyGrantExpiry } from '../access/grant-expiry.js';

function normalizedIdentity(value: string): string {
  const identity = value.trim();
  if (!identity) throw new BadRequestException('Shared backend identityKey is required');
  return identity;
}

function normalizedFsid(value: string): string {
  const fsid = value.trim().toLowerCase();
  if (!fsid) throw new BadRequestException('Shared backend cephFsid is required');
  return fsid;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === '23505') return true;
    current = record.cause;
  }
  return false;
}

function isReferenceViolation(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === '23503' || record.code === '23505') return true;
    current = record.cause;
  }
  return false;
}

@Injectable()
export class SharedBackendsService {
  constructor(
    private readonly repository: SharedBackendsRepository,
    private readonly transactions: PgTransactionManager,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  async list(): Promise<SharedBackendDto[]> {
    const rows = await this.repository.list();
    const committed = await this.committedUsedByBackendIds(rows.map((row) => row.id));
    return rows.map((row) => this.toDto(row, committed.get(row.id) ?? 0));
  }

  async get(id: string): Promise<SharedBackendDto> {
    const row = await this.repository.findById(id);
    if (!row) throw new NotFoundException('Shared backend not found');
    const pools = await this.repository.list();
    const aggregate = pools.find((candidate) => candidate.id === id);
    const committed = await this.committedUsedByBackendIds([id]);
    return this.toDto({
      ...row,
      server_ids: aggregate?.server_ids ?? [],
    }, committed.get(id) ?? 0);
  }

  async listForUser(userId: string): Promise<SharedBackendDto[]> {
    const grants = await this.database
      .selectFrom('iam.shared_backend_grants as grant')
      .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
      .select(['grant.shared_backend_id', 'grant.expires_at'])
      .where((expression) => expression.or([
        expression('grant.user_id', '=', userId),
        expression('member.user_id', '=', userId),
      ]))
      .execute();
    const ids = new Set(grants
      .filter((grant) => classifyGrantExpiry(grant.expires_at) !== 'lost')
      .map((grant) => grant.shared_backend_id));
    return (await this.list()).filter((backend) => ids.has(backend.id));
  }

  async getForUser(id: string, userId: string): Promise<SharedBackendDto> {
    const backend = (await this.listForUser(userId)).find((item) => item.id === id);
    if (!backend) throw new NotFoundException('Shared backend not found');
    return backend;
  }

  async create(input: {
    name: string;
    displayName?: string | null;
    identityKey: string;
    cephFsid: string;
    overcommitRatio: number;
  }): Promise<SharedBackendDto> {
    const identityKey = normalizedIdentity(input.identityKey);
    const fsid = normalizedFsid(input.cephFsid);
    let result;
    try {
      result = await this.transactions.run(
        async (transaction) => {
          const identity = await this.repository.findByIdentityForUpdate(
            identityKey,
            transaction,
          );
          if (identity) {
            if (identity.ceph_fsid.toLowerCase() !== fsid) {
              throw new ConflictException({
                code: FailureCode.SharedBackendIdentityConflict,
                message: 'The shared backend identity is already bound to another FSID',
                details: {
                  identityKey,
                  expectedFsid: identity.ceph_fsid,
                  requestedFsid: fsid,
                },
              });
            }
            return { row: identity, created: false };
          }
          const fsidOwner = await this.repository.findByFsidForUpdate(fsid, transaction);
          if (fsidOwner) {
            throw new ConflictException({
              code: FailureCode.SharedBackendIdentityConflict,
              message: 'The CephFS FSID is already bound to another shared backend identity',
              details: {
                requestedFsid: fsid,
                existingIdentityKey: fsidOwner.identity_key,
              },
            });
          }
          const row = await this.repository.insert({
            id: randomUUID(),
            name: input.name,
            displayName: input.displayName ?? null,
            identityKey,
            cephFsid: fsid,
            overcommitRatio: input.overcommitRatio,
          }, transaction);
          return { row, created: true };
        },
        { isolationLevel: 'serializable', maxAttempts: 5 },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: FailureCode.SharedBackendIdentityConflict,
          message: 'The shared backend identity or FSID is already registered',
          details: { identityKey, requestedFsid: fsid },
        });
      }
      throw error;
    }
    if (result.created) return this.toDto({ ...result.row, server_ids: [] }, 0);
    return this.get(result.row.id);
  }

  async patch(
    id: string,
    input: {
      expectedRevision: number;
      displayName?: string | null;
      cephFsid?: string;
      overcommitRatio?: number;
    },
  ): Promise<SharedBackendDto> {
    const updated = await this.transactions.run(
      async (transaction) => {
        const current = await this.repository.findByIdForUpdate(id, transaction);
        if (!current) throw new NotFoundException('Shared backend not found');
        if (Number(current.revision) !== input.expectedRevision) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }
        const requestedFsid = input.cephFsid === undefined
          ? current.ceph_fsid
          : normalizedFsid(input.cephFsid);
        if (requestedFsid !== current.ceph_fsid.toLowerCase()) {
          if (await this.repository.hasDependencies(id, transaction)) {
            throw new ConflictException({
              code: FailureCode.SharedBackendInUse,
              message: 'A shared backend FSID cannot change while it is referenced',
            });
          }
          const conflict = await this.repository.findByFsidForUpdate(
            requestedFsid,
            transaction,
          );
          if (conflict && conflict.id !== id) {
            throw new ConflictException({
              code: FailureCode.SharedBackendIdentityConflict,
              message: 'The CephFS FSID is already bound to another identity',
              details: { requestedFsid, existingIdentityKey: conflict.identity_key },
            });
          }
        }
        const row = await this.repository.patch(id, input.expectedRevision, {
          ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
          ...(input.cephFsid !== undefined ? { ceph_fsid: requestedFsid } : {}),
          ...(input.overcommitRatio !== undefined
            ? { overcommit_ratio: input.overcommitRatio }
            : {}),
        }, transaction);
        if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
        return row;
      },
      { isolationLevel: 'serializable', maxAttempts: 5 },
    );
    return this.get(updated.id);
  }

  async delete(id: string): Promise<void> {
    try {
      await this.transactions.run(
        async (transaction) => {
          const row = await this.repository.findByIdForUpdate(id, transaction);
          if (!row) throw new NotFoundException('Shared backend not found');
          if (await this.repository.hasDependencies(id, transaction)) {
            throw new ConflictException({
              code: FailureCode.SharedBackendInUse,
              message: 'Shared backend is still referenced',
            });
          }
          await this.repository.delete(id, transaction);
        },
        { isolationLevel: 'serializable', maxAttempts: 5 },
      );
    } catch (error) {
      if (isReferenceViolation(error)) {
        throw new ConflictException({
          code: FailureCode.SharedBackendInUse,
          message: 'Shared backend is still referenced',
        });
      }
      throw error;
    }
  }

  private async committedUsedByBackendIds(ids: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (ids.length === 0) return result;
    const rows = await this.database
      .selectFrom('control.volumes')
      .select(['shared_backend_id'])
      .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('used'))
      .where('shared_backend_id', 'in', ids)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .groupBy('shared_backend_id')
      .execute();
    for (const row of rows) {
      if (row.shared_backend_id === null) continue;
      result.set(row.shared_backend_id, numberValue(row.used));
    }
    return result;
  }

  private toDto(row: {
    id: string;
    name: string;
    display_name: string | null;
    identity_key: string;
    ceph_fsid: string;
    total_bytes: string | number | null;
    used_bytes: string | number | null;
    overcommit_ratio: string | number;
    revision: string | number;
    created_at: Date | string;
    updated_at: Date | string;
    server_ids?: string[] | null;
  }, committedUsedBytes?: number): SharedBackendDto {
    const dbUsed = row.used_bytes === null ? null : numberValue(row.used_bytes);
    const usedBytes = committedUsedBytes !== undefined
      ? committedUsedBytes
      : dbUsed;
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      identityKey: row.identity_key,
      cephFsid: row.ceph_fsid,
      totalBytes: row.total_bytes === null ? null : numberValue(row.total_bytes),
      usedBytes,
      overcommitRatio: numberValue(row.overcommit_ratio),
      serverIds: row.server_ids ?? [],
      revision: numberValue(row.revision),
      createdAt: isoDate(row.created_at) ?? new Date(0).toISOString(),
      updatedAt: isoDate(row.updated_at) ?? new Date(0).toISOString(),
    };
  }
}
