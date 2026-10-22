import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { IncusClient, type IncusClientPort } from './index.js';
import { AgentRegistry } from './agent-registry.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';

export const INCUS_CLIENT_FACTORY = Symbol('INCUS_CLIENT_FACTORY');

export interface IncusClientFactory {
  get(serverId: string): Promise<IncusClientPort>;
  listServerIds(): Promise<readonly string[]>;
}

/**
 * Incus clients whose requests travel through the server's host agent. A client
 * is bound to the server, not to one agent connection, so it stays usable
 * across reconnects; calls fail with SERVER_UNREACHABLE while no agent is connected.
 */
@Injectable()
export class AgentIncusClientFactory implements IncusClientFactory {
  private readonly clients = new Map<string, IncusClient>();

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly config: NyabaseConfigService,
    private readonly registry: AgentRegistry,
  ) {}

  async listServerIds(): Promise<readonly string[]> {
    const rows = await this.database
      .selectFrom('infra.servers')
      .select('id')
      .execute();
    return rows.map((row) => row.id);
  }

  async get(serverId: string): Promise<IncusClient> {
    const cached = this.clients.get(serverId);
    if (cached) return cached;
    const timeout = this.config.get<number>('incus.requestTimeoutMs');
    const client = new IncusClient({
      tunnel: this.registry.tunnel(serverId),
      timeouts: { connectMs: timeout, headersMs: timeout, bodyMs: timeout, totalMs: timeout },
      operationWaitTimeoutMs: this.config.get<number>('incus.operationWaitTimeoutMs'),
    });
    this.clients.set(serverId, client);
    return client;
  }
}
