import { Inject, Injectable } from '@nestjs/common';
import type { Insertable, Kysely, Selectable, Transaction, Updateable } from 'kysely';
import { sql } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import type {
  InfrastructureImageServerAssignmentTable,
  InfrastructureImageTable,
  InfrastructureServerTable,
  InfrastructureSharedBackendTable,
  InfrastructureStoragePoolTable,
} from './infrastructure-database.types.js';

export type InfrastructureExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export type InfrastructureServerRow = Selectable<InfrastructureServerTable>;
export type InfrastructureStoragePoolRow = Selectable<InfrastructureStoragePoolTable>;
export type InfrastructureSharedBackendRow = Selectable<InfrastructureSharedBackendTable>;
export type InfrastructureImageRow = Selectable<InfrastructureImageTable>;
export type InfrastructureImageAssignmentRow = Selectable<InfrastructureImageServerAssignmentTable>;

export const INFRASTRUCTURE_ADVISORY_NAMESPACE = 1_856_214_885;
export const SERVER_ONBOARDING_ADVISORY_KEY = 5;
export const SERVER_CAPACITY_ADVISORY_KEY = SERVER_ONBOARDING_ADVISORY_KEY;
export const IMAGE_CAPACITY_ADVISORY_KEY = 6;

export type ServerInsert = Omit<Insertable<InfrastructureServerTable>, 'created_at' | 'updated_at'>;

export type ImageInsert = Omit<Insertable<InfrastructureImageTable>, 'created_at' | 'updated_at'>;

export interface StoragePoolDiscovery {
  readonly serverId: string;
  readonly incusName: string;
  readonly driver: InfrastructureStoragePoolTable['driver'];
  readonly resizeFamily: InfrastructureStoragePoolTable['resize_family'];
  readonly rootDiskCapable: boolean;
  readonly shareable: boolean;
  readonly blockFilesystem: string | null;
  readonly totalBytes: number | string | bigint | null;
  readonly usedBytes: number | string | bigint | null;
  readonly quotaEffective: boolean | null;
}

export interface SharedBackendInsert {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
  readonly identityKey: string;
  readonly cephFsid: string;
  readonly overcommitRatio: number;
}

/**
 * Serializes server admission with certificate rotation's final coverage gate.
 * Every server writer and certificate activation must acquire this transaction
 * scoped lock before reading or changing the server set.
 */
