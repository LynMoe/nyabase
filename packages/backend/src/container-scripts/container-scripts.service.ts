import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import {
  AuditAction,
  CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES,
  CONTAINER_SCRIPT_PREVIEW_LIMIT,
  CONTAINER_SCRIPT_PRIORITY_MAX,
  CONTAINER_SCRIPT_PRIORITY_STEP,
  containerScriptScopeMatches,
  FailureCode,
  type ContainerScriptBlobDto,
  type ContainerScriptDto,
  type ContainerScriptPreviewDto,
  type ContainerScriptRunDto,
  type ContainerScriptRunPageDto,
  type ContainerScriptScope,
  type ContainerScriptTargetDto,
  type ContainerScriptVersionDto,
  type ContainerScriptVersionInput,
  type ContainerScriptVersionSummaryDto,
  type CreateContainerScriptRequest,
  type ListContainerScriptRunsQuery,
  type ListContainerScriptTargetsQuery,
  type PatchContainerScriptRequest,
  type PublishContainerScriptRequest,
  type RetryContainerScriptRequest,
} from '@nyabase/common';
import { AuditService } from '../iam/audit.service.js';
import { lockContainerScripts } from '../platform/persistence-pg/advisory-locks.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { afterCommit } from '../platform/post-commit.js';
import {
  toRunDto,
  toRunListItemDto,
  toScriptDto,
  toTargetDto,
  toVersionDto,
  toVersionSummaryDto,
} from './container-script-dtos.js';
import { ContainerScriptReadModel, emptyCounts } from './container-script-read-model.js';
import { ContainerScriptScheduler } from './container-script-scheduler.service.js';
import { ContainerScriptTargetsRepository } from './container-script-targets.repository.js';
import { ContainerScriptsRepository, type ScriptRow } from './container-scripts.repository.js';

const AUDIT_TARGET_TYPE = 'container_script';
type Tx = Transaction<NyabaseDatabase>;

function pgErrorCode(error: unknown): string | null {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && /^[0-9A-Z]{5}$/.test(record.code)) return record.code;
    current = record.cause;
  }
  return null;
}

function conflict(details: Record<string, unknown> = {}): ConflictException {
  return new ConflictException({
    code: FailureCode.ContainerScriptConflict,
    message: 'A container script with this name or priority already exists',
    details,
  });
}

const revisionConflict = () => new ConflictException({ code: FailureCode.RevisionConflict });
const archived = () => new ConflictException({
  code: FailureCode.ContainerScriptArchived,
  message: 'The container script is archived',
});
const notFound = () => new NotFoundException('Container script not found');

function translateWriteError(error: unknown): unknown {
  return pgErrorCode(error) === '23505' ? conflict() : error;
}

function scriptDigest(script: string): string {
  return createHash('sha256').update(script).digest('hex');
}

/** What the audit log keeps of a version (the script by digest, not in full). */
function versionAudit(version: number, input: ContainerScriptVersionInput, onNewContainers: boolean) {
  return {
    version,
    note: input.note,
    scriptSha256: scriptDigest(input.script),
    scriptBytes: Buffer.byteLength(input.script),
    files: input.files.map((file) => ({ name: file.name, sha256: file.sha256, destination: file.destination })),
    scope: input.scope,
    applyNow: input.applyNow,
    onNewContainers,
    stoppedPolicy: input.stoppedPolicy,
    timeoutSeconds: input.timeoutSeconds,
    maxAttempts: input.maxAttempts,
    maxParallel: input.maxParallel,
    maxParallelPerServer: input.maxParallelPerServer,
    canaryCount: input.canaryCount,
    pauseAfterFailures: input.pauseAfterFailures,
  };
}

@Injectable()
export class ContainerScriptsService {
  constructor(
    private readonly scripts: ContainerScriptsRepository,
    private readonly targets: ContainerScriptTargetsRepository,
    private readonly read: ContainerScriptReadModel,
    private readonly transactions: PgTransactionManager,
    private readonly audit: AuditService,
    private readonly scheduler: ContainerScriptScheduler,
  ) {}

  // --- reads ---------------------------------------------------------------------

  async list(): Promise<ContainerScriptDto[]> {
    const [rows, versions, counts] = await Promise.all([
      this.scripts.listScripts(),
      this.scripts.currentVersions(),
      this.read.counts(),
    ]);
    const people = await this.read.persons([
      ...rows.map((row) => row.created_by),
      ...[...versions.values()].map((version) => version.published_by),
    ]);
    return Promise.all(rows.map(async (row) => {
      const version = versions.get(row.id)!;
      const files = await this.scripts.listFiles(row.id, version.version);
      return toScriptDto(row, toVersionDto(version, files, people), counts.get(row.id) ?? emptyCounts(), people);
    }));
  }

