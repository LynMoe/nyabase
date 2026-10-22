import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { IncusError } from '../incus/index.js';
import { lockServerCpuSets } from '../platform/persistence-pg/advisory-locks.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { allocatableCpus, allocateCpuSet, cpuSetStillFits } from './cpu-allocation.js';

type Tx = Transaction<NyabaseDatabase>;
type Executor = Kysely<NyabaseDatabase> | Tx;

interface CpuSetPlan {
  readonly cpus: number[];
  readonly write: 'none' | 'upsert' | 'delete';
}

/**
 * Owns `control.user_cpu_sets`. The CPUs a container is pinned to are always
 * derived from its owner: the owner's set when the grant limits CPU, or every
 * unreserved CPU when it does not. Allocation runs under a per-server lock.
 */
@Injectable()
export class CpuSetService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
  ) {}

  /** The CPUs every container `ownerId` runs on `serverId` must be pinned to; records the set. */
  resolve(serverId: string, ownerId: string): Promise<number[]> {
    return this.transactions.run(async (transaction) => {
      await lockServerCpuSets(transaction, serverId);
      const plan = await this.plan(transaction, serverId, ownerId);
      await this.apply(transaction, serverId, ownerId, plan);
      return plan.cpus;
    });
  }

  /**
   * What `resolve` would answer, without locking or writing: the full scan uses it
   * to compare, and only an actual reconcile records a new set.
   */
  async preview(serverId: string, ownerId: string): Promise<number[]> {
    return (await this.plan(this.database, serverId, ownerId)).cpus;
  }

  /** Forget sets of users who no longer run anything on the server. */
  async releaseIdle(serverId: string): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await lockServerCpuSets(transaction, serverId);
      await transaction
        .deleteFrom('control.user_cpu_sets as s')
        .where('s.server_id', '=', serverId)
        .where(({ not, exists, selectFrom }) => not(exists(
          selectFrom('control.containers as c')
            .select(sql<number>`1`.as('one'))
            .whereRef('c.owner_id', '=', 's.user_id')
            .whereRef('c.server_id', '=', 's.server_id'),
        )))
        .execute();
    });
  }

  private async plan(executor: Executor, serverId: string, ownerId: string): Promise<CpuSetPlan> {
    const server = await executor
      .selectFrom('infra.servers')
      .select(['reserved_cpus', 'cpu_topology'])
      .where('id', '=', serverId)
      .executeTakeFirst();
    const topology = server?.cpu_topology ?? [];
    const reserved = server?.reserved_cpus ?? [];
    const allocatable = allocatableCpus(topology, reserved);
    if (allocatable.length === 0) {
      throw new IncusError('INVALID_INSTANCE_SPEC', 'retry', {
        serverId,
        reason: topology.length === 0 ? 'cpu_topology_unknown' : 'no_unreserved_cpus',
      });
    }
    // The effective view holds current grants of active users only: an expired
    // or revoked grant, or a disabled user, has no row.
    const grant = await executor
      .selectFrom('iam.effective_server_access')
      .select('cpu_cores')
      .where('user_id', '=', ownerId)
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    const existing = await executor
      .selectFrom('control.user_cpu_sets')
      .select('cpus')
      .where('server_id', '=', serverId)
      .where('user_id', '=', ownerId)
      .executeTakeFirst();
    const unlimited = grant ? grant.cpu_cores === null : !existing;
    if (unlimited) return { cpus: allocatable, write: existing ? 'delete' : 'none' };
    // No current grant (revoked, expired or user disabled): keep the user pinned to what they had.
    const cores = grant?.cpu_cores ?? existing!.cpus.length;
    if (existing && cpuSetStillFits(existing.cpus, cores, topology, reserved)) {
      return { cpus: [...existing.cpus].sort((left, right) => left - right), write: 'none' };
    }
    const others = await executor
      .selectFrom('control.user_cpu_sets as s')
      .select('s.cpus')
      .where('s.server_id', '=', serverId)
      .where('s.user_id', '<>', ownerId)
      .where(({ exists, selectFrom }) => exists(
        selectFrom('control.containers as c')
          .select(sql<number>`1`.as('one'))
          .whereRef('c.owner_id', '=', 's.user_id')
          .whereRef('c.server_id', '=', 's.server_id'),
      ))
      .execute();
    const cpus = allocateCpuSet({
      topology,
      reserved,
      cores,
      current: existing?.cpus ?? [],
      others: others.map((row) => row.cpus),
    });
    return { cpus, write: 'upsert' };
  }

  private async apply(transaction: Tx, serverId: string, ownerId: string, plan: CpuSetPlan): Promise<void> {
    if (plan.write === 'delete') {
      await transaction
        .deleteFrom('control.user_cpu_sets')
        .where('server_id', '=', serverId)
        .where('user_id', '=', ownerId)
        .execute();
    } else if (plan.write === 'upsert') {
      await transaction
        .insertInto('control.user_cpu_sets')
        .values({ server_id: serverId, user_id: ownerId, cpus: plan.cpus })
        .onConflict((conflict) => conflict.columns(['server_id', 'user_id']).doUpdateSet({
          cpus: plan.cpus,
          updated_at: sql<Date>`clock_timestamp()`,
        }))
        .execute();
    }
  }
}
