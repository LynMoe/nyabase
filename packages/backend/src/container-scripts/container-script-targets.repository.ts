import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { CONTAINER_SCRIPT_RUNS_KEPT } from '@nyabase/common';
import type {
  ContainerScriptRunStatusColumn,
  ContainerScriptTriggerColumn,
} from '../platform/persistence-pg/container-scripts-database.types.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import type { TargetAfterFinish } from './container-script-rules.js';
import { scopeMatchSql } from './container-script-scope.js';

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;
type Tx = Transaction<NyabaseDatabase>;

const now = sql<Date>`clock_timestamp()`;

/** The boot (an Incus RFC 3339 `last_used_at`) started no later than `floor`. */
function bootStartedBy(bootId: string, floor: string) {
  const boot = sql.ref(bootId);
  return sql<boolean>`(${boot} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' AND ${boot}::timestamptz <= ${sql.ref(floor)})`;
}

export interface PublishEffect {
  readonly scriptId: string;
  readonly version: number;
  readonly everyBoot: boolean;
  readonly applyNow: boolean;
  readonly stoppedPolicy: 'wait' | 'skip';
}

export interface InstanceObservation {
  readonly containerId: string;
  /** Lowercase Incus status, or `missing`. */
  readonly status: string;
  readonly bootId: string | null;
}

/** A target that is due now and may start, with what the caps need. */
export interface CandidateRow {
  script_id: string;
  container_id: string;
  server_id: string;
  priority: number;
  target_version: number;
  version_id: string;
  every_boot: boolean;
  max_parallel: number | null;
  max_parallel_per_server: number | null;
  canary_count: number | null;
  canary_cleared: boolean;
}

export interface StartedRun {
  readonly runId: string;
  readonly attempt: number;
  readonly trigger: ContainerScriptTriggerColumn;
  readonly targetBootId: string | null;
}

export interface FinishedRunRow {
  script_id: string;
  version: number;
  container_id: string;
  server_id: string;
  boot_id: string | null;
  status: ContainerScriptRunStatusColumn;
}

/** A run still marked running, with what resuming its watch needs. */
export interface RunningRunRow {
  id: string;
  script_id: string;
  version: number;
  container_id: string;
  server_id: string;
  boot_id: string | null;
  deadline_at: Date;
  instance_name: string | null;
}

/**
 * Where each container stands with each script (targets), what the scheduler
 * observed of instances, and runs. Every writer holds lockContainerScripts.
 */
@Injectable()
export class ContainerScriptTargetsRepository {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  get db(): Kysely<NyabaseDatabase> {
    return this.database;
  }

  // --- publishing ---------------------------------------------------------------------

  /**
   * What publishing `version` does to the targets (see AGENTS.md 容器脚本):
   * out-of-scope rows go; then by kind of script and applyNow, containers in
   * scope become due, or keep their state with the unfinished ones moved to
   * the new version and the rest marked exempt.
   */
  async applyPublish(effect: PublishEffect, tx: Tx): Promise<void> {
    const { scriptId, version } = effect;
    await sql`
      DELETE FROM control.container_script_targets AS t
      USING control.container_script_versions AS v, control.containers AS c
      WHERE t.script_id = ${scriptId} AND v.script_id = ${scriptId} AND v.version = ${version}
        AND c.id = t.container_id AND t.state <> 'running' AND NOT ${scopeMatchSql('v', 'c')}
    `.execute(tx);
    if (effect.applyNow) {
      await this.dueNow(effect, tx);
      return;
    }
    if (effect.everyBoot) {
      await sql`
        UPDATE control.container_script_targets
        SET target_version = ${version}, updated_at = ${now}
        WHERE script_id = ${scriptId}
      `.execute(tx);
    } else {
      // Unfinished containers move to the new version; finished ones stay done.
      await sql`
        UPDATE control.container_script_targets
        SET target_version = ${version},
            state = CASE WHEN state = 'failed' THEN 'pending' ELSE state END,
            attempts = CASE WHEN state = 'running' THEN attempts ELSE 0 END,
            next_attempt_at = CASE WHEN state = 'running' THEN next_attempt_at ELSE NULL END,
            updated_at = ${now}
        WHERE script_id = ${scriptId} AND state IN ('pending', 'running', 'failed')
      `.execute(tx);
    }
    // Containers in scope now and not yet tracked are exempt from this version.
    // Once-scripts leave provisioning containers out: those count as new.
    // Every-boot rows remember the boot seen now, so the next boot is due.
    await sql`
      INSERT INTO control.container_script_targets
        (script_id, container_id, state, target_version, boot_id, boot_after, updated_at)
      SELECT ${scriptId}, c.id, 'exempt', ${effect.everyBoot ? version : null}, o.boot_id,
        CASE WHEN ${effect.everyBoot} AND o.boot_id IS NULL THEN ${now} END, ${now}
      FROM control.containers AS c
      JOIN control.container_script_versions AS v ON v.script_id = ${scriptId} AND v.version = ${version}
      LEFT JOIN control.container_boot_observations AS o ON o.container_id = c.id
      WHERE c.lifecycle_phase <> 'deleting'
        AND (${effect.everyBoot} OR c.lifecycle_phase <> 'provisioning')
        AND ${scopeMatchSql('v', 'c')}
      ON CONFLICT (script_id, container_id) DO NOTHING
    `.execute(tx);
  }

