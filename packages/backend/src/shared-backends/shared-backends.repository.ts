import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';

export type SharedBackendExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

@Injectable()
export class SharedBackendsRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  list(executor: SharedBackendExecutor = this.database) {
    return executor
      .selectFrom('infra.shared_backends as backend')
      .leftJoin('infra.storage_pools as pool', 'pool.shared_backend_id', 'backend.id')
      .select([
        'backend.id',
        'backend.name',
        'backend.display_name',
        'backend.identity_key',
        'backend.ceph_fsid',
        'backend.total_bytes',
        'backend.used_bytes',
        'backend.overcommit_ratio',
        'backend.revision',
        'backend.created_at',
        'backend.updated_at',
      ])
      .select(sql<string[]>`coalesce(
        array_agg(DISTINCT pool.server_id ORDER BY pool.server_id)
          FILTER (WHERE pool.server_id IS NOT NULL),
        ARRAY[]::uuid[]
      )`.as('server_ids'))
      .groupBy([
        'backend.id',
        'backend.name',
        'backend.display_name',
        'backend.identity_key',
        'backend.ceph_fsid',
        'backend.total_bytes',
        'backend.used_bytes',
        'backend.overcommit_ratio',
        'backend.revision',
        'backend.created_at',
        'backend.updated_at',
      ])
      .orderBy('backend.name')
      .execute();
  }

  findById(id: string, executor: SharedBackendExecutor = this.database) {
    return executor
      .selectFrom('infra.shared_backends')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  findByIdForUpdate(id: string, executor: SharedBackendExecutor) {
    return executor
      .selectFrom('infra.shared_backends')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  findByIdentity(identityKey: string, executor: SharedBackendExecutor = this.database) {
    return executor
      .selectFrom('infra.shared_backends')
      .selectAll()
      .where('identity_key', '=', identityKey)
      .executeTakeFirst();
  }

  findByIdentityForUpdate(identityKey: string, executor: SharedBackendExecutor) {
    return executor
      .selectFrom('infra.shared_backends')
      .selectAll()
      .where('identity_key', '=', identityKey)
      .forUpdate()
      .executeTakeFirst();
  }

  findByFsid(fsid: string, executor: SharedBackendExecutor = this.database) {
    return executor
      .selectFrom('infra.shared_backends')
      .selectAll()
      .where(sql<boolean>`lower(ceph_fsid) = ${fsid.toLowerCase()}`)
      .executeTakeFirst();
  }

  findByFsidForUpdate(fsid: string, executor: SharedBackendExecutor) {
    return executor
      .selectFrom('infra.shared_backends')
      .selectAll()
      .where(sql<boolean>`lower(ceph_fsid) = ${fsid.toLowerCase()}`)
      .forUpdate()
      .executeTakeFirst();
  }

  insert(input: {
    id: string;
    name: string;
    displayName: string | null;
    identityKey: string;
    cephFsid: string;
    overcommitRatio: number;
  }, executor: SharedBackendExecutor = this.database) {
    return executor
      .insertInto('infra.shared_backends')
      .values({
        id: input.id,
        name: input.name,
        display_name: input.displayName,
        identity_key: input.identityKey,
        ceph_fsid: input.cephFsid,
        total_bytes: null,
        used_bytes: null,
        overcommit_ratio: input.overcommitRatio,
        revision: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  patch(
    id: string,
    expectedRevision: number,
    values: {
      display_name?: string | null;
      ceph_fsid?: string;
      overcommit_ratio?: number;
    },
    executor: SharedBackendExecutor = this.database,
  ) {
    return executor
      .updateTable('infra.shared_backends')
      .set({ ...values, revision: expectedRevision + 1 })
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
  }

  async hasDependencies(id: string, executor: SharedBackendExecutor = this.database) {
    const [pools, volumes, grants] = await Promise.all([
      executor.selectFrom('infra.storage_pools').select('id')
        .where('shared_backend_id', '=', id).limit(1).executeTakeFirst(),
      executor.selectFrom('control.volumes').select('id')
        .where('shared_backend_id', '=', id).limit(1).executeTakeFirst(),
      executor.selectFrom('iam.shared_backend_grants').select('id')
        .where('shared_backend_id', '=', id).limit(1).executeTakeFirst(),
    ]);
    return Boolean(pools || volumes || grants);
  }

  delete(id: string, executor: SharedBackendExecutor = this.database) {
    return executor
      .deleteFrom('infra.shared_backends')
      .where('id', '=', id)
      .executeTakeFirst();
  }
}
