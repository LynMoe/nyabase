import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { ContainerScriptFileSpec, ContainerScriptScope } from '@nyabase/common';
import type {
  ContainerScriptTable,
  ContainerScriptVersionTable,
} from '../platform/persistence-pg/container-scripts-database.types.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';

export type ScriptExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;
export type ScriptRow = Selectable<ContainerScriptTable>;
export type VersionRow = Selectable<ContainerScriptVersionTable>;

export interface FileRow {
  name: string;
  sha256: string;
  size_bytes: number;
  destination_path: string | null;
  destination_mode: number | null;
  destination_owner: 'root' | 'login_user' | null;
}

export interface NewScriptValues {
  id: string;
  name: string;
  description: string;
  priority: number;
  everyBoot: boolean;
  createdBy: string;
}

export interface NewVersionValues {
  id: string;
  scriptId: string;
  version: number;
  script: string;
  scope: ContainerScriptScope;
  onNewContainers: boolean;
  applyNow: boolean;
  stoppedPolicy: 'wait' | 'skip';
  timeoutSeconds: number;
  maxAttempts: number;
  maxParallel: number | null;
  maxParallelPerServer: number | null;
  canaryCount: number | null;
  pauseAfterFailures: number | null;
  note: string;
  publishedBy: string;
}

/**
 * Container script definitions: scripts, their immutable versions and files,
 * and file contents (blobs, by sha256). Target and run state live in
 * ContainerScriptTargetsRepository.
 */
@Injectable()
export class ContainerScriptsRepository {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  get db(): Kysely<NyabaseDatabase> {
    return this.database;
  }

  listScripts(executor: ScriptExecutor = this.database): Promise<ScriptRow[]> {
    return executor.selectFrom('control.container_scripts').selectAll().orderBy('priority').orderBy('created_at').execute();
  }

  findScript(id: string, executor: ScriptExecutor = this.database): Promise<ScriptRow | undefined> {
    return executor.selectFrom('control.container_scripts').selectAll().where('id', '=', id).executeTakeFirst();
  }

