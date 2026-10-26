import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { zSshProxyHistoryFrame, type SshProxyStatusReport } from '@nyabase/common';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { historyInstanceKey, parseHistoryRecords } from './ssh-history-records.js';
import { SshHistoryRepository, type LiveConnectionCounters } from './ssh-history.repository.js';

/** Byte counts of live connections are stored at most this often per proxy instance. */
export const SSH_HISTORY_CHECKPOINT_INTERVAL_MS = 30_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;
/**
 * After a Backend start every proxy gets this long to reconnect before the
 * open connections of instances that stopped reporting are closed as lost.
 */
const SWEEP_START_DELAY_MS = 10 * 60_000;
const RETENTION_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

interface ProxyLink {
  /** History frames and checkpoints of one link are stored strictly in order. */
  chain: Promise<void>;
  instance: string | null;
  /**
   * Set when a frame failed to store: later frames are neither stored nor
   * acknowledged (the acknowledgement is cumulative) until the proxy sends
   * the failed records again, which it does when acks stop arriving.
   */
  resendFrom: number | null;
}

/**
 * Stores the SSH proxies' connection history. A frame is acknowledged only
 * after it committed, so the proxy keeps (and resends) what was not stored.
 */
@Injectable()
export class SshHistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SshHistoryService.name);
  private readonly links = new Map<object, ProxyLink>();
  private readonly lastCheckpointAt = new Map<string, number>();
  private readonly startedAt = performance.now();
  private lastRetentionAt = Number.NEGATIVE_INFINITY;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(
    private readonly repository: SshHistoryRepository,
    private readonly config: NyabaseConfigService,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Stores one `history` frame after the link's earlier frames. Resolves to
   * the sequence number to acknowledge, or null when nothing may be.
   */
  ingest(connection: object, payload: unknown): Promise<number | null> {
    const frame = zSshProxyHistoryFrame.safeParse(payload);
    if (!frame.success) {
      this.logger.warn('Invalid SSH proxy history frame');
      return Promise.resolve(null);
    }
    const { proxyId, instanceId, records } = frame.data;
    const instance = historyInstanceKey(proxyId, instanceId);
    const link = this.link(connection);
    link.instance = instance;
    const batch = parseHistoryRecords(records);
    if (batch.skipped > 0) {
      this.logger.warn(`Skipped ${batch.skipped} invalid SSH proxy history record(s) from ${instance}`);
    }
    return this.enqueue(link, async () => {
      if (link.resendFrom !== null) {
        if (batch.firstSeq > link.resendFrom) return null;
        link.resendFrom = null;
      }
      try {
        await this.repository.store(instance, proxyId, batch);
        return batch.lastSeq;
      } catch (error) {
        link.resendFrom = batch.firstSeq;
        this.logger.warn(
          `SSH proxy history from ${instance} was not stored (the proxy sends it again): `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    });
  }

  /** Stores the byte counts of live connections from a status report. */
  checkpoint(connection: object, status: SshProxyStatusReport): void {
    if (!status.instanceId) return;
    const instance = historyInstanceKey(status.proxyId, status.instanceId);
    const link = this.link(connection);
    link.instance = instance;
    const now = performance.now();
    if (now - (this.lastCheckpointAt.get(instance) ?? Number.NEGATIVE_INFINITY)
      < SSH_HISTORY_CHECKPOINT_INTERVAL_MS) {
      return;
    }
    this.lastCheckpointAt.set(instance, now);
    const live: LiveConnectionCounters[] = status.connections
      .filter((entry) => entry.seq !== undefined && entry.authenticatedAt !== null)
      .map((entry) => ({
        connectionSeq: entry.seq!,
        bytesFromClient: entry.bytesFromClient,
        bytesToClient: entry.bytesToClient,
        channels: (entry.bridges ?? []).map((bridge) => ({
          channelSeq: bridge.channelSeq,
          bytesFromClient: bridge.bytesFromClient,
          bytesToClient: bridge.bytesToClient,
        })),
      }));
    const complete = status.omittedConnections === 0 && status.historyBacklog === 0;
    void this.enqueue(link, async () => {
      try {
        await this.repository.checkpoint(instance, live, complete);
      } catch (error) {
        this.logger.warn(
          `SSH connection byte counts from ${instance} were not stored: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    });
  }

  /** The proxy link closed. Its queued writes still finish. */
  forget(connection: object): void {
    const link = this.links.get(connection);
    this.links.delete(connection);
    if (link?.instance && ![...this.links.values()].some((other) => other.instance === link.instance)) {
      this.lastCheckpointAt.delete(link.instance);
    }
  }

  /** Closes lost connections and folds expired history; runs on a timer. */
  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    if (performance.now() - this.startedAt < SWEEP_START_DELAY_MS) return Promise.resolve();
    const run = this.runSweep()
      .catch((error: unknown) => {
        this.logger.warn(
          `SSH connection history sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.sweeping = null;
      });
    this.sweeping = run;
    return run;
  }

  /** Waits for every queued write (tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.links.values()].map((link) => link.chain));
    await this.sweeping;
  }

  private async runSweep(): Promise<void> {
    const connected = [...this.links.values()]
      .map((link) => link.instance)
      .filter((instance): instance is string => instance !== null);
    await this.repository.closeLost(connected);
    const now = performance.now();
    if (now - this.lastRetentionAt < RETENTION_INTERVAL_MS) return;
    this.lastRetentionAt = now;
    const days = this.config.get<number>('ssh.proxyHistoryRetentionDays');
    const folded = await this.repository.foldExpired(new Date(Date.now() - days * DAY_MS));
    if (folded > 0) this.logger.log(`Folded ${folded} SSH connection(s) older than ${days} days into daily usage`);
  }

  private link(connection: object): ProxyLink {
    let link = this.links.get(connection);
    if (!link) {
      link = { chain: Promise.resolve(), instance: null, resendFrom: null };
      this.links.set(connection, link);
    }
    return link;
  }

  private enqueue(link: ProxyLink, task: () => Promise<number | null>): Promise<number | null> {
    const result = link.chain.then(task);
    link.chain = result.then(() => undefined, () => undefined);
    return result;
  }
}
