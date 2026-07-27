import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  MAX_AGENT_WS_FRAME_BYTES,
  MAX_METRIC_POINTS_PER_BATCH,
  zMetricPoint,
  type MetricPoint,
} from '@nyabase/common';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';

/** A single batch enqueued by an agent. */
interface QueuedBatch {
  serverId: string;
  points: MetricPoint[];
  estimatedBytes: number;
}

export interface MetricsWriterStats {
  queued: number;
  queuedPoints: number;
  queuedBytes: number;
  dropped: number;
  inFlight: number;
  lastFlushAt: number | null;
  lastError: string | null;
}

const DEFAULT_QUEUE_LIMIT = 1_024;
const MAX_QUEUED_POINTS = MAX_METRIC_POINTS_PER_BATCH * 4;
const MAX_QUEUED_BYTES = MAX_AGENT_WS_FRAME_BYTES * 2;
const MAX_FLUSH_POINTS = MAX_METRIC_POINTS_PER_BATCH * 2;
const MAX_FLUSH_BYTES = MAX_AGENT_WS_FRAME_BYTES;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CONCURRENT_FLUSHES = 1;
const DEFAULT_BATCH_FLUSH_SIZE = 64;
const INITIAL_FAILURE_BACKOFF_MS = 10_000;
const MAX_FAILURE_BACKOFF_MS = 60_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

