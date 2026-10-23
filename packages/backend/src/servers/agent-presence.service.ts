import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { AgentHello } from '@nyabase/common';
import { AgentRegistry } from '../incus/agent-registry.service.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { ReconcileWakeService } from '../reconcile/reconcile-wake.service.js';
import { ServerHealthService } from './server-health.service.js';

const INVENTORY_TIMEOUT_MS = 60_000;

/**
 * Projects agent connections onto `infra.servers`: a connected agent makes the
 * server online and refreshes its inventory (CPU topology, GPUs, pools); a
 * dropped one makes it unreachable until the agent dials back.
 */
@Injectable()
export class AgentPresenceService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentPresenceService.name);
  private unsubscribe?: () => void;
  /** Per-server chain so connect/disconnect projections land in the order they happened. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly agents: AgentRegistry,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
    private readonly health: ServerHealthService,
    private readonly wake: ReconcileWakeService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.agents.onPresence({
      connected: (serverId, hello) => this.serialize(serverId, () => this.connected(serverId, hello)),
      disconnected: (serverId) => this.serialize(serverId, () => this.disconnected(serverId)),
      refused: (serverId, reason) => this.serialize(serverId, () => this.refused(serverId, reason)),
    });
  }

  /**
   * No agent can be connected before the HTTP server listens, so whatever status
   * a previous process left behind is stale: every server waits for its agent.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.database
      .updateTable('infra.servers')
      .set({ status: 'unreachable', last_error: 'Waiting for the server agent to connect' })
      .where('status', '=', 'online')
      .execute();
  }

  private serialize(serverId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(serverId) ?? Promise.resolve())
      .then(work)
      .catch((error: unknown) => {
        this.logger.warn(`Agent presence update for ${serverId} failed: ${String(error)}`);
      });
    this.chains.set(serverId, next);
    void next.then(() => {
      if (this.chains.get(serverId) === next) this.chains.delete(serverId);
    });
    return next;
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private async connected(serverId: string, hello: AgentHello): Promise<void> {
    // The agent may already be gone again; the disconnect projection queued after us wins.
    if (!this.agents.isConnected(serverId)) return;
    await this.database
      .updateTable('infra.servers')
      .set({
        status: 'online',
        last_seen_at: sql<Date>`clock_timestamp()`,
        last_error: null,
        incus_version: hello.incus.serverVersion,
        api_extensions: hello.incus.apiExtensions,
        agent_version: hello.agentVersion,
        agent_hostname: hello.hostname,
        agent_connected_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', serverId)
      .execute();
    try {
      await this.health.refreshInventory(
        serverId,
        await this.clients.get(serverId),
        AbortSignal.timeout(INVENTORY_TIMEOUT_MS),
      );
    } catch (error) {
      this.logger.warn(`Inventory refresh after agent connect failed for ${serverId}: ${String(error)}`);
    }
    this.wake.wake({ serverId, reason: 'reconnect' });
    this.wake.wake({ reason: 'scan' });
  }

  /** An agent that cannot be served (other protocol) leaves the server unreachable, saying why. */
  private async refused(serverId: string, reason: string): Promise<void> {
    if (this.agents.isConnected(serverId)) return;
    await this.database
      .updateTable('infra.servers')
      .set({ status: 'unreachable', last_error: reason.slice(0, 4096) })
      .where('id', '=', serverId)
      .execute();
  }

  private async disconnected(serverId: string): Promise<void> {
    if (this.agents.isConnected(serverId)) return;
    await this.database
      .updateTable('infra.servers')
      .set({ status: 'unreachable', last_error: 'The server agent is not connected' })
      .where('id', '=', serverId)
      .execute();
    this.wake.wake({ serverId, reason: 'disconnected' });
  }
}
