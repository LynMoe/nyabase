import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import type { IncusClientPort } from '../incus/index.js';
import { GpuService } from '../gpu/gpu.service.js';
import { parseCpuTopology } from '../cpu/cpu-allocation.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';
import type { ServerHealthPort } from '../reconcile/managed-reconciler.js';
import { ReconcilerRegistry } from '../reconcile/reconciler-registry.service.js';
import { StoragePoolsService } from '../storage-pools/storage-pools.service.js';

/** The reconcile engine's window onto `infra.servers` and observed inventory. */
@Injectable()
export class ServerHealthService implements ServerHealthPort, OnModuleInit {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly gpu: GpuService,
    private readonly storagePools: StoragePoolsService,
    private readonly registry: ReconcilerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.registerServerHealth(this);
  }

  async isCurrentServerIntent(intent: IntentRecord): Promise<boolean> {
    if (
      intent.resourceType !== 'server'
      || !intent.serverId
      || intent.kind !== 'server.preflight'
    ) {
      return true;
    }
    const server = await this.database
      .selectFrom('infra.servers')
      .select('revision')
      .where('id', '=', intent.serverId)
      .executeTakeFirst();
    return server !== undefined && Number(server.revision) === intent.targetRevision;
  }

  async markServer(
    serverId: string,
    status: 'online' | 'unreachable' | 'unknown',
    error?: string,
    expectedRevision?: number,
  ): Promise<void> {
    await this.database
      .updateTable('infra.servers')
      .set({
        status,
        last_seen_at: status === 'online' ? sql<Date>`clock_timestamp()` : undefined,
        last_error: error?.slice(0, 4096) ?? null,
      })
      .where((expression) => expectedRevision === undefined
        ? expression('id', '=', serverId)
        : expression.and([
          expression('id', '=', serverId),
          expression('revision', '=', String(expectedRevision)),
        ]))
      .execute();
  }

  async isServerOnline(serverId: string): Promise<boolean> {
    const server = await this.database
      .selectFrom('infra.servers')
      .select('status')
      .where('id', '=', serverId)
      .executeTakeFirst();
    return server?.status === 'online';
  }

  async listOnlineServerIds(): Promise<readonly string[]> {
    // Registration starts a server as unknown. Only servers that have
    // completed onboarding may participate in background physical scans.
    const servers = await this.database
      .selectFrom('infra.servers')
      .select('id')
      .where('status', '=', 'online')
      .execute();
    return servers.map((server) => server.id);
  }

  async refreshInventory(
    serverId: string,
    client: IncusClientPort,
    signal: AbortSignal,
  ): Promise<void> {
    const resources = await client.getResources({ signal });
    const topology = parseCpuTopology(resources.metadata);
    if (topology.length > 0) {
      await this.database
        .updateTable('infra.servers')
        .set({ cpu_topology: JSON.stringify(topology) })
        .where('id', '=', serverId)
        .execute();
    }
    await this.gpu.refreshHealth(serverId, resources.metadata, []);
    await this.storagePools.refreshObservedUsage(serverId, client, signal);
  }
}
