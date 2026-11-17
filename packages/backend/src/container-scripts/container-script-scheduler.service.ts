import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AuditAction } from '@nyabase/common';
import { AuditService } from '../iam/audit.service.js';
import { AgentRegistry } from '../incus/agent-registry.service.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import { deriveInstanceName } from '../incus/index.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { lockContainerScripts } from '../platform/persistence-pg/advisory-locks.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { ReconcileWakeService, type ReconcileWakePayload } from '../reconcile/reconcile-wake.service.js';
import { observeServer } from './container-script-observer.js';
import { ContainerScriptReadModel } from './container-script-read-model.js';
import { autoPauseReason, canaryHolds, targetAfterRun } from './container-script-rules.js';
import {
  executeRun,
  watchRun,
  type RunnerDeps,
  type RunResult,
  type RunSpec,
} from './container-script-runner.js';
import {
  ContainerScriptTargetsRepository,
  type CandidateRow,
  type RunningRunRow,
} from './container-script-targets.repository.js';
import { GUEST_BOOT_WAIT_SECONDS, GUEST_KILL_AFTER_SECONDS, guestRunDirectory } from './container-script-wrapper.js';
import { ContainerScriptsRepository, type VersionRow } from './container-scripts.repository.js';

const PASS_INTERVAL_MS = 30_000;
const FULL_OBSERVE_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 10 * 60_000;
const WAKE_DEBOUNCE_MS = 500;
const CANDIDATE_LIMIT = 500;
/** Seconds a run may take beyond its timeout: boot wait, file push, kill grace, slack. */
const RUN_OVERHEAD_SECONDS = GUEST_BOOT_WAIT_SECONDS + GUEST_KILL_AFTER_SECONDS + 180;
/** A start that never reached the guest waits this long before it is tried again. */
const ABANDON_RETRY_SECONDS = 30;
/** Uploads not referenced by any version are kept this long (a publish may still name them). */
const BLOB_GRACE_MS = 24 * 60 * 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs container scripts. One pass:
 *
 *  1. observes instances (status and boot, `listInstances(1)` per server):
 *     servers named by a wake, and every server once a minute;
 *  2. adds new containers to scripts that take them and makes every-boot
 *     targets due for boots they have not seen;
 *  3. resumes watching runs this process does not track (after a restart);
 *  4. starts due targets in priority order, within the global, per-server,
 *     per-script and canary limits (the candidate query already leaves at
 *     most one target per idle, running container).
 *
 * Passes run on wakes (script writes, container intents and Incus events
 * through ReconcileWakeService, finished runs) and every 30 s. Runs execute
 * in the background; a finished run updates its target and may pause the
 * script (canary done, too many failures).
 */