  async get(id: string): Promise<ContainerScriptDto> {
    const row = await this.scripts.findScript(id);
    if (!row) throw notFound();
    const [current, counts] = await Promise.all([this.version(id, row.current_version), this.read.counts()]);
    const people = await this.read.persons([row.created_by]);
    return toScriptDto(row, current, counts.get(id) ?? emptyCounts(), people);
  }

  async version(id: string, version: number): Promise<ContainerScriptVersionDto> {
    const row = await this.scripts.findVersion(id, version);
    if (!row) throw new NotFoundException('Container script version not found');
    const [files, people] = await Promise.all([
      this.scripts.listFiles(id, version),
      this.read.persons([row.published_by]),
    ]);
    return toVersionDto(row, files, people);
  }

  async versions(id: string): Promise<ContainerScriptVersionSummaryDto[]> {
    await this.requireScript(id);
    const rows = await this.scripts.listVersions(id);
    const people = await this.read.persons(rows.map((row) => row.published_by));
    return rows.map((row) => toVersionSummaryDto(row, people));
  }

  async listTargets(id: string, query: ListContainerScriptTargetsQuery): Promise<ContainerScriptTargetDto[]> {
    const script = await this.requireScript(id);
    return (await this.read.targets(id, query.state)).map((row) => toTargetDto(row, script.every_boot));
  }

