import type {
  ContainerScriptPauseReason,
  ContainerScriptRunStatus,
  ContainerScriptTrigger,
} from '@nyabase/common';
import type { ContainerScriptTargetStateColumn } from '../platform/persistence-pg/container-scripts-database.types.js';
import { GUEST_NO_RESULT_EXIT } from './container-script-wrapper.js';

/*
 * The decisions of the script scheduler that do not need the database: what a
 * finished run does to its container's target row, how long a failed attempt
 * waits, and when a script pauses itself.
 */

/** Seconds a failed attempt waits before the next one: 1 min, 5 min, then 15 min. */
export function retryDelaySeconds(attemptsMade: number): number {
  if (attemptsMade <= 1) return 60;
  if (attemptsMade === 2) return 300;
  return 900;
}

/** A run's status from what the wrapper left in the guest. */
export function runStatusFromGuest(result: { readonly rc: number | null; readonly timedOut: boolean }): {
  readonly status: Exclude<ContainerScriptRunStatus, 'running'>;
  readonly exitCode: number | null;
  readonly error: string | null;
} {
  if (result.rc === null) {
    return { status: 'interrupted', exitCode: null, error: 'The run ended without a result' };
  }
  if (result.timedOut) return { status: 'timed_out', exitCode: result.rc, error: null };
  if (result.rc === GUEST_NO_RESULT_EXIT) {
    return { status: 'failed', exitCode: result.rc, error: 'The script ended without an exit code' };
  }
  return { status: result.rc === 0 ? 'succeeded' : 'failed', exitCode: result.rc, error: null };
}

export interface FinishedRun {
  readonly status: Exclude<ContainerScriptRunStatus, 'running'>;
  readonly version: number;
  readonly bootId: string | null;
}

export interface TargetBeforeFinish {
  /** Attempts including the one that just ended. */
  readonly attempts: number;
  readonly rerun: boolean;
}

export interface TargetAfterFinish {
  readonly state: Exclude<ContainerScriptTargetStateColumn, 'running' | 'exempt' | 'skipped'>;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  /** Set only when it changes. */
  readonly succeededVersion?: number;
  readonly bootId?: string | null;
  readonly trigger?: ContainerScriptTrigger;
  readonly targetVersion?: number;
}

/**
 * Where a container stands with a script after one of its runs ended.
 *
 * - every boot, and the container booted again meanwhile: due for the new boot
 *   (the interrupted attempt does not count);
 * - success: done, unless a version with applyNow was published meanwhile
 *   (`rerun`), which makes it due again for that version;
 * - failure: due again after a backoff until the attempts are used up, then
 *   failed; with `rerun` it is due again at once with fresh attempts.
 */
export function targetAfterRun(input: {
  readonly everyBoot: boolean;
  readonly run: FinishedRun;
  readonly target: TargetBeforeFinish;
  readonly maxAttempts: number;
  readonly currentVersion: number;
  /** The boot the container is in now, when it is known to be running. */
  readonly currentBootId: string | null;
  readonly now: Date;
}): TargetAfterFinish {
  const { run, target } = input;
  if (input.everyBoot && input.currentBootId !== null && input.currentBootId !== run.bootId) {
    return {
      state: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      bootId: input.currentBootId,
      trigger: 'boot',
      targetVersion: input.currentVersion,
    };
  }
  if (run.status === 'succeeded') {
    const succeededVersion = input.everyBoot ? undefined : run.version;
    if (target.rerun) {
      return { state: 'pending', attempts: 0, nextAttemptAt: null, trigger: 'now', targetVersion: input.currentVersion, ...(succeededVersion === undefined ? {} : { succeededVersion }) };
    }
    return { state: 'succeeded', attempts: target.attempts, nextAttemptAt: null, ...(succeededVersion === undefined ? {} : { succeededVersion }) };
  }
  if (target.rerun) {
    return { state: 'pending', attempts: 0, nextAttemptAt: null, trigger: 'now', targetVersion: input.currentVersion };
  }
  if (target.attempts < input.maxAttempts) {
    return {
      state: 'pending',
      attempts: target.attempts,
      nextAttemptAt: new Date(input.now.getTime() + retryDelaySeconds(target.attempts) * 1_000),
    };
  }
  return { state: 'failed', attempts: target.attempts, nextAttemptAt: null };
}

/**
 * Whether a script should pause itself now: too many containers failed its
 * current version (since the publish or the last resume), or its canary ran
 * on enough containers and none of those runs is still going.
 */
export function autoPauseReason(input: {
  readonly pauseAfterFailures: number | null;
  readonly failedContainers: number;
  readonly canaryCount: number | null;
  readonly canaryCleared: boolean;
  readonly startedContainers: number;
  readonly runningRuns: number;
}): Exclude<ContainerScriptPauseReason, 'manual'> | null {
  if (input.pauseAfterFailures !== null && input.failedContainers >= input.pauseAfterFailures) return 'failures';
  if (
    input.canaryCount !== null
    && !input.canaryCleared
    && input.startedContainers >= input.canaryCount
    && input.runningRuns === 0
  ) {
    return 'canary';
  }
  return null;
}

/** Whether the canary keeps a script from starting another run of its current version. */
export function canaryHolds(input: {
  readonly canaryCount: number | null;
  readonly canaryCleared: boolean;
  readonly startedContainers: number;
}): boolean {
  return input.canaryCount !== null && !input.canaryCleared && input.startedContainers >= input.canaryCount;
}
