import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { parseCidrPrefix } from '../containers/guest-network.adapter.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

export interface ServerRow {
  id: string;
  name: string;
  parent_interface: string | null;
  dns_servers: string[] | null;
  status: 'online' | 'unreachable' | 'unknown';
  system_pool_id: string | null;
  preflight_status: 'not_run' | 'running' | 'passed' | 'failed';
  gpu_enabled: boolean;
  revision: string | number | bigint;
}

export interface IpPoolNetwork {
  readonly gateway: string;
  readonly cidr: string;
  readonly prefixLength: number;
}

export class ServerRevisionChangedError extends Error {
  constructor() {
    super('The server configuration changed during preflight');
    this.name = 'ServerRevisionChangedError';
  }
}

export function normalized(value: string): string {
  return value.replaceAll('-', '').toLowerCase();
}

export function revisionNumber(value: string | number | bigint | undefined): number | undefined {
  if (value === undefined) return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}

/** Every SQL statement the server preflight reconciler issues. */
@Injectable()
export class ServerPreflightStore {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  async readReservedCpus(id: string): Promise<number[]> {
    const row = await this.database
      .selectFrom('infra.servers')
      .select('reserved_cpus')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.reserved_cpus ?? [];
  }

  readServer(id: string): Promise<ServerRow | undefined> {
    return this.database
      .selectFrom('infra.servers')
      .select([
        'id',
        'name',
        'parent_interface',
        'dns_servers',
        'status',
        'system_pool_id',
        'preflight_status',
        'gpu_enabled',
        'revision',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /**
   * Apply a server update guarded by the revision the intent was queued for.
   * False means the server changed meanwhile and the result is stale.
   */
  async projectServer(
    serverId: string,
    expectedRevision: number | undefined,
    values: Record<string, unknown>,
  ): Promise<boolean> {
    const query = this.database
      .updateTable('infra.servers')
      .set(values as never)
      .where((expression) =>
        expectedRevision === undefined
          ? expression('id', '=', serverId)
          : expression.and([
              expression('id', '=', serverId),
              expression('revision', '=', String(expectedRevision)),
            ]),
      );
    const result = await query.execute();
    if (!Array.isArray(result)) return true;
    const updateResult = result[0] as { readonly numUpdatedRows?: number | bigint } | undefined;
    return updateResult?.numUpdatedRows === undefined || Number(updateResult.numUpdatedRows) > 0;
  }

  async markStatus(
    id: string,
    status: 'online' | 'unreachable' | 'unknown',
    lastError: string | null,
    expectedRevision?: number,
  ): Promise<void> {
    await this.projectServer(id, expectedRevision, {
      status,
      last_error: lastError?.slice(0, 4096) ?? null,
    });
  }

  async markUnreachable(id: string, error: unknown, expectedRevision?: number): Promise<void> {
    await this.markStatus(
      id,
      'unreachable',
      error instanceof Error ? error.message : String(error),
      expectedRevision,
    );
  }

  async readSystemPool(poolId: string) {
    return this.database
      .selectFrom('infra.storage_pools')
      .select(['incus_name', 'server_id', 'registered'])
      .where('id', '=', poolId)
      .executeTakeFirst();
  }

  async setGpuHealth(serverId: string, health: unknown): Promise<void> {
    await this.database
      .updateTable('infra.servers')
      .set({ gpu_health: health } as never)
      .where('id', '=', serverId)
      .execute();
  }

  /** The IP pools bound to the server, oldest first, with their gateway and prefix. */
  async listIpPoolNetworks(serverId: string): Promise<IpPoolNetwork[]> {
    const rows = await this.database
      .selectFrom('infra.ip_pool_servers as binding')
      .innerJoin('infra.ip_pools as pool', 'pool.id', 'binding.pool_id')
      .select(['pool.gateway', 'pool.cidr'])
      .where('binding.server_id', '=', serverId)
      .orderBy('pool.created_at', 'asc')
      .orderBy('pool.id', 'asc')
      .execute();
    const networks: IpPoolNetwork[] = [];
    for (const row of rows) {
      const gateway = typeof row.gateway === 'string' ? row.gateway.trim() : '';
      const cidr = typeof row.cidr === 'string' ? row.cidr.trim() : '';
      const prefixLength = parseCidrPrefix(cidr);
      if (!gateway || !cidr || prefixLength === undefined) continue;
      networks.push({
        gateway: gateway.includes('/') ? gateway.split('/')[0]! : gateway,
        cidr,
        prefixLength,
      });
    }
    return networks;
  }
}