/**
 * MetricsWriter buffers samples in-memory and flushes them to vmagent
 * in batches. Backpressure semantics:
 *   - When the queue grows beyond `queueLimit`, we drop the OLDEST batches
 *     (so live metrics keep flowing) and increment `dropped`.
 *   - The flush loop runs on a fixed interval AND is triggered on every
 *     enqueue, with `maxConcurrentFlushes` cap.
 *   - A failed vmagent request opens a bounded exponential backoff. This is
 *     also a DNS-isolation boundary: aborting fetch does not necessarily
 *     cancel an in-flight getaddrinfo worker for an unavailable hostname.
 *   - On shutdown the queue is drained synchronously up to a deadline.
 *
 * No durable application retry queue exists here: vmagent owns persistence and
 * retry. This process-local queue is deliberately bounded and lossy.
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
  private queuedPoints = 0;
  private queuedBytes = 0;
  private inFlight = 0;
  private lastFlushAt: number | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;
  private retryNotBeforeMonotonic = 0;
  private shuttingDown = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private monotonicNowMs = (): number => performance.now();

  constructor(
    private config: NyabaseConfigService,
    runtimeRole?: RuntimeRoleService,
  ) {
    this.vmUrl = config.get<string>('metrics.vmagentUrl');
    if (!runtimeRole || runtimeRole.servesGateway()) {
      this.flushTimer = setInterval(() => {
        void this.flushLoop();
      }, this.flushIntervalMs);
      // Don't keep the event loop alive only for metrics flushes.
      this.flushTimer.unref?.();
    }
  }

  /**
   * Normalize identity labels and enqueue a batch of metric points. The actual
   * VictoriaMetrics write happens in the background flush loop.
   */
  async writeBatch(serverId: string, points: MetricPoint[]): Promise<void> {
    if (points.length === 0 || this.shuttingDown) return;
    if (points.length > MAX_METRIC_POINTS_PER_BATCH) {
      this.dropped += 1;
      this.logger.warn(
        `Rejected metrics batch with ${points.length} points; maximum is `
        + `${MAX_METRIC_POINTS_PER_BATCH}`,
      );
      return;
    }

    points = points.map((point) => ({
      ...point,
      labels: { ...point.labels, server: serverId },
    }));
    if (points.some((point) => !zMetricPoint.safeParse(point).success)) {
      this.dropped += 1;
      this.logger.warn('Rejected metrics batch outside the bounded metric name/label contract');
      return;
    }

    const estimatedBytes = Buffer.byteLength(JSON.stringify({ serverId, points }));
    if (estimatedBytes > MAX_FLUSH_BYTES) {
      this.dropped += 1;
      this.logger.warn(
        `Rejected metrics batch of ${estimatedBytes} bytes; queue byte limit is `
        + `${MAX_FLUSH_BYTES}`,
      );
      return;
    }

    while (
      this.queue.length > 0
      && (this.queue.length >= this.queueLimit
        || this.queuedPoints + points.length > MAX_QUEUED_POINTS
        || this.queuedBytes + estimatedBytes > MAX_QUEUED_BYTES)
    ) {
      // Drop the oldest batch to make room. We log at warn the first time per
      // contiguous burst so we don't spam logs when the upstream is wedged.
      const droppedBatch = this.queue.shift();
      this.dropped += 1;
      if (droppedBatch) {
        this.queuedPoints -= droppedBatch.points.length;
        this.queuedBytes -= droppedBatch.estimatedBytes;
        this.logger.warn(
          `Metrics queue full (limit=${this.queueLimit}); dropped 1 batch ` +
            `(${droppedBatch.points.length} points from server ${droppedBatch.serverId}). ` +
            `total dropped=${this.dropped}`,
        );
      }
    }

    this.queue.push({ serverId, points, estimatedBytes });
    this.queuedPoints += points.length;
    this.queuedBytes += estimatedBytes;

    // Trigger an immediate flush if we have capacity. The interval timer is a
    // safety net for the steady-state case.
    void this.flushLoop();
  }

  getStats(): MetricsWriterStats {
    return {
      queued: this.queue.length,
      queuedPoints: this.queuedPoints,
      queuedBytes: this.queuedBytes,
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

    const deadline = this.monotonicNowMs() + SHUTDOWN_DRAIN_TIMEOUT_MS;
    while (
      (this.queue.length > 0 || this.inFlight > 0)
      && this.monotonicNowMs() < deadline
    ) {
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
    if (this.monotonicNowMs() < this.retryNotBeforeMonotonic) return;
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

  /**
   * Coalesce up to `batchFlushSize` queued batches into a single HTTP request.
   * Different `serverId`s are flushed together; the per-point label encodes
   * the server already.
   */
  private takeBatch(): QueuedBatch[] | null {
    if (this.queue.length === 0) return null;
    const result: QueuedBatch[] = [];
    let points = 0;
    let bytes = 0;
    while (result.length < this.batchFlushSize && this.queue.length > 0) {
      const next = this.queue[0];
      if (
        result.length > 0
        && (points + next.points.length > MAX_FLUSH_POINTS
          || bytes + next.estimatedBytes > MAX_FLUSH_BYTES)
      ) break;
      this.queue.shift();
      result.push(next);
      points += next.points.length;
      bytes += next.estimatedBytes;
      this.queuedPoints -= next.points.length;
      this.queuedBytes -= next.estimatedBytes;
    }
    return result;
  }

  private async flushOne(batches: QueuedBatch[]): Promise<void> {
    const lines: string[] = [];
    for (const batch of batches) {
      for (const p of batch.points) {
        const labelParts = Object.entries({ ...p.labels, server: batch.serverId })
          .map(([k, v]) => `${k}="${escapePrometheusLabelValue(v)}"`)
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
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        const msg = `vmagent write failed: ${res.status} ${text}`;
        this.dropped += batches.length;
        this.recordFailure(msg);
        this.logger.warn(msg);
      } else {
        this.consecutiveFailures = 0;
        this.retryNotBeforeMonotonic = 0;
        this.lastError = null;
      }
    } catch (err) {
      const msg = `vmagent write error: ${err}`;
      this.dropped += batches.length;
      this.recordFailure(msg);
      this.logger.error(msg);
    } finally {
      this.lastFlushAt = Date.now();
    }
  }

  private recordFailure(message: string): void {
    const multiplier = 2 ** Math.min(this.consecutiveFailures, 3);
    const backoffMs = Math.min(
      INITIAL_FAILURE_BACKOFF_MS * multiplier,
      MAX_FAILURE_BACKOFF_MS,
    );
    this.consecutiveFailures += 1;
    this.retryNotBeforeMonotonic = this.monotonicNowMs() + backoffMs;
    this.lastError = message;
  }
}

function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
