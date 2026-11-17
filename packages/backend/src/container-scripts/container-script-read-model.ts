import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import {
  CONTAINER_SCRIPT_TARGET_STATES,
  type ContainerScriptCounts,
  type ContainerScriptPersonRef,
  type ContainerScriptTargetState,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { derivedStateSql } from './container-script-scope.js';

export function emptyCounts(): ContainerScriptCounts {
  return Object.fromEntries(CONTAINER_SCRIPT_TARGET_STATES.map((state) => [state, 0])) as ContainerScriptCounts;
}

export interface TargetListRow {
  container_id: string;
  container_name: string;
  server_id: string;
  server_name: string;
  owner_id: string;
  owner_username: string;
  owner_display_name: string;
  state: ContainerScriptTargetState;
  target_version: number | null;
  succeeded_version: number | null;
  trigger: 'now' | 'new_container' | 'boot' | 'retry' | null;
  attempts: number;
  next_attempt_at: Date | null;
  updated_at: Date;
  run_id: string | null;
  run_version: number | null;
  run_trigger: 'now' | 'new_container' | 'boot' | 'retry' | null;
  run_attempt: number | null;
  run_status: 'running' | 'succeeded' | 'failed' | 'timed_out' | 'interrupted' | null;
  run_exit_code: number | null;
  run_started_at: Date | null;
  run_finished_at: Date | null;
}

export interface ScopeCandidateRow {
  id: string;
  name: string;
  server_id: string;
  server_name: string;
  image_id: string;
  owner_id: string;
  owner_username: string;
  owner_display_name: string;
  running: boolean;
}

/** What one run needs to know besides its script version. */
export interface RunContainerContext {
  container_name: string;
  instance_name: string | null;
  server_name: string;
  owner_username: string;
  login_user: string;
}

const runColumns = [
  'r.id',
  'r.script_id',
  'r.version',
  'r.container_id',
  'c.name as container_name',
  'r.server_id',
  'r.trigger',
  'r.attempt',
  'r.boot_id',
  'r.status',
  'r.exit_code',
  'r.error',
  'r.started_at',
  'r.finished_at',
] as const;

/**
 * Reads across modules for container script DTOs: containers, their servers
 * and owners, joined with targets and runs. Read-only.
 */
@Injectable()
export class ContainerScriptReadModel {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  async counts(): Promise<Map<string, ContainerScriptCounts>> {
    const rows = await this.database
      .selectFrom('control.container_script_targets as t')
      .innerJoin('control.containers as c', 'c.id', 't.container_id')
      .leftJoin('control.container_boot_observations as o', 'o.container_id', 't.container_id')
      .select(['t.script_id', derivedStateSql('t', 'c', 'o').as('state'), sql<number>`count(*)::int`.as('count')])
      .groupBy(['t.script_id', sql`2`])
      .execute();
    const counts = new Map<string, ContainerScriptCounts>();
    for (const row of rows) {
      const entry = counts.get(row.script_id) ?? emptyCounts();
      entry[row.state as ContainerScriptTargetState] = Number(row.count);
      counts.set(row.script_id, entry);
    }
    return counts;
  }

  async targets(scriptId: string, state?: ContainerScriptTargetState): Promise<TargetListRow[]> {
    const derived = derivedStateSql('t', 'c', 'o');
    let query = this.database
      .selectFrom('control.container_script_targets as t')
      .innerJoin('control.containers as c', 'c.id', 't.container_id')
      .innerJoin('infra.servers as s', 's.id', 'c.server_id')
      .innerJoin('iam.users as u', 'u.id', 'c.owner_id')
      .leftJoin('control.container_boot_observations as o', 'o.container_id', 't.container_id')
      .leftJoin('control.container_script_runs as r', 'r.id', 't.last_run_id')
      .select([
        't.container_id',
        'c.name as container_name',
        'c.server_id',
        's.name as server_name',
        'c.owner_id',
        'u.username as owner_username',
        'u.display_name as owner_display_name',
        derived.as('state'),
        't.target_version',
        't.succeeded_version',
        't.trigger',
        't.attempts',
        't.next_attempt_at',
        't.updated_at',
        'r.id as run_id',
        'r.version as run_version',
        'r.trigger as run_trigger',
        'r.attempt as run_attempt',
        'r.status as run_status',
        'r.exit_code as run_exit_code',
        'r.started_at as run_started_at',
        'r.finished_at as run_finished_at',
      ])
      .where('t.script_id', '=', scriptId);
    if (state) query = query.where(derived, '=', state);
    return query.orderBy('s.name').orderBy('c.name').execute() as Promise<TargetListRow[]>;
  }

  async runs(scriptId: string, options: { containerId?: string; limit: number; before?: string }) {
    let query = this.database
      .selectFrom('control.container_script_runs as r')
      .innerJoin('control.containers as c', 'c.id', 'r.container_id')
      .select([...runColumns])
      .where('r.script_id', '=', scriptId);
    if (options.containerId) query = query.where('r.container_id', '=', options.containerId);
    if (options.before) {
      const before = options.before;
      query = query.where(({ eb, selectFrom }) => eb(
        sql`(r.started_at, r.id)`,
        '<',
        selectFrom('control.container_script_runs as anchor').select(sql`(anchor.started_at, anchor.id)`.as('k')).where('anchor.id', '=', before),
      ));
    }
    return query.orderBy('r.started_at', 'desc').orderBy('r.id', 'desc').limit(options.limit + 1).execute();
  }

  run(scriptId: string, runId: string) {
    return this.database
      .selectFrom('control.container_script_runs as r')
      .innerJoin('control.containers as c', 'c.id', 'r.container_id')
      .select([...runColumns, 'r.output'])
      .where('r.script_id', '=', scriptId)
      .where('r.id', '=', runId)
      .executeTakeFirst();
  }

  /** Every container that could be in a scope, with whether it is running now. */
  async scopeCandidates(): Promise<ScopeCandidateRow[]> {
    return this.database
      .selectFrom('control.containers as c')
      .innerJoin('infra.servers as s', 's.id', 'c.server_id')
      .innerJoin('iam.users as u', 'u.id', 'c.owner_id')
      .leftJoin('control.container_boot_observations as o', 'o.container_id', 'c.id')
      .select([
        'c.id',
        'c.name',
        'c.server_id',
        's.name as server_name',
        'c.image_id',
        'c.owner_id',
        'u.username as owner_username',
        'u.display_name as owner_display_name',
        sql<boolean>`c.lifecycle_phase = 'active' AND c.power_intent = 'running'
          AND coalesce(o.instance_status, '') = 'running'`.as('running'),
      ])
      .where('c.lifecycle_phase', '<>', 'deleting')
      .orderBy('s.name')
      .orderBy('c.name')
      .execute();
  }

  async persons(ids: ReadonlyArray<string | null>): Promise<Map<string, ContainerScriptPersonRef>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await this.database
      .selectFrom('iam.users')
      .select(['id', 'username', 'display_name'])
      .where('id', 'in', wanted)
      .execute();
    return new Map(rows.map((row) => [row.id, { id: row.id, username: row.username, displayName: row.display_name }]));
  }

  /** The scripts that ran or are due in one container, for its owner. */
  async maintenance(containerId: string) {
    return this.database
      .selectFrom('control.container_scripts as s')
      .leftJoin('control.container_script_targets as t', (join) => join
        .onRef('t.script_id', '=', 's.id')
        .on('t.container_id', '=', containerId))
      .leftJoin('control.containers as c', 'c.id', 't.container_id')
      .leftJoin('control.container_boot_observations as o', 'o.container_id', 't.container_id')
      .select([
        's.id',
        's.name',
        's.every_boot',
        's.status',
        derivedStateSql('t', 'c', 'o').as('state'),
        (expression) => expression
          .selectFrom('control.container_script_runs as r')
          .select(sql<string>`json_build_object('status', r.status, 'startedAt', r.started_at, 'finishedAt', r.finished_at)::text`.as('run'))
          .whereRef('r.script_id', '=', 's.id')
          .where('r.container_id', '=', containerId)
          .orderBy('r.started_at', 'desc')
          .limit(1)
          .as('last_run'),
      ])
      .orderBy('s.priority')
      .execute();
  }

  async runContainerContext(containerId: string): Promise<RunContainerContext | undefined> {
    return this.database
      .selectFrom('control.containers as c')
      .innerJoin('infra.servers as s', 's.id', 'c.server_id')
      .innerJoin('iam.users as u', 'u.id', 'c.owner_id')
      .innerJoin('infra.images as i', 'i.id', 'c.image_id')
      .select([
        'c.name as container_name',
        'c.instance_name',
        's.name as server_name',
        'u.username as owner_username',
        'i.login_user',
      ])
      .where('c.id', '=', containerId)
      .executeTakeFirst();
  }

  /** Containers on a server the observer reports on (all but those being deleted). */
  containersOnServer(serverId: string) {
    return this.database
      .selectFrom('control.containers')
      .select(['id', 'instance_name'])
      .where('server_id', '=', serverId)
      .where('lifecycle_phase', '<>', 'deleting')
      .execute();
  }

  async containerOwner(containerId: string): Promise<{ owner_id: string } | undefined> {
    return this.database
      .selectFrom('control.containers')
      .select('owner_id')
      .where('id', '=', containerId)
      .executeTakeFirst();
  }
}
