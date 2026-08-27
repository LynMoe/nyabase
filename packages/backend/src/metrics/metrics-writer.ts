import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  MAX_METRIC_LABEL_KEY_LENGTH,
  MAX_METRIC_LABELS_PER_POINT,
  MAX_METRIC_NAME_LENGTH,
  MAX_METRIC_LABEL_VALUE_LENGTH,
  MAX_METRIC_POINTS_PER_BATCH,
  MAX_NODE_METRICS_BODY_BYTES,
  NODE_METRIC_NAMES,
  validateNodeMetricSample,
} from '@nyabase/common';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';

export interface MetricPoint {
  name: string;
  labels: Readonly<Record<string, string>>;
  value: number;
  ts: number;
}

export interface MetricsWriteOptions {
  readonly guard?: () => Promise<boolean>;
}

interface QueuedBatch {
  serverId: string;
  points: MetricPoint[];
  estimatedBytes: number;
  guard?: () => Promise<boolean>;
}

interface FlushOperation {
  readonly batch: QueuedBatch[];
  readonly controller: AbortController;
  promise: Promise<void>;
  droppedBatches: number;
  countedAsDropped: boolean;
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
const MAX_QUEUED_BYTES = MAX_NODE_METRICS_BODY_BYTES * 2;
const MAX_FLUSH_POINTS = MAX_METRIC_POINTS_PER_BATCH * 2;
const MAX_FLUSH_BYTES = MAX_NODE_METRICS_BODY_BYTES;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_FLUSH_SIZE = 64;
const FLUSH_REQUEST_TIMEOUT_MS = 2_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

@Injectable()
export class MetricsWriter implements OnModuleDestroy {
  private readonly logger = new Logger(MetricsWriter.name);
  private readonly vmUrl: string;
  private readonly queue: QueuedBatch[] = [];
  private readonly queueLimit = DEFAULT_QUEUE_LIMIT;
  private dropped = 0;
  private queuedPoints = 0;
  private queuedBytes = 0;
  private inFlight = 0;
  private lastFlushAt: number | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private activeFlush: FlushOperation | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    config: NyabaseConfigService,
    runtimeRole?: RuntimeRoleService,
  ) {
    this.vmUrl = config.get<string>('metrics.vmagentUrl');
    if (!runtimeRole || runtimeRole.servesProxySockets()) {
      this.timer = setInterval(() => {
        void this.flush();
      }, DEFAULT_FLUSH_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  async writeBatch(
    serverId: string,
    points: MetricPoint[],
    options: MetricsWriteOptions = {},
  ): Promise<void> {
    if (this.shuttingDown || points.length === 0) return;
    if (points.length > MAX_METRIC_POINTS_PER_BATCH
      || points.some((point) => !validPoint(point))) {
      this.dropped += 1;
      return;
    }
    if (options.guard && !(await this.evaluateGuard(options.guard))) {
      this.dropped += 1;
      return;
    }
    if (this.shuttingDown) return;
    const normalized = points.map((point) => ({
      ...point,
      labels: { ...point.labels, server_id: serverId },
    }));
    const estimatedBytes = Buffer.byteLength(JSON.stringify({ serverId, points: normalized }));
    if (estimatedBytes > MAX_NODE_METRICS_BODY_BYTES) {
      this.dropped += 1;
      return;
    }
    while (
      this.queue.length >= this.queueLimit
      || this.queuedPoints + normalized.length > MAX_QUEUED_POINTS
      || this.queuedBytes + estimatedBytes > MAX_QUEUED_BYTES
    ) {
      const removed = this.queue.shift();
      if (!removed) break;
      this.dropped += 1;
      this.queuedPoints -= removed.points.length;
      this.queuedBytes -= removed.estimatedBytes;
    }
    this.queue.push({
      serverId,
      points: normalized,
      estimatedBytes,
      guard: options.guard,
    });
    this.queuedPoints += normalized.length;
    this.queuedBytes += estimatedBytes;
    await this.flush();
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
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.shutdownPromise = this.drain();
    return this.shutdownPromise;
  }

  private flush(): Promise<void> {
    if (this.activeFlush) return this.activeFlush.promise;
    const batch = this.takeBatch();
    if (!batch) return Promise.resolve();
    const operation: FlushOperation = {
      batch,
      controller: new AbortController(),
      droppedBatches: 0,
      countedAsDropped: false,
      promise: Promise.resolve(),
    };
    this.activeFlush = operation;
    this.inFlight = 1;
    operation.promise = Promise.resolve()
      .then(() => this.flushOne(operation))
      .finally(() => this.finishFlush(operation));
    return operation.promise;
  }

  private async drain(): Promise<void> {
    const deadline = performance.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
    while (this.queue.length > 0 || this.activeFlush) {
      const promise = this.activeFlush?.promise ?? this.flush();
      const remaining = deadline - performance.now();
      if (remaining <= 0 || !(await this.waitFor(promise, remaining))) {
        this.markDrainTimeout();
        return;
      }
    }
  }

  private takeBatch(): QueuedBatch[] | null {
    if (this.queue.length === 0) return null;
    const result: QueuedBatch[] = [];
    let points = 0;
    let bytes = 0;
    while (
      result.length < DEFAULT_BATCH_FLUSH_SIZE
      && this.queue.length > 0
    ) {
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

  private async flushOne(operation: FlushOperation): Promise<void> {
    const batches: QueuedBatch[] = [];
    for (const batch of operation.batch) {
      if (
        batch.guard
        && !(await this.evaluateGuard(batch.guard))
      ) {
        operation.droppedBatches += 1;
        if (!operation.countedAsDropped) this.dropped += 1;
        continue;
      }
      batches.push(batch);
    }
    if (batches.length === 0) return;

    const lines: string[] = [];
    for (const batch of batches) {
      for (const point of batch.points) {
        const labels = Object.entries(point.labels)
          .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
          .join(',');
        lines.push(`${point.name}{${labels}} ${point.value} ${point.ts}`);
      }
    }
    if (lines.length === 0) return;

    const body = lines.join('\n');
    const requestTimeout = AbortSignal.timeout(FLUSH_REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([operation.controller.signal, requestTimeout]);
    try {
      const response = await fetch(`${this.vmUrl}/api/v1/import/prometheus`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body,
        signal,
      });
      if (!response.ok) {
        throw new Error(`metrics endpoint returned ${response.status}`);
      }
      if (!operation.countedAsDropped) this.lastError = null;
    } catch (error) {
      if (operation.countedAsDropped) return;
      operation.droppedBatches += batches.length;
      this.dropped += batches.length;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Metrics flush failed: ${this.lastError}`);
    } finally {
      this.lastFlushAt = Date.now();
    }
  }

  private finishFlush(operation: FlushOperation): void {
    if (this.activeFlush !== operation) return;
    this.activeFlush = null;
    this.inFlight = 0;
    if (!this.shuttingDown && this.queue.length > 0) {
      void this.flush();
    }
  }

  private async evaluateGuard(guard: () => Promise<boolean>): Promise<boolean> {
    try {
      return await guard();
    } catch (error) {
      this.logger.warn(
        `Metrics configuration guard failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([
      promise.then(() => true, () => true),
      timeout,
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return result;
  }

  private markDrainTimeout(): void {
    const queued = this.queue.length;
    if (queued > 0) {
      this.dropped += queued;
      this.queue.length = 0;
      this.queuedPoints = 0;
      this.queuedBytes = 0;
    }
    const active = this.activeFlush;
    if (active && !active.countedAsDropped) {
      const remaining = active.batch.length - active.droppedBatches;
      if (remaining > 0) this.dropped += remaining;
      active.countedAsDropped = true;
      active.controller.abort();
    }
    this.lastError =
      `Metrics shutdown drain timed out with ${queued} queued batches`;
    this.logger.warn(this.lastError);
  }
}

function validPoint(point: MetricPoint): boolean {
  if (
    point.name !== 'nyabase_node_scrape_up'
    && !(NODE_METRIC_NAMES as readonly string[]).includes(point.name)
  ) return false;
  if (
    point.name === 'nyabase_node_scrape_up'
    && Object.keys(point.labels).length !== 0
  ) return false;
  if (point.name !== 'nyabase_node_scrape_up') {
    try {
      validateNodeMetricSample({
        name: point.name as (typeof NODE_METRIC_NAMES)[number],
        labels: point.labels,
        value: point.value,
      });
    } catch {
      return false;
    }
  }
  return point.name.length > 0
    && point.name.length <= MAX_METRIC_NAME_LENGTH
    && Number.isFinite(point.value)
    && Number.isFinite(point.ts)
    && Object.keys(point.labels).length <= MAX_METRIC_LABELS_PER_POINT
    && Object.entries(point.labels).every(([key, value]) =>
      key.length > 0
      && key.length <= MAX_METRIC_LABEL_KEY_LENGTH
      && value.length <= MAX_METRIC_LABEL_VALUE_LENGTH,
    );
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}
