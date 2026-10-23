import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { AgentRegistry } from '../incus/agent-registry.service.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { ReconcileWakeService } from '../reconcile/reconcile-wake.service.js';

const FIRST_PROBE_DELAY_MS = 15_000;
const MAX_PROBE_DELAY_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Brings a server back online after the reconcile worker marked it unreachable
 * (`SERVER_UNREACHABLE` / `INCUS_TIMEOUT`) while its agent stayed connected.
 * No agent connect event follows in that case and scans skip servers that are
 * not online, so the server would stay unreachable until some intent on it
 * happened to succeed. While the agent is connected this probes Incus with
 * backoff; a success restores `online` and wakes a full scan. Once the agent
 * disconnects the probe stops: the next connect projection restores the server.
 */
@Injectable()
export class ServerRecoveryService implements OnModuleDestroy {
  private readonly logger = new Logger(ServerRecoveryService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly agents: AgentRegistry,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
    private readonly wake: ReconcileWakeService,
  ) {}

  /** Schedules a probe unless one is pending or the agent is gone. */
  watch(serverId: string, delayMs = FIRST_PROBE_DELAY_MS): void {
    if (this.timers.has(serverId) || !this.agents.isConnected(serverId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(serverId);
      // A database error (PG restart, failover) must not become an unhandled
      // rejection: that would exit the whole process. Probe again later.
      void this.probe(serverId, delayMs).catch((error: unknown) => {
        this.logger.warn(`Recovery probe for ${serverId} errored: ${String(error)}`);
        this.watch(serverId, Math.min(delayMs * 2, MAX_PROBE_DELAY_MS));
      });
    }, delayMs);
    timer.unref?.();
    this.timers.set(serverId, timer);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Visible for tests: one probe round. */
  async probe(serverId: string, delayMs = FIRST_PROBE_DELAY_MS): Promise<void> {
    if (!this.agents.isConnected(serverId)) return;
    const server = await this.database.selectFrom('infra.servers')
      .select('status')
      .where('id', '=', serverId)
      .executeTakeFirst();
    if (server?.status !== 'unreachable') return;
    try {
      const client = await this.clients.get(serverId);
      await client.getServer({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (error) {
      this.logger.debug(`Recovery probe for ${serverId} failed: ${String(error)}`);
      this.watch(serverId, Math.min(delayMs * 2, MAX_PROBE_DELAY_MS));
      return;
    }
    // A disconnect projection that lands after this keeps the server unreachable.
    if (!this.agents.isConnected(serverId)) return;
    const recovered = await this.database.updateTable('infra.servers')
      .set({ status: 'online', last_seen_at: sql<Date>`clock_timestamp()`, last_error: null })
      .where('id', '=', serverId)
      .where('status', '=', 'unreachable')
      .executeTakeFirst();
    if (Number(recovered.numUpdatedRows) === 0) return;
    this.logger.log(`Server ${serverId} answers again; marked online`);
    this.wake.wake({ serverId, reason: 'reconnect' });
    this.wake.wake({ reason: 'scan' });
  }
}
