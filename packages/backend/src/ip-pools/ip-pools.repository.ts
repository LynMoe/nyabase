import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';

export type IpPoolExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export interface IpPoolRow {
  id: string;
  name: string;
  cidr: string;
  allocation_cidr: string;
  gateway: string;
  reserved_ips: string[] | string;
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  server_ids: string[];
}

const poolSelectColumns = [
  'pool.id',
  'pool.name',
  'pool.cidr',
  'pool.allocation_cidr',
  'pool.gateway',
  'pool.reserved_ips',
  'pool.revision',
  'pool.created_at',
  'pool.updated_at',
] as const;

const poolGroupByColumns = [
  'pool.id',
  'pool.name',
  'pool.cidr',
  'pool.allocation_cidr',
  'pool.gateway',
  'pool.reserved_ips',
  'pool.revision',
  'pool.created_at',
  'pool.updated_at',
] as const;

@Injectable()
export class IpPoolsRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  list(executor: IpPoolExecutor = this.database): Promise<IpPoolRow[]> {
    return executor
      .selectFrom('infra.ip_pools as pool')
      .leftJoin('infra.ip_pool_servers as member', 'member.pool_id', 'pool.id')
      .select([...poolSelectColumns])
      .select(sql<string[]>`coalesce(
        array_agg(DISTINCT member.server_id ORDER BY member.server_id)
          FILTER (WHERE member.server_id IS NOT NULL),
        ARRAY[]::uuid[]
      )`.as('server_ids'))
      .groupBy([...poolGroupByColumns])
      .orderBy('pool.created_at')
      .orderBy('pool.id')
      .execute();
  }

  findById(id: string, executor: IpPoolExecutor = this.database): Promise<IpPoolRow | undefined> {
    return executor
      .selectFrom('infra.ip_pools as pool')
      .leftJoin('infra.ip_pool_servers as member', 'member.pool_id', 'pool.id')
      .select([...poolSelectColumns])
      .select(sql<string[]>`coalesce(
        array_agg(DISTINCT member.server_id ORDER BY member.server_id)
          FILTER (WHERE member.server_id IS NOT NULL),
        ARRAY[]::uuid[]
      )`.as('server_ids'))
      .where('pool.id', '=', id)
      .groupBy([...poolGroupByColumns])
      .executeTakeFirst();
  }

  findByIdForUpdate(id: string, executor: IpPoolExecutor) {
    return executor
      .selectFrom('infra.ip_pools')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  listForServer(serverId: string, executor: IpPoolExecutor = this.database) {
    return executor
      .selectFrom('infra.ip_pools as pool')
      .innerJoin('infra.ip_pool_servers as member', 'member.pool_id', 'pool.id')
      .select([
        'pool.id',
        'pool.name',
        'pool.cidr',
        'pool.allocation_cidr',
        'pool.gateway',
        'pool.reserved_ips',
        'pool.revision',
        'pool.created_at',
        'pool.updated_at',
      ])
      .where('member.server_id', '=', serverId)
      .orderBy('pool.created_at')
      .orderBy('pool.id')
      .execute();
  }

  listAllCidrs(executor: IpPoolExecutor = this.database, excludeId?: string) {
    let query = executor.selectFrom('infra.ip_pools').select(['id', 'cidr']);
    if (excludeId) query = query.where('id', '<>', excludeId);
    return query.execute();
  }

  insert(input: {
    id: string;
    name: string;
    cidr: string;
    allocationCidr: string;
    gateway: string;
    reservedIps: string[];
  }, executor: IpPoolExecutor) {
    return executor
      .insertInto('infra.ip_pools')
      .values({
        id: input.id,
        name: input.name,
        cidr: input.cidr,
        allocation_cidr: input.allocationCidr,
        gateway: input.gateway,
        reserved_ips: JSON.stringify(input.reservedIps),
        revision: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  update(
    id: string,
    expectedRevision: number,
    patch: {
      name?: string;
      cidr?: string;
      allocationCidr?: string;
      gateway?: string;
      reservedIps?: string[];
    },
    executor: IpPoolExecutor,
  ) {
    return executor
      .updateTable('infra.ip_pools')
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.cidr === undefined ? {} : { cidr: patch.cidr }),
        ...(patch.allocationCidr === undefined
          ? {}
          : { allocation_cidr: patch.allocationCidr }),
        ...(patch.gateway === undefined ? {} : { gateway: patch.gateway }),
        ...(patch.reservedIps === undefined
          ? {}
          : { reserved_ips: JSON.stringify(patch.reservedIps) }),
        revision: expectedRevision + 1,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
  }

  delete(id: string, executor: IpPoolExecutor) {
    return executor.deleteFrom('infra.ip_pools').where('id', '=', id).execute();
  }

  listServerIds(poolId: string, executor: IpPoolExecutor = this.database) {
    return executor
      .selectFrom('infra.ip_pool_servers')
      .select('server_id')
      .where('pool_id', '=', poolId)
      .orderBy('server_id')
      .execute()
      .then((rows) => rows.map((row) => row.server_id));
  }

  replaceServers(poolId: string, serverIds: readonly string[], executor: IpPoolExecutor) {
    return executor.deleteFrom('infra.ip_pool_servers')
      .where('pool_id', '=', poolId)
      .execute()
      .then(async () => {
        if (serverIds.length === 0) return;
        await executor.insertInto('infra.ip_pool_servers')
          .values(serverIds.map((serverId) => ({
            pool_id: poolId,
            server_id: serverId,
          })))
          .execute();
      });
  }

  removeServers(poolId: string, serverIds: readonly string[], executor: IpPoolExecutor) {
    if (serverIds.length === 0) return Promise.resolve();
    return executor.deleteFrom('infra.ip_pool_servers')
      .where('pool_id', '=', poolId)
      .where('server_id', 'in', [...serverIds])
      .execute();
  }

  countClaimsForNetwork(
    networkKey: string,
    executor: IpPoolExecutor = this.database,
    options: { serverId?: string } = {},
  ) {
    let query = executor
      .selectFrom('control.container_network_claims')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('network_key', '=', networkKey)
      .where((expression) => expression.or([
        expression('state', '=', 'active'),
        expression.and([
          expression('state', '=', 'releasing'),
          expression('reusable_at', '>', new Date()),
        ]),
      ]));
    if (options.serverId) query = query.where('server_id', '=', options.serverId);
    return query.executeTakeFirstOrThrow().then((row) => Number(row.count));
  }

  listClaimAddresses(
    networkKey: string,
    executor: IpPoolExecutor = this.database,
  ): Promise<string[]> {
    return executor
      .selectFrom('control.container_network_claims')
      .select('address')
      .where('network_key', '=', networkKey)
      .where((expression) => expression.or([
        expression('state', '=', 'active'),
        expression.and([
          expression('state', '=', 'releasing'),
          expression('reusable_at', '>', new Date()),
        ]),
      ]))
      .execute()
      .then((rows) => rows.map((row) => row.address));
  }

  countAllocated(networkKey: string, executor: IpPoolExecutor = this.database) {
    return this.countClaimsForNetwork(networkKey, executor);
  }
}
