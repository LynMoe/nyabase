import { Inject, Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { sql, type Kysely } from 'kysely';
import type { HttpProxyBindingStatsDto, HttpProxyStatusReport } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import {
  HttpProxyLiveTraffic,
  countersByBinding,
  type BindingCounterValues,
} from './http-proxy-live-traffic.js';

/** Counters of one proxy instance are written at most this often while it reports. */
export const HTTP_PROXY_COUNTER_PERSIST_INTERVAL_MS = 10_000;
/** An idle instance still refreshes `last_seen_at` this often, so it is not archived. */
const IDLE_TOUCH_INTERVAL_MS = 10 * 60_000;
/** Instances silent for longer than this are folded into the 'archived' row. */
const ARCHIVE_AFTER = '1 day';
/** Archived instance markers are kept this long, then forgotten. */
const FORGET_ARCHIVED_AFTER = '30 days';
const ARCHIVE_CHECK_INTERVAL_MS = 60 * 60_000;
/**
 * After a Backend start every proxy gets this long to reconnect and report
 * before stale instances are archived, so an outage longer than a day cannot
 * archive an instance that is about to report again.
 */
const ARCHIVE_START_DELAY_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InstanceCounters {
  key: string;
  connections: Set<object>;
  latest: ReadonlyMap<string, BindingCounterValues>;
  /** What the last successful write stored; the rest is overlaid from `latest`. */
  persisted: Map<string, BindingCounterValues>;
  lastWriteAt: number;
  writing: boolean;
  archived: boolean;
  finalFlushDone: boolean;
}

function counterKey(report: HttpProxyStatusReport): string | null {
  return report.instanceId ? `${report.proxyId}:${report.instanceId}` : null;
}

function changedCounters(
  instance: InstanceCounters,
): Array<readonly [string, BindingCounterValues]> {
  return [...instance.latest]
    .filter(([id, values]) => UUID.test(id) && !sameCounters(instance.persisted.get(id), values));
}

function sameCounters(a: BindingCounterValues | undefined, b: BindingCounterValues): boolean {
  return a !== undefined
    && a.requests === b.requests
    && a.rxBytes === b.rxBytes
    && a.txBytes === b.txBytes;
}

/**
 * Per-binding HTTP traffic. Totals are the proxies' raw cumulative counters
 * stored per proxy instance (idempotent across reconnects and Backend
 * restarts) and summed per binding; the live values (active connections,
 * rates) come from the connected proxies' reports in memory only.
 */
@Injectable()
export class HttpProxyTrafficService {
  private readonly logger = new Logger(HttpProxyTrafficService.name);
  private readonly live = new HttpProxyLiveTraffic();
  private readonly instances = new Map<string, InstanceCounters>();
  private readonly connectionInstance = new Map<object, string>();
  private readonly startedAt = performance.now();
  private readonly pending = new Set<Promise<void>>();
  private lastArchiveCheckAt: number | null = null;
  private archiving = false;

  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  /** One status report from a connected proxy. */
  record(connection: object, report: HttpProxyStatusReport): void {
    const now = performance.now();
    const key = counterKey(report);
    const counters = countersByBinding(report.bindings);
    this.live.record(connection, key, counters, now);
    if (key === null) return;
    const previousKey = this.connectionInstance.get(connection);
    if (previousKey !== undefined && previousKey !== key) this.detach(connection);
    let instance = this.instances.get(key);
    if (!instance) {
      instance = {
        key,
        connections: new Set(),
        latest: counters,
        persisted: new Map(),
        lastWriteAt: Number.NEGATIVE_INFINITY,
        writing: false,
        archived: false,
        finalFlushDone: false,
      };
      this.instances.set(key, instance);
    }
    instance.connections.add(connection);
    instance.finalFlushDone = false;
    instance.latest = counters;
    this.connectionInstance.set(connection, key);
    if (now - instance.lastWriteAt >= HTTP_PROXY_COUNTER_PERSIST_INTERVAL_MS) {
      this.flush(instance, now);
    }
    this.maybeArchive(now);
  }

  /** The proxy disconnected: it stops counting live, its last counters are flushed. */
  forget(connection: object): void {
    this.live.forget(connection);
    this.detach(connection);
  }

  async statsFor(bindingIds: readonly string[]): Promise<Map<string, HttpProxyBindingStatsDto>> {
    const ids = [...new Set(bindingIds)];
    const result = new Map<string, HttpProxyBindingStatsDto>();
    if (ids.length === 0) return result;
    const rows = await this.database
      .selectFrom('interaction.http_proxy_binding_counters')
      .select((eb) => [
        'binding_id',
        eb.fn.sum<string>('requests').as('requests'),
        eb.fn.sum<string>('rx_bytes').as('rx_bytes'),
        eb.fn.sum<string>('tx_bytes').as('tx_bytes'),
      ])
      .where('binding_id', 'in', ids)
      .groupBy('binding_id')
      .execute();
    const stored = new Map(rows.map((row) => [row.binding_id, row]));
    const live = this.live.live(ids, performance.now());
    for (const id of ids) {
      const row = stored.get(id);
      const unpersisted = this.unpersisted(id);
      const current = live.get(id)!;
      result.set(id, {
        totalRequests: safeSum(row?.requests, unpersisted.requests),
        activeConnections: current.activeConnections,
        rxBytesPerSec: current.rxBytesPerSec,
        txBytesPerSec: current.txBytesPerSec,
        totalRxBytes: safeSum(row?.rx_bytes, unpersisted.rxBytes),
        totalTxBytes: safeSum(row?.tx_bytes, unpersisted.txBytes),
      });
    }
    return result;
  }

  /** Waits for in-flight writes (tests). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private detach(connection: object): void {
    const key = this.connectionInstance.get(connection);
    this.connectionInstance.delete(connection);
    if (key === undefined) return;
    const instance = this.instances.get(key);
    if (!instance) return;
    instance.connections.delete(connection);
    if (instance.connections.size === 0) this.flush(instance, performance.now());
  }

  /** Counts reported but not yet stored, for instances whose rows this process wrote. */
  private unpersisted(bindingId: string): BindingCounterValues {
    const total = { requests: 0, activeConnections: 0, rxBytes: 0, txBytes: 0 };
    for (const instance of this.instances.values()) {
      if (instance.archived) continue;
      const persisted = instance.persisted.get(bindingId);
      const latest = instance.latest.get(bindingId);
      if (!persisted || !latest) continue;
      total.requests += Math.max(0, latest.requests - persisted.requests);
      total.rxBytes += Math.max(0, latest.rxBytes - persisted.rxBytes);
      total.txBytes += Math.max(0, latest.txBytes - persisted.txBytes);
    }
    return total;
  }

  /**
   * Writes the instance's changed counters, at most one write in flight per
   * instance. Once the instance has no connection left, one final write
   * stores what arrived last and the instance is dropped from memory.
   */
  private flush(instance: InstanceCounters, now: number): void {
    if (instance.writing) return; // the running write calls back when it ends
    const detached = instance.connections.size === 0;
    const changed = instance.archived ? [] : changedCounters(instance);
    const touchDue = !detached && !instance.archived
      && now - instance.lastWriteAt >= IDLE_TOUCH_INTERVAL_MS;
    if ((changed.length === 0 && !touchDue) || (detached && instance.finalFlushDone)) {
      if (detached && this.instances.get(instance.key) === instance) {
        this.instances.delete(instance.key);
      }
      return;
    }
    if (detached) instance.finalFlushDone = true;
    instance.writing = true;
    instance.lastWriteAt = now;
    const write = this.write(instance.key, changed)
      .then((live) => {
        if (!live) instance.archived = true;
        else for (const [id, values] of changed) instance.persisted.set(id, values);
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `HTTP proxy traffic counters for ${instance.key} were not stored: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        instance.writing = false;
        this.pending.delete(write);
        if (instance.connections.size === 0) this.flush(instance, performance.now());
      });
    this.pending.add(write);
  }

  /**
   * Upserts raw cumulative counters; `GREATEST` keeps the write idempotent
   * and safe against an overlapping write from a reconnect. Returns false
   * when the instance was archived (its counts already folded): it is never
   * counted again.
   */
  private async write(
    key: string,
    changed: ReadonlyArray<readonly [string, BindingCounterValues]>,
  ): Promise<boolean> {
    const ids = changed.map(([id]) => id);
    const requests = changed.map(([, values]) => values.requests);
    const rxBytes = changed.map(([, values]) => values.rxBytes);
    const txBytes = changed.map(([, values]) => values.txBytes);
    const result = await sql<{ live: boolean }>`
      WITH instance AS (
        INSERT INTO interaction.http_proxy_counter_instances AS i (proxy_instance, last_seen_at)
        VALUES (${key}, clock_timestamp())
        ON CONFLICT (proxy_instance) DO UPDATE
          SET last_seen_at = excluded.last_seen_at
          WHERE i.archived_at IS NULL
        RETURNING proxy_instance
      ), incoming AS (
        SELECT *
        FROM unnest(
          ${ids}::uuid[], ${requests}::bigint[], ${rxBytes}::bigint[], ${txBytes}::bigint[]
        ) AS v(binding_id, requests, rx_bytes, tx_bytes)
      ), written AS (
        INSERT INTO interaction.http_proxy_binding_counters AS c
          (proxy_instance, binding_id, requests, rx_bytes, tx_bytes, updated_at)
        SELECT instance.proxy_instance, v.binding_id, v.requests, v.rx_bytes, v.tx_bytes,
          clock_timestamp()
        FROM instance
        CROSS JOIN incoming v
        JOIN interaction.http_proxy_bindings b ON b.id = v.binding_id
        ON CONFLICT (proxy_instance, binding_id) DO UPDATE SET
          requests = GREATEST(c.requests, excluded.requests),
          rx_bytes = GREATEST(c.rx_bytes, excluded.rx_bytes),
          tx_bytes = GREATEST(c.tx_bytes, excluded.tx_bytes),
          updated_at = excluded.updated_at
        RETURNING 1
      )
      SELECT EXISTS (SELECT 1 FROM instance) AS live
    `.execute(this.database);
    return result.rows[0]?.live === true;
  }

  private maybeArchive(now: number): void {
    if (this.archiving || now - this.startedAt < ARCHIVE_START_DELAY_MS) return;
    if (this.lastArchiveCheckAt !== null && now - this.lastArchiveCheckAt < ARCHIVE_CHECK_INTERVAL_MS) {
      return;
    }
    this.lastArchiveCheckAt = now;
    this.archiving = true;
    const archive: Promise<void> = this.archiveStaleInstances([...this.instances.keys()])
      .catch((error: unknown) => {
        this.logger.warn(
          `Archiving stale HTTP proxy traffic counters failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.archiving = false;
        this.pending.delete(archive);
      });
    this.pending.add(archive);
  }

  /**
   * Folds the rows of every instance silent for a day (and not connected
   * now) into one 'archived' row per binding, in one statement, and forgets
   * archive markers after 30 days.
   */
  async archiveStaleInstances(connectedKeys: readonly string[]): Promise<void> {
    await sql`
      WITH retired AS (
        UPDATE interaction.http_proxy_counter_instances
        SET archived_at = clock_timestamp()
        WHERE archived_at IS NULL
          AND last_seen_at < clock_timestamp() - ${ARCHIVE_AFTER}::interval
          AND NOT (proxy_instance = ANY(${[...connectedKeys]}::text[]))
        RETURNING proxy_instance
      ), moved AS (
        DELETE FROM interaction.http_proxy_binding_counters c
        USING retired
        WHERE c.proxy_instance = retired.proxy_instance
        RETURNING c.binding_id, c.requests, c.rx_bytes, c.tx_bytes
      )
      INSERT INTO interaction.http_proxy_binding_counters AS a
        (proxy_instance, binding_id, requests, rx_bytes, tx_bytes, updated_at)
      SELECT 'archived', binding_id, sum(requests), sum(rx_bytes), sum(tx_bytes), clock_timestamp()
      FROM moved
      GROUP BY binding_id
      ON CONFLICT (proxy_instance, binding_id) DO UPDATE SET
        requests = a.requests + excluded.requests,
        rx_bytes = a.rx_bytes + excluded.rx_bytes,
        tx_bytes = a.tx_bytes + excluded.tx_bytes,
        updated_at = excluded.updated_at
    `.execute(this.database);
    await this.database
      .deleteFrom('interaction.http_proxy_counter_instances')
      .where('archived_at', '<', sql<Date>`clock_timestamp() - ${FORGET_ARCHIVED_AFTER}::interval`)
      .execute();
  }
}

function safeSum(stored: string | undefined, unpersisted: number): number {
  const total = Number(stored ?? 0) + unpersisted;
  return Number.isFinite(total) ? Math.min(total, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
}