  /** applyNow: every container in scope is due for `version` (one running now runs it next). */
  private async dueNow(effect: PublishEffect, tx: Tx): Promise<void> {
    const skipStopped = !effect.everyBoot && effect.stoppedPolicy === 'skip';
    await sql`
      INSERT INTO control.container_script_targets AS t
        (script_id, container_id, state, target_version, trigger, boot_id, attempts, next_attempt_at, rerun, updated_at)
      SELECT ${effect.scriptId}, c.id,
        CASE WHEN ${skipStopped} AND c.power_intent = 'stopped' THEN 'skipped' ELSE 'pending' END,
        ${effect.version}, 'now',
        CASE WHEN ${effect.everyBoot} AND o.instance_status = 'running' THEN o.boot_id END,
        0, NULL, false, ${now}
      FROM control.containers AS c
      JOIN control.container_script_versions AS v ON v.script_id = ${effect.scriptId} AND v.version = ${effect.version}
      LEFT JOIN control.container_boot_observations AS o ON o.container_id = c.id
      WHERE c.lifecycle_phase <> 'deleting' AND ${scopeMatchSql('v', 'c')}
      ON CONFLICT (script_id, container_id) DO UPDATE SET
        state = CASE WHEN t.state = 'running' THEN 'running' ELSE excluded.state END,
        rerun = t.state = 'running',
        target_version = excluded.target_version,
        trigger = 'now',
        attempts = CASE WHEN t.state = 'running' THEN t.attempts ELSE 0 END,
        next_attempt_at = NULL,
        boot_after = NULL,
        updated_at = excluded.updated_at
    `.execute(tx);
  }

  /** New containers in the scope of a script that takes them: due for its current version. */
  async addNewContainers(tx: Tx): Promise<number> {
    const result = await sql`
      INSERT INTO control.container_script_targets
        (script_id, container_id, state, target_version, trigger, updated_at)
      SELECT s.id, c.id, 'pending', s.current_version, 'new_container', ${now}
      FROM control.container_scripts AS s
      JOIN control.container_script_versions AS v ON v.script_id = s.id AND v.version = s.current_version
      JOIN control.containers AS c ON ${scopeMatchSql('v', 'c')}
      WHERE s.status <> 'archived'
        AND (s.every_boot OR v.on_new_containers)
        AND c.lifecycle_phase <> 'deleting'
        AND NOT EXISTS (
          SELECT 1 FROM control.container_script_targets AS t
          WHERE t.script_id = s.id AND t.container_id = c.id
        )
      ON CONFLICT (script_id, container_id) DO NOTHING
    `.execute(tx);
    return Number(result.numAffectedRows ?? 0);
  }

  /**
   * Every-boot targets whose container is running a boot they have not seen
   * become due for it; a target waiting for a first boot adopts the one seen.
   */
  async applyBoots(tx: Tx): Promise<number> {
    // The boot an exempt row could not see at its publish: adopt it, not due.
    await sql`
      UPDATE control.container_script_targets AS t
      SET boot_id = o.boot_id, boot_after = NULL, updated_at = ${now}
      FROM control.container_boot_observations AS o
      WHERE o.container_id = t.container_id AND t.boot_after IS NOT NULL
        AND o.instance_status = 'running' AND ${bootStartedBy('o.boot_id', 't.boot_after')}
    `.execute(tx);
    const reset = await sql`
      UPDATE control.container_script_targets AS t
      SET state = 'pending', boot_id = o.boot_id, boot_after = NULL, target_version = s.current_version,
          trigger = 'boot', attempts = 0, next_attempt_at = NULL, rerun = false, updated_at = ${now}
      FROM control.container_boot_observations AS o, control.container_scripts AS s
      WHERE o.container_id = t.container_id AND s.id = t.script_id
        AND s.every_boot AND s.status <> 'archived'
        AND o.instance_status = 'running' AND o.boot_id IS NOT NULL
        AND t.state <> 'running'
        AND t.boot_id IS DISTINCT FROM o.boot_id
        AND NOT (t.state = 'pending' AND t.boot_id IS NULL)
    `.execute(tx);
    await sql`
      UPDATE control.container_script_targets AS t
      SET boot_id = o.boot_id, updated_at = ${now}
      FROM control.container_boot_observations AS o, control.container_scripts AS s
      WHERE o.container_id = t.container_id AND s.id = t.script_id AND s.every_boot
        AND t.state = 'pending' AND t.boot_id IS NULL
        AND o.instance_status = 'running' AND o.boot_id IS NOT NULL
    `.execute(tx);
    return Number(reset.numAffectedRows ?? 0);
  }

