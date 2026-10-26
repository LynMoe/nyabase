import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { FirewallAction, FirewallPortRange, FirewallProtocol } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';

export type FirewallExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export interface FirewallRuleRow {
  id: string;
  name: string;
  description: string;
  priority: number;
  action: FirewallAction;
  protocol: FirewallProtocol;
  ports: FirewallPortRange[] | string;
  cidrs: string[] | string;
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  server_ids: string[];
}

/** One (server, rule) association with what the agent document needs of the rule. */
export interface FirewallServerRuleRow {
  server_id: string;
  priority: number;
  action: FirewallAction;
  protocol: FirewallProtocol;
  ports: FirewallPortRange[] | string;
  cidrs: string[] | string;
}

export interface FirewallRuleValues {
  name: string;
  description: string;
  priority: number;
  action: FirewallAction;
  protocol: FirewallProtocol;
  ports: FirewallPortRange[];
  cidrs: string[];
}

const ruleColumns = [
  'rule.id',
  'rule.name',
  'rule.description',
  'rule.priority',
  'rule.action',
  'rule.protocol',
  'rule.ports',
  'rule.cidrs',
  'rule.revision',
  'rule.created_at',
  'rule.updated_at',
] as const;

const serverIdsColumn = sql<string[]>`coalesce(
  array_agg(member.server_id ORDER BY member.server_id)
    FILTER (WHERE member.server_id IS NOT NULL),
  ARRAY[]::uuid[]
)`.as('server_ids');

@Injectable()
export class FirewallRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  list(executor: FirewallExecutor = this.database): Promise<FirewallRuleRow[]> {
    return executor
      .selectFrom('infra.firewall_rules as rule')
      .leftJoin('infra.firewall_rule_servers as member', 'member.rule_id', 'rule.id')
      .select([...ruleColumns])
      .select(serverIdsColumn)
      .groupBy([...ruleColumns])
      .orderBy('rule.priority')
      .execute();
  }

  findById(id: string, executor: FirewallExecutor = this.database): Promise<FirewallRuleRow | undefined> {
    return executor
      .selectFrom('infra.firewall_rules as rule')
      .leftJoin('infra.firewall_rule_servers as member', 'member.rule_id', 'rule.id')
      .select([...ruleColumns])
      .select(serverIdsColumn)
      .where('rule.id', '=', id)
      .groupBy([...ruleColumns])
      .executeTakeFirst();
  }

  findByIdForUpdate(id: string, executor: FirewallExecutor) {
    return executor
      .selectFrom('infra.firewall_rules')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  /** A rule other than `excludeId` that already has this name or priority. */
  findConflict(
    name: string,
    priority: number,
    excludeId: string | undefined,
    executor: FirewallExecutor,
  ) {
    let query = executor
      .selectFrom('infra.firewall_rules')
      .select(['id', 'name', 'priority'])
      .where((expression) => expression.or([
        expression('name', '=', name),
        expression('priority', '=', priority),
      ]));
    if (excludeId) query = query.where('id', '<>', excludeId);
    return query.orderBy('priority').executeTakeFirst();
  }

  /**
   * The given servers that exist, each locked FOR KEY SHARE: a concurrent
   * server delete waits for this transaction (and then cascades its rows)
   * instead of making the association insert fail its foreign key.
   */
  lockExistingServers(serverIds: readonly string[], executor: FirewallExecutor): Promise<string[]> {
    if (serverIds.length === 0) return Promise.resolve([]);
    return executor
      .selectFrom('infra.servers')
      .select('id')
      .where('id', 'in', [...serverIds])
      .forKeyShare()
      .execute()
      .then((rows) => rows.map((row) => row.id));
  }

  /** Per server: rules and CIDRs associated with it, not counting `excludeRuleId`. */
  usageByServer(
    serverIds: readonly string[],
    excludeRuleId: string | undefined,
    executor: FirewallExecutor,
  ): Promise<Array<{ server_id: string; rules: number; cidrs: number }>> {
    if (serverIds.length === 0) return Promise.resolve([]);
    let query = executor
      .selectFrom('infra.firewall_rule_servers as member')
      .innerJoin('infra.firewall_rules as rule', 'rule.id', 'member.rule_id')
      .select([
        'member.server_id',
        sql<string>`count(*)`.as('rules'),
        sql<string>`coalesce(sum(jsonb_array_length(rule.cidrs)), 0)`.as('cidrs'),
      ])
      .where('member.server_id', 'in', [...serverIds]);
    if (excludeRuleId) query = query.where('member.rule_id', '<>', excludeRuleId);
    return query
      .groupBy('member.server_id')
      .execute()
      .then((rows) => rows.map((row) => ({
        server_id: row.server_id,
        rules: Number(row.rules),
        cidrs: Number(row.cidrs),
      })));
  }

  insert(id: string, values: FirewallRuleValues, executor: FirewallExecutor) {
    return executor
      .insertInto('infra.firewall_rules')
      .values({
        id,
        ...values,
        ports: JSON.stringify(values.ports),
        cidrs: JSON.stringify(values.cidrs),
        revision: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  update(id: string, expectedRevision: number, values: FirewallRuleValues, executor: FirewallExecutor) {
    return executor
      .updateTable('infra.firewall_rules')
      .set({
        ...values,
        ports: JSON.stringify(values.ports),
        cidrs: JSON.stringify(values.cidrs),
        revision: expectedRevision + 1,
      })
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .returning('id')
      .executeTakeFirst();
  }

  delete(id: string, executor: FirewallExecutor) {
    return executor.deleteFrom('infra.firewall_rules').where('id', '=', id).execute();
  }

  listServerIds(ruleId: string, executor: FirewallExecutor = this.database): Promise<string[]> {
    return executor
      .selectFrom('infra.firewall_rule_servers')
      .select('server_id')
      .where('rule_id', '=', ruleId)
      .orderBy('server_id')
      .execute()
      .then((rows) => rows.map((row) => row.server_id));
  }

  async replaceServers(ruleId: string, serverIds: readonly string[], executor: FirewallExecutor): Promise<void> {
    await executor.deleteFrom('infra.firewall_rule_servers').where('rule_id', '=', ruleId).execute();
    if (serverIds.length === 0) return;
    await executor
      .insertInto('infra.firewall_rule_servers')
      .values(serverIds.map((serverId) => ({ rule_id: ruleId, server_id: serverId })))
      .execute();
  }

  /** Every association of the given servers (all servers when omitted), in priority order. */
  listServerRules(
    serverIds?: readonly string[],
    executor: FirewallExecutor = this.database,
  ): Promise<FirewallServerRuleRow[]> {
    if (serverIds?.length === 0) return Promise.resolve([]);
    let query = executor
      .selectFrom('infra.firewall_rule_servers as member')
      .innerJoin('infra.firewall_rules as rule', 'rule.id', 'member.rule_id')
      .select([
        'member.server_id',
        'rule.priority',
        'rule.action',
        'rule.protocol',
        'rule.ports',
        'rule.cidrs',
      ]);
    if (serverIds) query = query.where('member.server_id', 'in', [...serverIds]);
    return query.orderBy('member.server_id').orderBy('rule.priority').execute();
  }

  listServers(executor: FirewallExecutor = this.database): Promise<Array<{ id: string; name: string }>> {
    return executor
      .selectFrom('infra.servers')
      .select(['id', 'name'])
      .orderBy('name')
      .orderBy('id')
      .execute();
  }
}