@Injectable()
export class ContainerScriptScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ContainerScriptScheduler.name);
  private readonly controller = new AbortController();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly dirtyServers = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private processing: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private lastFullObserve = 0;
  private lastPrune = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly runner: RunnerDeps;

  constructor(
    private readonly scripts: ContainerScriptsRepository,
    private readonly targets: ContainerScriptTargetsRepository,
    private readonly read: ContainerScriptReadModel,
    private readonly transactions: PgTransactionManager,
    private readonly audit: AuditService,
    private readonly config: NyabaseConfigService,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
    private readonly agents: AgentRegistry,
    private readonly reconcileWake: ReconcileWakeService,
  ) {
    this.runner = {
      client: (serverId) => this.clients.get(serverId),
      blob: async (sha256) => {
        const content = await this.scripts.blobContent(sha256);
        if (!content) throw new Error(`File content ${sha256} is missing`);
        return content;
      },
      recordBoot: (runId, bootId) => this.targets.recordRunBoot(runId, bootId),
      sleep: (ms, signal) => delay(ms, undefined, { signal }),
      now: () => Date.now(),
    };
  }

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.unsubscribe = this.reconcileWake.onWake((payload) => this.onReconcileWake(payload));
    this.scheduleNext();
    this.wake();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.timer = null;
    this.wakeTimer = null;
    // Runs stay `running` in the database; the next process resumes watching them.
    this.controller.abort();
    await this.processing;
    await Promise.allSettled([...this.inflight.values()]);
  }

  /** Requests a pass soon; `serverId` also re-observes that server's instances. */
  wake(serverId?: string): void {
    if (serverId) this.dirtyServers.add(serverId);
    if (this.stopped || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.process();
    }, WAKE_DEBOUNCE_MS);
    this.wakeTimer.unref?.();
  }

  /** One pass now (concurrent calls coalesce into one more pass); for tests and wakes. */
  async process(): Promise<void> {
    if (this.stopped) return;
    if (this.processing) {
      this.again = true;
      return this.processing;
    }
    const processing = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again && !this.stopped);
    })();
    this.processing = processing;
    try {
      await processing;
    } finally {
      if (this.processing === processing) this.processing = null;
    }
  }

  /** Waits for the runs in progress (tests). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0 || this.processing) {
      await Promise.allSettled([...this.inflight.values(), this.processing]);
    }
  }

  private onReconcileWake(payload: ReconcileWakePayload): void {
    if (payload.reason === 'scan') this.lastFullObserve = 0;
    if (payload.reason === 'disconnected') return;
    // Container intents (create, start, stop) and Incus lifecycle events change what runs where.
    if (payload.serverId && (payload.resourceType === undefined || payload.resourceType === 'container')) {
      this.wake(payload.serverId);
    } else if (payload.reason === 'scan') {
      this.wake();
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
      this.scheduleNext();
    }, PASS_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async pass(): Promise<void> {
    try {
      await this.observe();
      await this.transactions.run(async (tx) => {
        await lockContainerScripts(tx);
        await this.targets.addNewContainers(tx);
        await this.targets.applyBoots(tx);
      });
      await this.resumeUntracked();
      await this.prune();
      await this.startDue();
    } catch (error) {
      if (!this.stopped) this.logger.error(`Container script pass failed: ${errorText(error)}`);
    }
  }

  private async observe(): Promise<void> {
    const full = Date.now() - this.lastFullObserve >= FULL_OBSERVE_INTERVAL_MS;
    const servers = full ? await this.clients.listServerIds() : [...this.dirtyServers];
    this.dirtyServers.clear();
    if (full) this.lastFullObserve = Date.now();
    await Promise.all(servers.filter((serverId) => this.agents.isConnected(serverId)).map(async (serverId) => {
      try {
        const observations = await observeServer(
          await this.clients.get(serverId),
          await this.read.containersOnServer(serverId),
          this.controller.signal,
        );
        await this.transactions.run(async (tx) => {
          await lockContainerScripts(tx);
          await this.targets.recordObservations(serverId, observations, tx);
        });
      } catch (error) {
        if (!this.stopped) this.logger.warn(`Observing instances on server ${serverId} failed: ${errorText(error)}`);
      }
    }));
  }

  private async prune(): Promise<void> {
    if (Date.now() - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.lastPrune = Date.now();
    await this.targets.pruneRuns();
    await this.scripts.deleteUnreferencedBlobs(new Date(Date.now() - BLOB_GRACE_MS));
  }

  // --- starting --------------------------------------------------------------------

  private async startDue(): Promise<void> {
    const candidates = await this.targets.candidates(CANDIDATE_LIMIT);
    if (candidates.length === 0) return;
    const limits = {
      global: this.config.get<number>('containerScripts.maxConcurrent'),
      perServer: this.config.get<number>('containerScripts.maxConcurrentPerServer'),
    };
    const counts = { total: 0, server: new Map<string, number>(), script: new Map<string, number>(), scriptServer: new Map<string, number>() };
    const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
    for (const row of await this.targets.runningCounts()) {
      counts.total += row.count;
      counts.server.set(row.server_id, (counts.server.get(row.server_id) ?? 0) + row.count);
      counts.script.set(row.script_id, (counts.script.get(row.script_id) ?? 0) + row.count);
      counts.scriptServer.set(`${row.script_id}:${row.server_id}`, row.count);
    }
    const canaries = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      if (this.stopped || counts.total >= limits.global) break;
      const scriptServer = `${candidate.script_id}:${candidate.server_id}`;
      if ((counts.server.get(candidate.server_id) ?? 0) >= limits.perServer) continue;
      if (candidate.max_parallel !== null && (counts.script.get(candidate.script_id) ?? 0) >= candidate.max_parallel) continue;
      if (candidate.max_parallel_per_server !== null && (counts.scriptServer.get(scriptServer) ?? 0) >= candidate.max_parallel_per_server) continue;
      if (candidate.canary_count !== null && !candidate.canary_cleared) {
        const key = `${candidate.script_id}:${candidate.target_version}`;
        let started = canaries.get(key);
        if (!started) {
          started = await this.targets.startedContainers(candidate.script_id, candidate.target_version);
          canaries.set(key, started);
        }
        if (!started.has(candidate.container_id) && canaryHolds({
          canaryCount: candidate.canary_count,
          canaryCleared: candidate.canary_cleared,
          startedContainers: started.size,
        })) {
          continue;
        }
        started.add(candidate.container_id);
      }
      if (!(await this.start(candidate))) continue;
      counts.total += 1;
      bump(counts.server, candidate.server_id);
      bump(counts.script, candidate.script_id);
      bump(counts.scriptServer, scriptServer);
    }
  }

  private async start(candidate: CandidateRow): Promise<boolean> {
    const [script, version, container] = await Promise.all([
      this.scripts.findScript(candidate.script_id),
      this.scripts.findVersion(candidate.script_id, candidate.target_version),
      this.read.runContainerContext(candidate.container_id),
    ]);
    if (!script || !version || !container) return false;
    const runId = randomUUID();
    const deadlineSeconds = version.timeout_seconds + RUN_OVERHEAD_SECONDS;
    let started;
    try {
      started = await this.transactions.run(async (tx) => {
        await lockContainerScripts(tx);
        return this.targets.startRun({
          runId,
          scriptId: candidate.script_id,
          containerId: candidate.container_id,
          serverId: candidate.server_id,
          version: candidate.target_version,
          versionId: candidate.version_id,
          deadlineSeconds,
        }, tx);
      });
    } catch (error) {
      this.logger.warn(`Starting container script ${script.name} on ${container.container_name} failed: ${errorText(error)}`);
      return false;
    }
    if (!started) return false;
    const files = await this.scripts.listFiles(candidate.script_id, candidate.target_version);
    const spec: RunSpec = {
      runId,
      serverId: candidate.server_id,
      instanceName: container.instance_name ?? deriveInstanceName(candidate.container_id),
      timeoutSeconds: version.timeout_seconds,
      script: version.script,
      files: files.map((file) => ({
        name: file.name,
        sha256: file.sha256,
        destination: file.destination_path === null
          ? null
          : {
            path: file.destination_path,
            mode: (file.destination_mode ?? 0o644).toString(8).padStart(4, '0'),
            owner: file.destination_owner ?? 'root',
          },
      })),
      environment: {
        NYABASE_SCRIPT_ID: script.id,
        NYABASE_SCRIPT_NAME: script.name,
        NYABASE_SCRIPT_VERSION: String(version.version),
        NYABASE_RUN_ID: runId,
        NYABASE_TRIGGER: started.trigger,
        NYABASE_ATTEMPT: String(started.attempt),
        NYABASE_FILES_DIR: `${guestRunDirectory(runId)}/files`,
        NYABASE_CONTAINER_ID: candidate.container_id,
        NYABASE_CONTAINER_NAME: container.container_name,
        NYABASE_SERVER_NAME: container.server_name,
        NYABASE_OWNER: container.owner_username,
        NYABASE_LOGIN_USER: container.login_user,
      },
      expectedBootId: candidate.every_boot ? started.targetBootId : null,
      deadline: new Date(Date.now() + deadlineSeconds * 1_000),
    };
    this.track(runId, () => executeRun(this.runner, spec, this.controller.signal));
    return true;
  }

  // --- finishing -------------------------------------------------------------------

  /** Runs `work` in the background and records its result. */
  private track(runId: string, work: () => Promise<RunResult>): void {
    const task = (async () => {
      let result: RunResult;
      try {
        result = await work();
      } catch (error) {
        // Shutting down: the run stays running and the next process resumes it.
        if (this.stopped) return;
        result = { kind: 'finished', status: 'interrupted', exitCode: null, output: '', error: errorText(error), bootId: null };
      }
      try {
        if (result.kind === 'abandoned') {
          await this.transactions.run(async (tx) => {
            await lockContainerScripts(tx);
            await this.targets.abandonRun(runId, ABANDON_RETRY_SECONDS, tx);
          });
        } else {
          await this.finish(runId, result);
        }
      } catch (error) {
        this.logger.error(`Recording container script run ${runId} failed: ${errorText(error)}`);
      }
    })().finally(() => {
      this.inflight.delete(runId);
      this.wake();
    });
    this.inflight.set(runId, task);
  }

  private async finish(runId: string, result: Extract<RunResult, { kind: 'finished' }>): Promise<void> {
    await this.transactions.run(async (tx) => {
      await lockContainerScripts(tx);
      const run = await this.targets.markRunFinished(runId, {
        status: result.status,
        exitCode: result.exitCode,
        output: result.output,
        error: result.error,
        ...(result.bootId === null ? {} : { bootId: result.bootId }),
      }, tx);
      if (!run) return;
      const script = await this.scripts.findScriptForUpdate(run.script_id, tx);
      if (!script) return;
      const target = await this.targets.lockTarget(run.script_id, run.container_id, tx);
      if (target && target.state === 'running' && target.last_run_id === runId) {
        const version = await this.scripts.findVersion(run.script_id, target.target_version ?? run.version, tx);
        const observed = await this.targets.observation(run.container_id, tx);
        const next = targetAfterRun({
          everyBoot: script.every_boot,
          run: { status: result.status, version: run.version, bootId: run.boot_id },
          target: { attempts: target.attempts, rerun: target.rerun },
          maxAttempts: version?.max_attempts ?? 1,
          currentVersion: script.current_version,
          currentBootId: observed?.instance_status === 'running' ? observed.boot_id : null,
          now: new Date(),
        });
        await this.targets.updateTargetAfterRun(run.script_id, run.container_id, next, tx);
        await this.targets.dropIfOutOfScope(run.script_id, run.container_id, tx);
      }
      if (script.status !== 'active' || run.version !== script.current_version) return;
      const current = await this.scripts.findVersion(script.id, script.current_version, tx);
      if (!current) return;
      await this.maybeAutoPause(script, current, tx);
    });
  }

  private async maybeAutoPause(
    script: NonNullable<Awaited<ReturnType<ContainerScriptsRepository['findScript']>>>,
    current: VersionRow,
    tx: Parameters<Parameters<PgTransactionManager['run']>[0]>[0],
  ): Promise<void> {
    const outcomes = await this.targets.versionOutcomes(script.id, current.version, script.failures_since, tx);
    const reason = autoPauseReason({
      pauseAfterFailures: current.pause_after_failures,
      failedContainers: outcomes.failedContainers,
      canaryCount: current.canary_count,
      canaryCleared: script.canary_cleared,
      startedContainers: outcomes.startedContainers,
      runningRuns: outcomes.runningRuns,
    });
    if (!reason) return;
    if (!(await this.scripts.updateScript(script.id, script.revision, { status: 'paused', pause_reason: reason }, tx))) return;
    await this.audit.append(tx, null, AuditAction.AutoPauseContainerScript, script.id, 'container_script', {
      name: script.name,
      version: current.version,
      reason,
      ...outcomes,
    });
    this.logger.warn(`Container script ${script.name} paused itself (${reason})`);
  }

  // --- recovery --------------------------------------------------------------------

  /** Runs marked running that this process does not track: resume watching their guests. */
  private async resumeUntracked(): Promise<void> {
    for (const run of await this.targets.runningRuns()) {
      if (this.stopped || this.inflight.has(run.id)) continue;
      this.track(run.id, () => watchRun(this.runner, this.watchSpec(run), this.controller.signal));
    }
  }

  private watchSpec(run: RunningRunRow) {
    // A run already past its deadline still gets one look for a result.
    const deadline = new Date(Math.max(new Date(run.deadline_at).getTime(), Date.now() + 15_000));
    return {
      runId: run.id,
      serverId: run.server_id,
      instanceName: run.instance_name ?? deriveInstanceName(run.container_id),
      bootId: run.boot_id,
      deadline,
    };
  }
}