  findScriptForUpdate(id: string, executor: Transaction<NyabaseDatabase>): Promise<ScriptRow | undefined> {
    return executor.selectFrom('control.container_scripts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  }

  /** A live (not archived) script other than `excludeId` that already has this name or priority. */
  findConflict(name: string, priority: number, excludeId: string | null, executor: ScriptExecutor) {
    let query = executor
      .selectFrom('control.container_scripts')
      .select(['id', 'name', 'priority'])
      .where('status', '<>', 'archived')
      .where((expression) => expression.or([expression('name', '=', name), expression('priority', '=', priority)]));
    if (excludeId) query = query.where('id', '<>', excludeId);
    return query.orderBy('priority').executeTakeFirst();
  }

  async maxLivePriority(executor: ScriptExecutor): Promise<number> {
    const row = await executor
      .selectFrom('control.container_scripts')
      .select(sql<number>`coalesce(max(priority), 0)`.as('max'))
      .where('status', '<>', 'archived')
      .executeTakeFirstOrThrow();
    return Number(row.max);
  }

  async insertScript(values: NewScriptValues, executor: Transaction<NyabaseDatabase>): Promise<void> {
    await executor.insertInto('control.container_scripts').values({
      id: values.id,
      name: values.name,
      description: values.description,
      priority: values.priority,
      every_boot: values.everyBoot,
      status: 'active',
      pause_reason: null,
      current_version: 1,
      revision: 1,
      created_by: values.createdBy,
    }).execute();
  }

  /** CAS on the revision; false when it moved. */
  async updateScript(
    id: string,
    expectedRevision: number,
    values: Partial<{
      name: string;
      description: string;
      priority: number;
      status: 'active' | 'paused' | 'archived';
      pause_reason: 'manual' | 'canary' | 'failures' | null;
      current_version: number;
      canary_cleared: boolean;
      failures_since: Date;
    }>,
    executor: ScriptExecutor,
  ): Promise<boolean> {
    const result = await executor
      .updateTable('control.container_scripts')
      .set({ ...values, revision: expectedRevision + 1, updated_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', id)
      .where('revision', '=', expectedRevision)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async insertVersion(values: NewVersionValues, executor: Transaction<NyabaseDatabase>): Promise<void> {
    await executor.insertInto('control.container_script_versions').values({
      id: values.id,
      script_id: values.scriptId,
      version: values.version,
      script: values.script,
      scope_all: values.scope.all,
      scope_server_ids: values.scope.serverIds,
      scope_image_ids: values.scope.imageIds,
      scope_owner_ids: values.scope.ownerIds,
      scope_container_ids: values.scope.containerIds,
      scope_exclude_container_ids: values.scope.excludeContainerIds,
      on_new_containers: values.onNewContainers,
      apply_now: values.applyNow,
      stopped_policy: values.stoppedPolicy,
      timeout_seconds: values.timeoutSeconds,
      max_attempts: values.maxAttempts,
      max_parallel: values.maxParallel,
      max_parallel_per_server: values.maxParallelPerServer,
      canary_count: values.canaryCount,
      pause_after_failures: values.pauseAfterFailures,
      note: values.note,
      published_by: values.publishedBy,
    }).execute();
  }

  /** `blobIds`: the blob id of every file's sha256 (see blobsFor). */
  async insertFiles(
    versionId: string,
    files: readonly ContainerScriptFileSpec[],
    blobIds: ReadonlyMap<string, string>,
    executor: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    if (files.length === 0) return;
    await executor.insertInto('control.container_script_files').values(files.map((file, position) => ({
      version_id: versionId,
      position,
      name: file.name,
      blob_id: blobIds.get(file.sha256)!,
      destination_path: file.destination?.path ?? null,
      destination_mode: file.destination ? Number.parseInt(file.destination.mode, 8) : null,
      destination_owner: file.destination?.owner ?? null,
    }))).execute();
  }

  findVersion(scriptId: string, version: number, executor: ScriptExecutor = this.database): Promise<VersionRow | undefined> {
    return executor
      .selectFrom('control.container_script_versions')
      .selectAll()
      .where('script_id', '=', scriptId)
      .where('version', '=', version)
      .executeTakeFirst();
  }

  /** Every script's current version, keyed by script id. */
  async currentVersions(executor: ScriptExecutor = this.database): Promise<Map<string, VersionRow>> {
    const rows = await executor
      .selectFrom('control.container_script_versions as v')
      .innerJoin('control.container_scripts as s', (join) => join
        .onRef('s.id', '=', 'v.script_id')
        .onRef('s.current_version', '=', 'v.version'))
      .selectAll('v')
      .execute();
    return new Map(rows.map((row) => [row.script_id, row]));
  }

  listVersions(scriptId: string, executor: ScriptExecutor = this.database) {
    return executor
      .selectFrom('control.container_script_versions as v')
      .select([
        'v.version',
        'v.note',
        'v.apply_now',
        'v.on_new_containers',
        'v.published_at',
        'v.published_by',
        (expression) => expression
          .selectFrom('control.container_script_files as f')
          .select(sql<number>`count(*)::int`.as('count'))
          .whereRef('f.version_id', '=', 'v.id')
          .as('file_count'),
      ])
      .where('v.script_id', '=', scriptId)
      .orderBy('v.version', 'desc')
      .execute();
  }

  listFiles(scriptId: string, version: number, executor: ScriptExecutor = this.database): Promise<FileRow[]> {
    return executor
      .selectFrom('control.container_script_files as f')
      .innerJoin('control.container_script_versions as v', 'v.id', 'f.version_id')
      .innerJoin('control.container_script_blobs as b', 'b.id', 'f.blob_id')
      .select([
        'f.name',
        'b.sha256',
        'b.size_bytes',
        'f.destination_path',
        'f.destination_mode',
        'f.destination_owner',
      ])
      .where('v.script_id', '=', scriptId)
      .where('v.version', '=', version)
      .orderBy('f.position')
      .execute();
  }

  // --- blobs -------------------------------------------------------------------------

  async insertBlob(sha256: string, content: Buffer, createdBy: string): Promise<void> {
    await this.database
      .insertInto('control.container_script_blobs')
      .values({ id: randomUUID(), sha256, content, size_bytes: content.byteLength, created_by: createdBy })
      .onConflict((conflict) => conflict.column('sha256').doNothing())
      .execute();
  }

  /** Id and size of the blobs that exist among `shas` (locked: a version is about to reference them). */
  async blobsFor(shas: readonly string[], executor: ScriptExecutor): Promise<Map<string, { id: string; size: number }>> {
    if (shas.length === 0) return new Map();
    const rows = await executor
      .selectFrom('control.container_script_blobs')
      .select(['id', 'sha256', 'size_bytes'])
      .where('sha256', 'in', [...new Set(shas)])
      .forShare()
      .execute();
    return new Map(rows.map((row) => [row.sha256, { id: row.id, size: row.size_bytes }]));
  }

  async blobContent(sha256: string): Promise<Buffer | null> {
    const row = await this.database
      .selectFrom('control.container_script_blobs')
      .select('content')
      .where('sha256', '=', sha256)
      .executeTakeFirst();
    return row?.content ?? null;
  }

  /** Uploads no version references, older than `olderThan` (an upload awaiting its publish is newer). */
  async deleteUnreferencedBlobs(olderThan: Date): Promise<number> {
    const result = await this.database
      .deleteFrom('control.container_script_blobs as b')
      .where('b.created_at', '<', olderThan)
      .where(({ not, exists, selectFrom }) => not(exists(
        selectFrom('control.container_script_files as f').select('f.blob_id').whereRef('f.blob_id', '=', 'b.id'),
      )))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