export async function lockServerOnboarding(executor: InfrastructureExecutor): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    ${INFRASTRUCTURE_ADVISORY_NAMESPACE},
    ${SERVER_ONBOARDING_ADVISORY_KEY}
  )`.execute(executor);
}

@Injectable()
export class InfrastructureRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  executor(executor?: InfrastructureExecutor): InfrastructureExecutor {
    return executor ?? this.database;
  }

  async lockServerCapacity(executor: InfrastructureExecutor): Promise<void> {
    await lockServerOnboarding(executor);
  }

  async lockImageCapacity(executor: InfrastructureExecutor): Promise<void> {
    await sql`select pg_advisory_xact_lock(
      ${INFRASTRUCTURE_ADVISORY_NAMESPACE},
      ${IMAGE_CAPACITY_ADVISORY_KEY}
    )`.execute(executor);
  }

  async countServers(executor: InfrastructureExecutor = this.database): Promise<number> {
    const row = await executor
      .selectFrom('infra.servers')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  listServers(executor: InfrastructureExecutor = this.database) {
    return executor.selectFrom('infra.servers').selectAll().orderBy('name').orderBy('id').execute();
  }

  findServerById(id: string, executor: InfrastructureExecutor = this.database) {
    return executor.selectFrom('infra.servers').selectAll().where('id', '=', id).executeTakeFirst();
  }

  findServerBySlug(slug: string, executor: InfrastructureExecutor = this.database) {
    return executor
      .selectFrom('infra.servers')
      .selectAll()
      .where('slug', '=', slug)
      .executeTakeFirst();
  }

  insertServer(input: ServerInsert, executor: InfrastructureExecutor = this.database) {
    return executor
      .insertInto('infra.servers')
      .values(input)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateServerCas(
    id: string,
    expectedRevision: number,
    patch: Updateable<InfrastructureServerTable>,
    executor: InfrastructureExecutor = this.database,
  ) {
    return executor
      .updateTable('infra.servers')
      .set({
        ...patch,
        revision: expectedRevision + 1,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
  }

  async deleteServer(
    id: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<boolean> {
    const result = await executor
      .deleteFrom('infra.servers')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  listStoragePools(
    serverId?: string,
    includeUnregistered = false,
    executor: InfrastructureExecutor = this.database,
  ) {
    let query = executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .orderBy('incus_name')
      .orderBy('id');
    if (serverId) query = query.where('server_id', '=', serverId);
    if (!includeUnregistered) query = query.where('registered', '=', true);
    return query.execute();
  }

  findStoragePoolById(id: string, executor: InfrastructureExecutor = this.database) {
    return executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  findStoragePoolByName(
    serverId: string,
    incusName: string,
    executor: InfrastructureExecutor = this.database,
  ) {
    return executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('incus_name', '=', incusName)
      .executeTakeFirst();
  }

  async upsertStoragePoolDiscovery(
    id: string,
    discovery: StoragePoolDiscovery,
    executor: InfrastructureExecutor = this.database,
  ) {
    const existing = await this.findStoragePoolByName(
      discovery.serverId,
      discovery.incusName,
      executor,
    );
    if (existing) {
      return executor
        .updateTable('infra.storage_pools')
        .set({
          driver: discovery.driver,
          resize_family: discovery.resizeFamily,
          root_disk_capable: discovery.rootDiskCapable,
          shareable: discovery.shareable,
          block_filesystem: discovery.blockFilesystem,
          total_bytes: discovery.totalBytes,
          used_bytes: discovery.usedBytes,
          quota_effective: discovery.quotaEffective,
          last_observed_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return executor
      .insertInto('infra.storage_pools')
      .values({
        id,
        server_id: discovery.serverId,
        incus_name: discovery.incusName,
        driver: discovery.driver,
        resize_family: discovery.resizeFamily,
        root_disk_capable: discovery.rootDiskCapable,
        shareable: discovery.shareable,
        block_filesystem: discovery.blockFilesystem,
        shared_backend_id: null,
        total_bytes: discovery.totalBytes,
        used_bytes: discovery.usedBytes,
        quota_effective: discovery.quotaEffective,
        display_name: null,
        registered: false,
        last_observed_at: new Date(),
        revision: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  patchStoragePool(
    id: string,
    expectedRevision: number,
    values: Pick<
      Updateable<InfrastructureStoragePoolTable>,
      'registered' | 'display_name' | 'shared_backend_id'
    >,
    executor: InfrastructureExecutor = this.database,
  ) {
    return executor
      .updateTable('infra.storage_pools')
      .set({
        ...values,
        revision: expectedRevision + 1,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
  }

  async hasStoragePoolDependencies(
    id: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<boolean> {
    const [containers, volumes, systemPool, grants] = await Promise.all([
      executor
        .selectFrom('control.containers')
        .select('id')
        .where('root_pool_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
      executor
        .selectFrom('control.volumes')
        .select('id')
        .where('pool_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
      executor
        .selectFrom('infra.servers')
        .select('id')
        .where('system_pool_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
      executor
        .selectFrom('iam.storage_pool_grants')
        .select('id')
        .where('pool_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
    ]);
    return Boolean(containers || volumes || systemPool || grants);
  }

  listSharedBackends(executor: InfrastructureExecutor = this.database) {
    return executor
      .selectFrom('infra.shared_backends')
      .selectAll()
      .orderBy('name')
      .orderBy('id')
      .execute();
  }

  findSharedBackendById(id: string, executor: InfrastructureExecutor = this.database) {
    return executor
      .selectFrom('infra.shared_backends')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  findSharedBackendByIdentity(
    identityKey: string,
    executor: InfrastructureExecutor = this.database,
  ) {
    return executor
      .selectFrom('infra.shared_backends')
      .selectAll()
      .where('identity_key', '=', identityKey)
      .executeTakeFirst();
  }

  insertSharedBackend(
    input: SharedBackendInsert,
    executor: InfrastructureExecutor = this.database,
  ) {
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

  patchSharedBackend(
    id: string,
    expectedRevision: number,
    values: Pick<
      Updateable<InfrastructureSharedBackendTable>,
      'display_name' | 'ceph_fsid' | 'overcommit_ratio'
    >,
    executor: InfrastructureExecutor = this.database,
  ) {
    return executor
      .updateTable('infra.shared_backends')
      .set({
        ...values,
        revision: expectedRevision + 1,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
  }

  async hasSharedBackendDependencies(
    id: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<boolean> {
    const [pools, volumes, grants] = await Promise.all([
      executor
        .selectFrom('infra.storage_pools')
        .select('id')
        .where('shared_backend_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
      executor
        .selectFrom('control.volumes')
        .select('id')
        .where('shared_backend_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
      executor
        .selectFrom('iam.shared_backend_grants')
        .select('id')
        .where('shared_backend_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
    ]);
    return Boolean(pools || volumes || grants);
  }

  async deleteSharedBackend(
    id: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<boolean> {
    const result = await executor
      .deleteFrom('infra.shared_backends')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  async countImages(executor: InfrastructureExecutor = this.database): Promise<number> {
    const row = await executor
      .selectFrom('infra.images')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  listImages(executor: InfrastructureExecutor = this.database) {
    return executor.selectFrom('infra.images').selectAll().orderBy('name').orderBy('id').execute();
  }

  findImageById(id: string, executor: InfrastructureExecutor = this.database) {
    return executor.selectFrom('infra.images').selectAll().where('id', '=', id).executeTakeFirst();
  }

  lockImage(id: string, executor: Transaction<NyabaseDatabase>) {
    return executor
      .selectFrom('infra.images')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  insertImage(input: ImageInsert, executor: InfrastructureExecutor = this.database) {
    return executor
      .insertInto('infra.images')
      .values(input)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateImageCas(
    id: string,
    expectedRevision: number,
    patch: Updateable<InfrastructureImageTable>,
    executor: InfrastructureExecutor = this.database,
  ) {
    return executor
      .updateTable('infra.images')
      .set({
        ...patch,
        revision: expectedRevision + 1,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .where('deleting', '=', false)
      .returningAll()
      .executeTakeFirst();
  }

  markImageDeletingCas(
    id: string,
    expectedRevision: number,
    executor: InfrastructureExecutor = this.database,
  ) {
    return executor
      .updateTable('infra.images')
      .set({
        is_active: false,
        deleting: true,
        cleanup_generation: sql<number>`cleanup_generation + 1`,
        revision: expectedRevision + 1,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .where('deleting', '=', false)
      .returningAll()
      .executeTakeFirst();
  }

  listImageAssignments(
    imageId?: string,
    serverId?: string,
    executor: InfrastructureExecutor = this.database,
  ) {
    let query = executor
      .selectFrom('infra.image_server_assignments')
      .selectAll()
      .orderBy('server_id')
      .orderBy('image_id');
    if (imageId) query = query.where('image_id', '=', imageId);
    if (serverId) query = query.where('server_id', '=', serverId);
    return query.execute();
  }

  findImageAssignmentById(id: string, executor: InfrastructureExecutor = this.database) {
    return executor
      .selectFrom('infra.image_server_assignments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  findImageAssignment(
    imageId: string,
    serverId: string,
    executor: InfrastructureExecutor = this.database,
  ) {
    return executor
      .selectFrom('infra.image_server_assignments')
      .selectAll()
      .where('image_id', '=', imageId)
      .where('server_id', '=', serverId)
      .executeTakeFirst();
  }

  insertImageAssignment(
    input: Insertable<InfrastructureImageServerAssignmentTable>,
    executor: InfrastructureExecutor = this.database,
  ) {
    return executor
      .insertInto('infra.image_server_assignments')
      .values(input)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateImageAssignment(
    id: string,
    expectedGeneration: number,
    patch: Updateable<InfrastructureImageServerAssignmentTable>,
    executor: InfrastructureExecutor = this.database,
  ) {
    return executor
      .updateTable('infra.image_server_assignments')
      .set({
        ...patch,
        generation: expectedGeneration + 1,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('generation', '=', expectedGeneration)
      .returningAll()
      .executeTakeFirst();
  }
}