  /** Due again for the current version: the given containers, or every failed one. */
  async retry(scriptId: string, currentVersion: number, containerIds: readonly string[] | null, tx: Tx): Promise<string[]> {
    let query = tx
      .updateTable('control.container_script_targets')
      .set({
        state: 'pending',
        target_version: currentVersion,
        trigger: 'retry',
        attempts: 0,
        next_attempt_at: null,
        rerun: false,
        boot_after: null,
        updated_at: now,
      })
      .where('script_id', '=', scriptId)
      .where('state', '<>', 'running');
    query = containerIds === null
      ? query.where('state', '=', 'failed')
      : query.where('container_id', 'in', containerIds.length > 0 ? [...containerIds] : ['00000000-0000-0000-0000-000000000000']);
    const rows = await query.returning('container_id').execute();
    return rows.map((row) => row.container_id);
  }

  // --- observations -------------------------------------------------------------------

  async recordObservations(serverId: string, observations: readonly InstanceObservation[], tx: Tx): Promise<void> {
    if (observations.length === 0) return;
    await tx
      .insertInto('control.container_boot_observations')
      .values(observations.map((observation) => ({
        container_id: observation.containerId,
        server_id: serverId,
        instance_status: observation.status,
        boot_id: observation.bootId,
        observed_at: now,
      })))
      .onConflict((conflict) => conflict.column('container_id').doUpdateSet((expression) => ({
        server_id: expression.ref('excluded.server_id'),
        instance_status: expression.ref('excluded.instance_status'),
        boot_id: expression.ref('excluded.boot_id'),
        observed_at: expression.ref('excluded.observed_at'),
      })))
      .execute();
  }

  async observation(containerId: string, executor: Executor = this.database) {
    return executor
      .selectFrom('control.container_boot_observations')
      .select(['instance_status', 'boot_id'])
      .where('container_id', '=', containerId)
      .executeTakeFirst();
  }

  // --- scheduling ---------------------------------------------------------------------

  /**
   * Targets due now whose container is running, idle (no script run, no
   * reconcile claim) and has no other ready target of a lower priority number
   * among active scripts: at most one candidate per container, in priority order.
   */
  async candidates(limit: number): Promise<CandidateRow[]> {
    const result = await sql<CandidateRow>`
      SELECT t.script_id, t.container_id, c.server_id, s.priority, t.target_version, v.id AS version_id, s.every_boot,
             v.max_parallel, v.max_parallel_per_server, v.canary_count, s.canary_cleared
      FROM control.container_script_targets AS t
      JOIN control.container_scripts AS s ON s.id = t.script_id AND s.status = 'active'
      JOIN control.container_script_versions AS v ON v.script_id = t.script_id AND v.version = t.target_version
      JOIN control.containers AS c ON c.id = t.container_id
      JOIN control.container_boot_observations AS o ON o.container_id = t.container_id
      WHERE t.state = 'pending'
        AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ${now})
        AND c.lifecycle_phase = 'active' AND c.power_intent = 'running'
        AND o.instance_status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM control.container_script_runs AS r
          WHERE r.container_id = t.container_id AND r.status = 'running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM control.reconcile_claims AS rc
          WHERE rc.resource_type = 'container' AND rc.resource_id = t.container_id
            AND rc.lease_expires_at > ${now}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM control.container_script_targets AS t2
          JOIN control.container_scripts AS s2 ON s2.id = t2.script_id AND s2.status = 'active'
          WHERE t2.container_id = t.container_id AND t2.state = 'pending'
            AND (t2.next_attempt_at IS NULL OR t2.next_attempt_at <= ${now})
            AND s2.priority < s.priority
        )
      ORDER BY s.priority, c.server_id, t.updated_at
      LIMIT ${limit}
    `.execute(this.database);
    return result.rows;
  }