  async listRuns(id: string, query: ListContainerScriptRunsQuery): Promise<ContainerScriptRunPageDto> {
    await this.requireScript(id);
    const rows = await this.read.runs(id, query);
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toRunListItemDto),
      nextBefore: rows.length > query.limit ? page[page.length - 1]!.id : null,
    };
  }

  async getRun(id: string, runId: string): Promise<ContainerScriptRunDto> {
    const row = await this.read.run(id, runId);
    if (!row) throw new NotFoundException('Container script run not found');
    return toRunDto(row);
  }

  async preview(scope: ContainerScriptScope): Promise<ContainerScriptPreviewDto> {
    const matching = (await this.read.scopeCandidates()).filter((container) => containerScriptScopeMatches(scope, {
      id: container.id,
      serverId: container.server_id,
      imageId: container.image_id,
      ownerId: container.owner_id,
    }));
    const servers = new Map<string, { serverId: string; serverName: string; total: number; running: number }>();
    for (const container of matching) {
      const entry = servers.get(container.server_id)
        ?? { serverId: container.server_id, serverName: container.server_name, total: 0, running: 0 };
      entry.total += 1;
      if (container.running) entry.running += 1;
      servers.set(container.server_id, entry);
    }
    return {
      total: matching.length,
      running: matching.filter((container) => container.running).length,
      servers: [...servers.values()],
      containers: matching.slice(0, CONTAINER_SCRIPT_PREVIEW_LIMIT).map((container) => ({
        id: container.id,
        name: container.name,
        serverId: container.server_id,
        serverName: container.server_name,
        owner: { id: container.owner_id, username: container.owner_username, displayName: container.owner_display_name },
        running: container.running,
      })),
      truncated: matching.length > CONTAINER_SCRIPT_PREVIEW_LIMIT,
    };
  }

  // --- blobs -----------------------------------------------------------------------

  async uploadBlob(actorId: string, content: Buffer): Promise<ContainerScriptBlobDto> {
    const sha256 = createHash('sha256').update(content).digest('hex');
    await this.scripts.insertBlob(sha256, content, actorId);
    return { sha256, sizeBytes: content.byteLength };
  }

  async blob(sha256: string): Promise<Buffer> {
    const content = await this.scripts.blobContent(sha256);
    if (!content) throw new NotFoundException('File content not found');
    return content;
  }

  // --- writes ----------------------------------------------------------------------

  async create(actorId: string, input: CreateContainerScriptRequest): Promise<ContainerScriptDto> {
    const id = randomUUID();
    const onNewContainers = input.everyBoot || input.onNewContainers;
    try {
      await this.transactions.run(async (tx) => {
        await lockContainerScripts(tx);
        const priority = input.priority
          ?? Math.min(CONTAINER_SCRIPT_PRIORITY_MAX, (await this.scripts.maxLivePriority(tx)) + CONTAINER_SCRIPT_PRIORITY_STEP);
        await this.assertUnique(input.name, priority, null, tx);
        await this.scripts.insertScript({
          id,
          name: input.name,
          description: input.description,
          priority,
          everyBoot: input.everyBoot,
          createdBy: actorId,
        }, tx);
        await this.insertVersion(id, 1, input, onNewContainers, actorId, tx);
        await this.targets.applyPublish({
          scriptId: id,
          version: 1,
          everyBoot: input.everyBoot,
          applyNow: input.applyNow,
          stoppedPolicy: input.stoppedPolicy,
        }, tx);
        await this.audit.append(tx, actorId, AuditAction.CreateContainerScript, id, AUDIT_TARGET_TYPE, {
          name: input.name,
          description: input.description,
          priority,
          everyBoot: input.everyBoot,
          ...versionAudit(1, input, onNewContainers),
        });
        afterCommit(tx, () => this.scheduler.wake());
      });
    } catch (error) {
      throw translateWriteError(error);
    }
    return this.get(id);
  }

  /**
   * A new version. Publishing ends an automatic pause (its counts start over
   * with the version); a manual pause stays until an administrator resumes.
   */
  async publish(actorId: string, id: string, input: PublishContainerScriptRequest): Promise<ContainerScriptDto> {
    await this.transactions.run(async (tx) => {
      await lockContainerScripts(tx);
      const script = await this.lockedScript(id, input.expectedRevision, tx);
      const version = script.current_version + 1;
      const onNewContainers = script.every_boot || input.onNewContainers;
      await this.insertVersion(id, version, input, onNewContainers, actorId, tx);
      const autoPaused = script.status === 'paused' && script.pause_reason !== 'manual';
      if (!(await this.scripts.updateScript(id, input.expectedRevision, {
        current_version: version,
        canary_cleared: false,
        failures_since: new Date(),
        ...(autoPaused ? { status: 'active', pause_reason: null } : {}),
      }, tx))) {
        throw revisionConflict();
      }
      await this.targets.applyPublish({
        scriptId: id,
        version,
        everyBoot: script.every_boot,
        applyNow: input.applyNow,
        stoppedPolicy: input.stoppedPolicy,
      }, tx);
      await this.audit.append(tx, actorId, AuditAction.PublishContainerScript, id, AUDIT_TARGET_TYPE, {
        name: script.name,
        ...versionAudit(version, input, onNewContainers),
      });
      afterCommit(tx, () => this.scheduler.wake());
    });
    return this.get(id);
  }

  async patch(actorId: string, id: string, input: PatchContainerScriptRequest): Promise<ContainerScriptDto> {
    try {
      await this.transactions.run(async (tx) => {
        await lockContainerScripts(tx);
        const script = await this.lockedScript(id, input.expectedRevision, tx, { allowArchived: true });
        const values = {
          name: input.name ?? script.name,
          description: input.description ?? script.description,
          priority: input.priority ?? script.priority,
        };
        if (script.status !== 'archived') await this.assertUnique(values.name, values.priority, id, tx);
        if (!(await this.scripts.updateScript(id, input.expectedRevision, values, tx))) throw revisionConflict();
        await this.audit.append(tx, actorId, AuditAction.UpdateContainerScript, id, AUDIT_TARGET_TYPE, {
          ...values,
          changed: Object.keys(input).filter((key) => key !== 'expectedRevision').sort(),
        });
        afterCommit(tx, () => this.scheduler.wake());
      });
    } catch (error) {
      throw translateWriteError(error);
    }
    return this.get(id);
  }

  async pause(actorId: string, id: string, expectedRevision: number): Promise<ContainerScriptDto> {
    return this.changeStatus(actorId, id, expectedRevision, AuditAction.PauseContainerScript, (script) => (
      script.status === 'paused' ? null : { status: 'paused', pause_reason: 'manual' }
    ));
  }

  /** Resuming past a canary clears it; failures count again from now. */
  async resume(actorId: string, id: string, expectedRevision: number): Promise<ContainerScriptDto> {
    return this.changeStatus(actorId, id, expectedRevision, AuditAction.ResumeContainerScript, (script) => (
      script.status === 'active'
        ? null
        : {
          status: 'active',
          pause_reason: null,
          failures_since: new Date(),
          canary_cleared: script.canary_cleared || script.pause_reason === 'canary',
        }
    ));
  }

  /** Archived scripts start no runs, take no versions and give up their name and priority. */
  async archive(actorId: string, id: string, expectedRevision: number): Promise<ContainerScriptDto> {
    return this.changeStatus(actorId, id, expectedRevision, AuditAction.ArchiveContainerScript, () => ({
      status: 'archived',
      pause_reason: null,
    }));
  }

  async retry(actorId: string, id: string, input: RetryContainerScriptRequest): Promise<ContainerScriptDto> {
    await this.transactions.run(async (tx) => {
      await lockContainerScripts(tx);
      const script = await this.scripts.findScriptForUpdate(id, tx);
      if (!script) throw notFound();
      if (script.status === 'archived') throw archived();
      const containerIds = await this.targets.retry(id, script.current_version, input.containerIds ?? null, tx);
      await this.audit.append(tx, actorId, AuditAction.RetryContainerScript, id, AUDIT_TARGET_TYPE, {
        name: script.name,
        version: script.current_version,
        requested: input.containerIds ?? 'failed',
        containerIds,
      });
      afterCommit(tx, () => this.scheduler.wake());
    });
    return this.get(id);
  }

  // --- helpers ---------------------------------------------------------------------

  private async changeStatus(
    actorId: string,
    id: string,
    expectedRevision: number,
    action: AuditAction,
    next: (script: ScriptRow) => Parameters<ContainerScriptsRepository['updateScript']>[2] | null,
  ): Promise<ContainerScriptDto> {
    await this.transactions.run(async (tx) => {
      await lockContainerScripts(tx);
      const script = await this.lockedScript(id, expectedRevision, tx);
      const values = next(script);
      if (!values) return;
      if (!(await this.scripts.updateScript(id, expectedRevision, values, tx))) throw revisionConflict();
      await this.audit.append(tx, actorId, action, id, AUDIT_TARGET_TYPE, {
        name: script.name,
        from: script.status,
        to: values.status,
      });
      afterCommit(tx, () => this.scheduler.wake());
    });
    return this.get(id);
  }

  private async requireScript(id: string): Promise<ScriptRow> {
    const script = await this.scripts.findScript(id);
    if (!script) throw notFound();
    return script;
  }

  private async lockedScript(
    id: string,
    expectedRevision: number,
    tx: Tx,
    options: { allowArchived?: boolean } = {},
  ): Promise<ScriptRow> {
    const script = await this.scripts.findScriptForUpdate(id, tx);
    if (!script) throw notFound();
    if (script.status === 'archived' && !options.allowArchived) throw archived();
    if (script.revision !== expectedRevision) throw revisionConflict();
    return script;
  }

  private async insertVersion(
    scriptId: string,
    version: number,
    input: ContainerScriptVersionInput,
    onNewContainers: boolean,
    actorId: string,
    tx: Tx,
  ): Promise<void> {
    const versionId = randomUUID();
    await this.scripts.insertVersion({
      id: versionId,
      scriptId,
      version,
      script: input.script,
      scope: input.scope,
      onNewContainers,
      applyNow: input.applyNow,
      stoppedPolicy: input.stoppedPolicy,
      timeoutSeconds: input.timeoutSeconds,
      maxAttempts: input.maxAttempts,
      maxParallel: input.maxParallel,
      maxParallelPerServer: input.maxParallelPerServer,
      canaryCount: input.canaryCount,
      pauseAfterFailures: input.pauseAfterFailures,
      note: input.note,
      publishedBy: actorId,
    }, tx);
    const blobs = await this.assertFiles(input, tx);
    await this.scripts.insertFiles(versionId, input.files, new Map([...blobs].map(([sha, blob]) => [sha, blob.id])), tx);
  }

  /** Every file names uploaded content, and together they stay within the size limit. */
  private async assertFiles(input: ContainerScriptVersionInput, tx: Tx) {
    const blobs = await this.scripts.blobsFor(input.files.map((file) => file.sha256), tx);
    const missing = input.files.filter((file) => !blobs.has(file.sha256)).map((file) => file.name);
    if (missing.length > 0) {
      throw new BadRequestException({
        code: FailureCode.ContainerScriptBlobMissing,
        message: 'Upload the content of every file before publishing',
        details: { files: missing },
      });
    }
    const total = input.files.reduce((sum, file) => sum + (blobs.get(file.sha256)?.size ?? 0), 0);
    if (total > CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES) {
      throw new BadRequestException({
        code: FailureCode.ContainerScriptTooLarge,
        message: `The files of a version may total at most ${CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES} bytes`,
        details: { totalBytes: total, maxBytes: CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES },
      });
    }
    return blobs;
  }

  private async assertUnique(name: string, priority: number, excludeId: string | null, tx: Tx): Promise<void> {
    const existing = await this.scripts.findConflict(name, priority, excludeId, tx);
    if (!existing) return;
    throw conflict({
      field: existing.name === name ? 'name' : 'priority',
      conflictingScriptId: existing.id,
    });
  }
}
