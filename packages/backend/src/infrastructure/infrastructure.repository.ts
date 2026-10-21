import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import type {
  InfrastructureStoragePoolTable,
} from '../platform/persistence-pg/infrastructure-database.types.js';

export type InfrastructureExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export const INFRASTRUCTURE_ADVISORY_NAMESPACE = 1_856_214_885;
export const SERVER_ONBOARDING_ADVISORY_KEY = 5;
export const IMAGE_CAPACITY_ADVISORY_KEY = 6;

export interface StoragePoolDiscovery {
  readonly serverId: string;
  readonly incusName: string;
  readonly driver: InfrastructureStoragePoolTable['driver'];
  readonly resizeFamily: InfrastructureStoragePoolTable['resize_family'];
  readonly rootDiskCapable: boolean;
  readonly shareable: boolean;
  readonly blockFilesystem: string | null;
  readonly totalBytes: number | string | bigint | null;
  readonly usedBytes: number | string | bigint | null;
  readonly quotaEffective: boolean | null;
  readonly source: string | null;
}

/**
 * Serializes server admission with certificate rotation's final coverage gate.
 * Every server writer and certificate activation must acquire this transaction
 * scoped lock before reading or changing the server set.
 */
export async function lockServerOnboarding(executor: InfrastructureExecutor): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    ${INFRASTRUCTURE_ADVISORY_NAMESPACE},
    ${SERVER_ONBOARDING_ADVISORY_KEY}
  )`.execute(executor);
}

@Injectable()
export class InfrastructureRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  executor(executor?: InfrastructureExecutor): InfrastructureExecutor {
    return executor ?? this.database;
  }

  async lockServerCapacity(executor: InfrastructureExecutor): Promise<void> {
    await lockServerOnboarding(executor);
  }

  async lockImageCapacity(executor: InfrastructureExecutor): Promise<void> {
    await sql`select pg_advisory_xact_lock(
      ${INFRASTRUCTURE_ADVISORY_NAMESPACE},
      ${IMAGE_CAPACITY_ADVISORY_KEY}
    )`.execute(executor);
  }

  listServers(executor: InfrastructureExecutor = this.database) {
    return executor.selectFrom('infra.servers').selectAll().orderBy('name').orderBy('id').execute();
  }

  async deleteServer(
    id: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<boolean> {
    const result = await executor
      .deleteFrom('infra.servers')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  listStoragePools(
    serverId?: string,
    includeUnregistered = false,
    executor: InfrastructureExecutor = this.database,
  ) {
    let query = executor
      .selectFrom('infra.storage_pools')
      .selectAll()
      .orderBy('incus_name')
      .orderBy('id');
    if (serverId) query = query.where('server_id', '=', serverId);
    if (!includeUnregistered) query = query.where('registered', '=', true);
    return query.execute();
  }

  listImages(executor: InfrastructureExecutor = this.database) {
    return executor.selectFrom('infra.images').selectAll().orderBy('alias').orderBy('id').execute();
  }

}