  /** Runs in progress per script and per (script, server). */
  async runningCounts(): Promise<Array<{ script_id: string; server_id: string; count: number }>> {
    return this.database
      .selectFrom('control.container_script_runs')
      .select(['script_id', 'server_id', sql<number>`count(*)::int`.as('count')])
      .where('status', '=', 'running')
      .groupBy(['script_id', 'server_id'])
      .execute();
  }

  /** Containers that started a run of the version (the canary's progress). */
  async startedContainers(scriptId: string, version: number, executor: Executor = this.database): Promise<Set<string>> {
    const rows = await executor
      .selectFrom('control.container_script_runs')
      .select('container_id')
      .distinct()
      .where('script_id', '=', scriptId)
      .where('version', '=', version)
      .execute();
    return new Set(rows.map((row) => row.container_id));
  }

  /**
   * Claims a due target: inserts the run, then moves the target to running
   * (counting the attempt). Null when the target is no longer due or another
   * run on the container got there first.
   */
  async startRun(input: {
    readonly runId: string;
    readonly scriptId: string;
    readonly containerId: string;
    readonly serverId: string;
    readonly version: number;
    readonly versionId: string;
    readonly deadlineSeconds: number;
  }, tx: Tx): Promise<StartedRun | null> {
    const target = await tx
      .selectFrom('control.container_script_targets')
      .select(['attempts', 'trigger', 'boot_id'])
      .where('script_id', '=', input.scriptId)
      .where('container_id', '=', input.containerId)
      .where('state', '=', 'pending')
      .where('target_version', '=', input.version)
      .where((expression) => expression.or([
        expression('next_attempt_at', 'is', null),
        expression('next_attempt_at', '<=', now),
      ]))
      .forUpdate()
      .executeTakeFirst();
    if (!target) return null;
    const busy = await tx
      .selectFrom('control.container_script_runs')
      .select('id')
      .where('container_id', '=', input.containerId)
      .where('status', '=', 'running')
      .executeTakeFirst();
    if (busy) return null;
    const attempt = target.attempts + 1;
    const trigger = target.trigger ?? 'now';
    await tx.insertInto('control.container_script_runs').values({
      id: input.runId,
      script_id: input.scriptId,
      version_id: input.versionId,
      version: input.version,
      container_id: input.containerId,
      server_id: input.serverId,
      trigger,
      attempt,
      boot_id: null,
      status: 'running',
      deadline_at: sql<Date>`clock_timestamp() + make_interval(secs => ${input.deadlineSeconds})`,
    }).execute();
    await tx
      .updateTable('control.container_script_targets')
      .set({ state: 'running', attempts: attempt, last_run_id: input.runId, updated_at: now })
      .where('script_id', '=', input.scriptId)
      .where('container_id', '=', input.containerId)
      .execute();
    return { runId: input.runId, attempt, trigger, targetBootId: target.boot_id };
  }

  async recordRunBoot(runId: string, bootId: string | null): Promise<void> {
    await this.database
      .updateTable('control.container_script_runs')
      .set({ boot_id: bootId })
      .where('id', '=', runId)
      .execute();
  }

  /**
   * Undoes a start that never reached the guest (the container was not
   * running, the agent was gone): the run disappears and the attempt does not
   * count; the target waits `retrySeconds` before it is due again.
   */
  async abandonRun(runId: string, retrySeconds: number, tx: Tx): Promise<void> {
    const run = await tx
      .deleteFrom('control.container_script_runs')
      .where('id', '=', runId)
      .where('status', '=', 'running')
      .returning(['script_id', 'container_id'])
      .executeTakeFirst();
    if (!run) return;
    await tx
      .updateTable('control.container_script_targets')
      .set((expression) => ({
        state: 'pending',
        attempts: sql<number>`greatest(${expression.ref('attempts')} - 1, 0)`,
        next_attempt_at: sql<Date>`clock_timestamp() + make_interval(secs => ${retrySeconds})`,
        updated_at: now,
      }))
      .where('script_id', '=', run.script_id)
      .where('container_id', '=', run.container_id)
      .where('state', '=', 'running')
      .execute();
  }

