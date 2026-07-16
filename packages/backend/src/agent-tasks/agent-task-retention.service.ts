import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  AgentTaskKind,
  AgentTaskStatus,
} from '@nyabase/common';
import { DataSource, In, type EntityManager } from 'typeorm';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';

export const AGENT_TASK_MIN_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MAX_AGENT_TASKS_PER_RETENTION_WINDOW = 16_384;
export const MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW = 4_096;
export const MAX_NON_SAFETY_AGENT_TASKS_PER_RETENTION_WINDOW = 8_192;
export const MAX_AGENT_TASK_ROWS_HARD = 262_144;

const RETENTION_INTERVAL_MS = 60_000;
const RETENTION_BATCH_SIZE = 256;
const MAX_RETENTION_SCAN_PER_PASS = 4_096;

interface RetentionCursor {
  completedAt: Date;
  id: string;
}

type RetentionCandidate = Pick<
  AgentTaskEntity,
  'id' | 'kind' | 'resourceId' | 'completedAt'
> & { cleanupGeneration: number | null };

/**
 * Deletes only operational history. Any row that can still authorize replay,
 * prove a current projection, or complete the current image cleanup generation
 * remains immutable regardless of age.
 */
@Injectable()
export class AgentTaskRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTaskRetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setImmediate> | null = null;
  private processing = false;
  private cursor: RetentionCursor | null = null;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.wake(), RETENTION_INTERVAL_MS);
    this.timer.unref?.();
    this.wake();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearImmediate(this.wakeTimer);
    this.timer = null;
    this.wakeTimer = null;
  }

  wake(): void {
    if (this.wakeTimer) return;
    this.wakeTimer = setImmediate(() => {
      this.wakeTimer = null;
      void this.process().catch((error) => {
        this.logger.warn(`Agent task retention scan failed: ${this.errorMessage(error)}`);
      });
    });
  }

  async process(now = new Date()): Promise<{ scanned: number; deleted: number }> {
    if (this.processing) return { scanned: 0, deleted: 0 };
    this.processing = true;
    try {
      const cutoff = new Date(now.getTime() - AGENT_TASK_MIN_RETENTION_MS);
      let scanned = 0;
      let deleted = 0;
      while (scanned < MAX_RETENTION_SCAN_PER_PASS) {
        const take = Math.min(RETENTION_BATCH_SIZE, MAX_RETENTION_SCAN_PER_PASS - scanned);
        const batch = await runSerializedTransaction(this.dataSource, (manager) =>
          this.pruneBatch(manager, cutoff, take, this.cursor));
        if (batch.scanned === 0) {
          this.cursor = null;
          break;
        }
        scanned += batch.scanned;
        deleted += batch.deleted;
        this.cursor = batch.cursor;
        if (batch.scanned < take) {
          this.cursor = null;
          break;
        }
      }
      return { scanned, deleted };
    } finally {
      this.processing = false;
    }
  }

  private async pruneBatch(
    manager: EntityManager,
    cutoff: Date,
    take: number,
    cursor: RetentionCursor | null,
  ): Promise<{ scanned: number; deleted: number; cursor: RetentionCursor | null }> {
    const query = manager.createQueryBuilder(AgentTaskEntity, 'task')
      .where('task.status IN (:...statuses)', {
        statuses: [AgentTaskStatus.Succeeded, AgentTaskStatus.Failed],
      })
      .andWhere('task.completed_at IS NOT NULL')
      .andWhere('task.completed_at <= :cutoff', { cutoff });
    if (cursor) {
      query.andWhere(
        '(task.completed_at > :cursorAt OR '
        + '(task.completed_at = :cursorAt AND task.id > :cursorId))',
        { cursorAt: cursor.completedAt, cursorId: cursor.id },
      );
    }
    const selected = await query
      // Keep the retention worker's memory independent of task payload and
      // outcome sizes. SQLite extracts the only request field needed by the
      // image cleanup-generation fence without returning requestJson itself.
      .select([
        'task.id',
        'task.kind',
        'task.resourceId',
        'task.completedAt',
      ])
      .addSelect(`CASE
        WHEN json_valid(task.request_json) = 1
        THEN json_extract(task.request_json, '$.cleanupGeneration')
        ELSE NULL
      END`, 'cleanupGeneration')
      .orderBy('task.completed_at', 'ASC')
      .addOrderBy('task.id', 'ASC')
      .take(take)
      .getRawAndEntities<{ cleanupGeneration: unknown }>();
    const candidates: RetentionCandidate[] = selected.entities.map((task, index) => ({
      id: task.id,
      kind: task.kind,
      resourceId: task.resourceId,
      completedAt: task.completedAt,
      cleanupGeneration: this.number(selected.raw[index]?.cleanupGeneration),
    }));
    if (candidates.length === 0) return { scanned: 0, deleted: 0, cursor: null };

    const ids = candidates.map((task) => task.id);
    const imageIds = [...new Set(candidates
      .filter((task) => task.kind === AgentTaskKind.ImageEnsureAbsent)
      .map((task) => task.resourceId))];
    const [
      locks,
      lifecycles,
      dataDirs,
      quotas,
      remoteMounts,
      remoteAssignments,
      deletingImages,
    ] = await Promise.all([
      manager.find(ResourceLockEntity, { where: { taskId: In(ids) } }),
      manager.find(ContainerLifecycleEntity, { where: { activeTaskId: In(ids) } }),
      manager.find(DataDirectoryEntity, { where: { lastTaskId: In(ids) } }),
      manager.find(QuotaDesiredEntity, { where: { lastTaskId: In(ids) } }),
      manager.find(RemoteFsMountEntity, { where: { lastTaskId: In(ids) } }),
      manager.find(RemoteFsServerAssignmentEntity, { where: { lastTaskId: In(ids) } }),
      imageIds.length === 0
        ? Promise.resolve([])
        : manager.find(ImageEntity, { where: { id: In(imageIds), deleting: true } }),
    ]);

    const protectedIds = new Set<string>([
      ...locks.map((row) => row.taskId),
      ...lifecycles.flatMap((row) => row.activeTaskId ? [row.activeTaskId] : []),
      ...dataDirs.flatMap((row) => row.lastTaskId ? [row.lastTaskId] : []),
      ...quotas.flatMap((row) => row.lastTaskId ? [row.lastTaskId] : []),
      ...remoteMounts.flatMap((row) => row.lastTaskId ? [row.lastTaskId] : []),
      ...remoteAssignments.flatMap((row) => row.lastTaskId ? [row.lastTaskId] : []),
    ]);
    const deletingImageById = new Map(deletingImages.map((row) => [row.id, row]));
    for (const task of candidates) {
      if (task.kind !== AgentTaskKind.ImageEnsureAbsent) continue;
      const image = deletingImageById.get(task.resourceId);
      if (!image) continue;
      // Malformed current cleanup evidence is retained conservatively. A valid
      // older generation cannot influence the current deletion decision.
      if (
        task.cleanupGeneration === null
        || task.cleanupGeneration === image.cleanupGeneration
      ) {
        protectedIds.add(task.id);
      }
    }

    const deletableIds = ids.filter((id) => !protectedIds.has(id));
    if (deletableIds.length > 0) {
      await manager.delete(AgentTaskEntity, { id: In(deletableIds) });
    }
    const last = candidates[candidates.length - 1]!;
    return {
      scanned: candidates.length,
      deleted: deletableIds.length,
      cursor: { completedAt: last.completedAt!, id: last.id },
    };
  }

  private number(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
