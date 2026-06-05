import { Inject, Injectable, Logger, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricPoint } from '@nyabase/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ContainerEntity } from '../entities/container.entity.js';
import { UsersService } from '../users/users.service.js';

/** A single batch enqueued by an agent. */
interface QueuedBatch {
  serverId: string;
  points: MetricPoint[];
}

export interface MetricsWriterStats {
  queued: number;
  dropped: number;
  inFlight: number;
  lastFlushAt: number | null;
  lastError: string | null;
}

const DEFAULT_QUEUE_LIMIT = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CONCURRENT_FLUSHES = 1;
const DEFAULT_BATCH_FLUSH_SIZE = 64;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

/**
 * MetricsWriter buffers samples in-memory and flushes them to VictoriaMetrics
 * in batches. Backpressure semantics:
 *   - When the queue grows beyond `queueLimit`, we drop the OLDEST batches
 *     (so live metrics keep flowing) and increment `dropped`.
 *   - The flush loop runs on a fixed interval AND is triggered on every
 *     enqueue, with `maxConcurrentFlushes` cap.
 *   - On shutdown the queue is drained synchronously up to a deadline.
 *
 * No external dependencies (queue is a plain array bounded by `queueLimit`).
 */
@Injectable()
export class MetricsWriter implements OnModuleDestroy {
  private readonly logger = new Logger(MetricsWriter.name);
  private readonly vmUrl: string;

  private readonly queue: QueuedBatch[] = [];
  private readonly queueLimit = DEFAULT_QUEUE_LIMIT;
  private readonly flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
  private readonly maxConcurrentFlushes = DEFAULT_MAX_CONCURRENT_FLUSHES;
  private readonly batchFlushSize = DEFAULT_BATCH_FLUSH_SIZE;

  private dropped = 0;
  private inFlight = 0;
  private lastFlushAt: number | null = null;
  private lastError: string | null = null;
  private shuttingDown = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private config: ConfigService,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
  ) {
    this.vmUrl = config.get<string>('app.victoriaMetricsUrl', 'http://victoriametrics:8428');
    this.flushTimer = setInterval(() => {
      void this.flushLoop();
    }, this.flushIntervalMs);
    // Don't keep the event loop alive only for metrics flushes.
    this.flushTimer.unref?.();
  }

  /**
   * Normalize identity labels and enqueue a batch of metric points. The actual
   * VictoriaMetrics write happens in the background flush loop.
   */
  async writeBatch(serverId: string, points: MetricPoint[]): Promise<void> {
    if (points.length === 0 || this.shuttingDown) return;

    points = await this.normalizeIdentityLabels(serverId, points);

    if (this.queue.length >= this.queueLimit) {
      // Drop the oldest batch to make room. We log at warn the first time per
      // contiguous burst so we don't spam logs when the upstream is wedged.
      const droppedBatch = this.queue.shift();
      this.dropped += 1;
      if (droppedBatch) {
        this.logger.warn(
          `Metrics queue full (limit=${this.queueLimit}); dropped 1 batch ` +
            `(${droppedBatch.points.length} points from server ${droppedBatch.serverId}). ` +
            `total dropped=${this.dropped}`,
        );
      }
    }

    this.queue.push({ serverId, points });

    // Trigger an immediate flush if we have capacity. The interval timer is a
    // safety net for the steady-state case.
    void this.flushLoop();
  }

  getStats(): MetricsWriterStats {
    return {
      queued: this.queue.length,
      dropped: this.dropped,
      inFlight: this.inFlight,
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
    while ((this.queue.length > 0 || this.inFlight > 0) && Date.now() < deadline) {
      await this.flushLoop();
      if (this.queue.length === 0 && this.inFlight === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.queue.length > 0) {
      this.logger.warn(
        `Shutdown drain timed out with ${this.queue.length} batches still queued`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async flushLoop(): Promise<void> {
    while (
      this.queue.length > 0 &&
      this.inFlight < this.maxConcurrentFlushes
    ) {
      const batch = this.takeBatch();
      if (!batch) return;
      this.inFlight += 1;
      void this.flushOne(batch).finally(() => {
        this.inFlight -= 1;
      });
    }
  }

  private async normalizeIdentityLabels(serverId: string, points: MetricPoint[]): Promise<MetricPoint[]> {
    const numericUserIds = new Set<number>();
    const containerIds = new Set<string>();

    for (const point of points) {
      const userId = point.labels.user_id?.trim();
      if (userId && /^\d+$/.test(userId)) numericUserIds.add(Number(userId));
      const containerId = point.labels.container_id?.trim();
      const containerName = point.labels.container_name?.trim();
      if (!userId) {
        if (containerId) containerIds.add(containerId);
        if (containerName) containerIds.add(containerName);
      }
    }

    const userIdByNumericId = numericUserIds.size > 0
      ? await this.usersService.getUserIdsByNumericIds([...numericUserIds])
      : new Map<number, string>();
    const ownerByContainerId = containerIds.size > 0
      ? await this.resolveOwnersByRuntimeIds(serverId, [...containerIds])
      : new Map<string, string>();

    return points.map((point) => {
      const userId = point.labels.user_id?.trim();
      let normalizedUserId: string | undefined = userId;
      if (userId && /^\d+$/.test(userId)) {
        normalizedUserId = userIdByNumericId.get(Number(userId)) ?? userId;
      }
      if (!normalizedUserId) {
        const containerId = point.labels.container_id?.trim();
        const containerName = point.labels.container_name?.trim();
        normalizedUserId =
          (containerId ? ownerByContainerId.get(containerId) : undefined) ??
          (containerName ? ownerByContainerId.get(containerName) : undefined);
      }
      if (!normalizedUserId || normalizedUserId === point.labels.user_id) return point;
      return { ...point, labels: { ...point.labels, user_id: normalizedUserId } };
    });
  }

  private async resolveOwnersByRuntimeIds(serverId: string, containerIds: string[]): Promise<Map<string, string>> {
    const containers = containerIds.length > 0
      ? await this.containersRepo.findBy({ id: In(containerIds) })
      : [];
    const result = new Map<string, string>();

    for (const container of containers) {
      result.set(container.id, container.ownerId);
    }
    return result;
  }

  /**
   * Coalesce up to `batchFlushSize` queued batches into a single HTTP request.
   * Different `serverId`s are flushed together; the per-point label encodes
   * the server already.
   */
  private takeBatch(): QueuedBatch[] | null {
    if (this.queue.length === 0) return null;
    const take = Math.min(this.queue.length, this.batchFlushSize);
    return this.queue.splice(0, take);
  }

  private async flushOne(batches: QueuedBatch[]): Promise<void> {
    const lines: string[] = [];
    for (const batch of batches) {
      for (const p of batch.points) {
        const labelParts = Object.entries({ ...p.labels, server: batch.serverId })
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        const labelStr = labelParts ? `{${labelParts}}` : '';
        lines.push(`${p.name}${labelStr} ${p.value} ${p.ts}`);
      }
    }
    if (lines.length === 0) return;

    const body = lines.join('\n');
    try {
      const res = await fetch(`${this.vmUrl}/api/v1/import/prometheus`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        const msg = `VM write failed: ${res.status} ${text}`;
        this.lastError = msg;
        this.logger.warn(msg);
      } else {
        this.lastError = null;
      }
    } catch (err) {
      const msg = `VM write error: ${err}`;
      this.lastError = msg;
      this.logger.error(msg);
    } finally {
      this.lastFlushAt = Date.now();
    }
  }
}