  /** Records the outcome; null when the run was already finished (or is gone). */
  async markRunFinished(runId: string, outcome: {
    readonly status: Exclude<ContainerScriptRunStatusColumn, 'running'>;
    readonly exitCode: number | null;
    readonly output: string;
    readonly error: string | null;
    readonly bootId?: string | null;
  }, tx: Tx): Promise<FinishedRunRow | null> {
    const row = await tx
      .updateTable('control.container_script_runs')
      .set((expression) => ({
        status: outcome.status,
        exit_code: outcome.exitCode,
        output: outcome.output,
        error: outcome.error,
        boot_id: outcome.bootId === undefined ? expression.ref('boot_id') : outcome.bootId,
        finished_at: now,
      }))
      .where('id', '=', runId)
      .where('status', '=', 'running')
      .returning(['script_id', 'version', 'container_id', 'server_id', 'boot_id', 'status'])
      .executeTakeFirst();
    return row ?? null;
  }

  async lockTarget(scriptId: string, containerId: string, tx: Tx) {
    return tx
      .selectFrom('control.container_script_targets')
      .select(['state', 'attempts', 'rerun', 'boot_id', 'target_version', 'last_run_id'])
      .where('script_id', '=', scriptId)
      .where('container_id', '=', containerId)
      .forUpdate()
      .executeTakeFirst();
  }

  async updateTargetAfterRun(scriptId: string, containerId: string, next: TargetAfterFinish, tx: Tx): Promise<void> {
    await tx
      .updateTable('control.container_script_targets')
      .set({
        state: next.state,
        attempts: next.attempts,
        next_attempt_at: next.nextAttemptAt,
        rerun: false,
        updated_at: now,
        ...(next.succeededVersion === undefined ? {} : { succeeded_version: next.succeededVersion }),
        ...(next.bootId === undefined ? {} : { boot_id: next.bootId }),
        ...(next.trigger === undefined ? {} : { trigger: next.trigger }),
        ...(next.targetVersion === undefined ? {} : { target_version: next.targetVersion }),
      })
      .where('script_id', '=', scriptId)
      .where('container_id', '=', containerId)
      .execute();
  }

  /** A container that left the scope while it ran: its target goes once the run is over. */
  async dropIfOutOfScope(scriptId: string, containerId: string, tx: Tx): Promise<void> {
    await sql`
      DELETE FROM control.container_script_targets AS t
      USING control.container_scripts AS s, control.container_script_versions AS v, control.containers AS c
      WHERE t.script_id = ${scriptId} AND t.container_id = ${containerId} AND t.state <> 'running'
        AND s.id = t.script_id AND v.script_id = s.id AND v.version = s.current_version
        AND c.id = t.container_id AND NOT ${scopeMatchSql('v', 'c')}
    `.execute(tx);
  }

  /**
   * Distinct containers whose run of the version failed or timed out since
   * `since` (interrupted runs are reboots and restarts, not the script's
   * fault), containers that started it, and runs still going.
   */
  async versionOutcomes(scriptId: string, version: number, since: Date, tx: Tx) {
    const row = await tx
      .selectFrom('control.container_script_runs')
      .select([
        sql<number>`count(DISTINCT container_id) FILTER (
          WHERE status IN ('failed', 'timed_out') AND finished_at >= ${since}
        )::int`.as('failed_containers'),
        sql<number>`count(DISTINCT container_id)::int`.as('started_containers'),
        sql<number>`count(*) FILTER (WHERE status = 'running')::int`.as('running_runs'),
      ])
      .where('script_id', '=', scriptId)
      .where('version', '=', version)
      .executeTakeFirstOrThrow();
    return {
      failedContainers: Number(row.failed_containers),
      startedContainers: Number(row.started_containers),
      runningRuns: Number(row.running_runs),
    };
  }

  async runningRuns(): Promise<RunningRunRow[]> {
    return this.database
      .selectFrom('control.container_script_runs as r')
      .innerJoin('control.containers as c', 'c.id', 'r.container_id')
      .select(['r.id', 'r.script_id', 'r.version', 'r.container_id', 'r.server_id', 'r.boot_id', 'r.deadline_at', 'c.instance_name'])
      .where('r.status', '=', 'running')
      .execute();
  }

  /** Keeps the newest CONTAINER_SCRIPT_RUNS_KEPT finished runs per (script, container). */
  async pruneRuns(): Promise<number> {
    const result = await sql`
      DELETE FROM control.container_script_runs AS r
      USING (
        SELECT id, row_number() OVER (PARTITION BY script_id, container_id ORDER BY started_at DESC, id DESC) AS rank
        FROM control.container_script_runs
        WHERE status <> 'running'
      ) AS ranked
      WHERE r.id = ranked.id AND ranked.rank > ${CONTAINER_SCRIPT_RUNS_KEPT}
    `.execute(this.database);
    return Number(result.numAffectedRows ?? 0);
  }
}
