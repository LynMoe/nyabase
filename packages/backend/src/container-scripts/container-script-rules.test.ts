import { describe, expect, it } from 'vitest';
import {
  autoPauseReason,
  canaryHolds,
  retryDelaySeconds,
  runStatusFromGuest,
  targetAfterRun,
} from './container-script-rules.js';
import { bootIdOf, outputText } from './container-script-runner.js';

const now = new Date('2026-11-17T00:00:00Z');
const base = {
  everyBoot: false,
  maxAttempts: 3,
  currentVersion: 2,
  currentBootId: 'boot-1',
  now,
};

describe('targetAfterRun', () => {
  it('marks a once-script done with the version that succeeded', () => {
    expect(targetAfterRun({
      ...base,
      run: { status: 'succeeded', version: 2, bootId: 'boot-1' },
      target: { attempts: 1, rerun: false },
    })).toEqual({ state: 'succeeded', attempts: 1, nextAttemptAt: null, succeededVersion: 2 });
  });

  it('makes a container due again for a version published with applyNow while it ran', () => {
    expect(targetAfterRun({
      ...base,
      run: { status: 'succeeded', version: 1, bootId: 'boot-1' },
      target: { attempts: 1, rerun: true },
    })).toEqual({ state: 'pending', attempts: 0, nextAttemptAt: null, trigger: 'now', targetVersion: 2, succeededVersion: 1 });
    expect(targetAfterRun({
      ...base,
      run: { status: 'failed', version: 1, bootId: 'boot-1' },
      target: { attempts: 3, rerun: true },
    })).toMatchObject({ state: 'pending', attempts: 0, targetVersion: 2 });
  });

  it('backs off failed attempts and gives up after the last one', () => {
    expect(targetAfterRun({
      ...base,
      run: { status: 'timed_out', version: 2, bootId: 'boot-1' },
      target: { attempts: 2, rerun: false },
    })).toEqual({ state: 'pending', attempts: 2, nextAttemptAt: new Date(now.getTime() + 300_000) });
    expect(targetAfterRun({
      ...base,
      run: { status: 'interrupted', version: 2, bootId: 'boot-1' },
      target: { attempts: 3, rerun: false },
    })).toEqual({ state: 'failed', attempts: 3, nextAttemptAt: null });
  });

  it('starts an every-boot target over for a boot that began during the run, and never records a succeeded version', () => {
    expect(targetAfterRun({
      ...base,
      everyBoot: true,
      currentBootId: 'boot-2',
      run: { status: 'interrupted', version: 2, bootId: 'boot-1' },
      target: { attempts: 3, rerun: false },
    })).toEqual({ state: 'pending', attempts: 0, nextAttemptAt: null, bootId: 'boot-2', trigger: 'boot', targetVersion: 2 });
    expect(targetAfterRun({
      ...base,
      everyBoot: true,
      run: { status: 'succeeded', version: 2, bootId: 'boot-1' },
      target: { attempts: 1, rerun: false },
    })).toEqual({ state: 'succeeded', attempts: 1, nextAttemptAt: null });
  });
});

describe('retry delays, guest results and pauses', () => {
  it('waits 1, 5, then 15 minutes', () => {
    expect([1, 2, 3, 7].map(retryDelaySeconds)).toEqual([60, 300, 900, 900]);
  });

  it('reads what the wrapper left', () => {
    expect(runStatusFromGuest({ rc: 0, timedOut: false })).toEqual({ status: 'succeeded', exitCode: 0, error: null });
    expect(runStatusFromGuest({ rc: 3, timedOut: false })).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(runStatusFromGuest({ rc: 124, timedOut: true })).toMatchObject({ status: 'timed_out', exitCode: 124 });
    expect(runStatusFromGuest({ rc: null, timedOut: false })).toMatchObject({ status: 'interrupted' });
    expect(runStatusFromGuest({ rc: 125, timedOut: false })).toMatchObject({ status: 'failed', error: expect.any(String) });
  });

  it('pauses for failures first, then for a finished canary', () => {
    const quiet = { pauseAfterFailures: 3, failedContainers: 0, canaryCount: null, canaryCleared: false, startedContainers: 5, runningRuns: 0 };
    expect(autoPauseReason(quiet)).toBeNull();
    expect(autoPauseReason({ ...quiet, failedContainers: 3, canaryCount: 1 })).toBe('failures');
    expect(autoPauseReason({ ...quiet, canaryCount: 2 })).toBe('canary');
    expect(autoPauseReason({ ...quiet, canaryCount: 2, runningRuns: 1 })).toBeNull();
    expect(autoPauseReason({ ...quiet, canaryCount: 2, canaryCleared: true })).toBeNull();
    expect(canaryHolds({ canaryCount: 2, canaryCleared: false, startedContainers: 2 })).toBe(true);
    expect(canaryHolds({ canaryCount: 2, canaryCleared: false, startedContainers: 1 })).toBe(false);
  });
});

describe('runner helpers', () => {
  it('takes the boot id from last_used_at, never from the zero time', () => {
    expect(bootIdOf('2026-11-17T02:19:04.942928472Z')).toBe('2026-11-17T02:19:04.942928472Z');
    expect(bootIdOf('1970-01-01T00:00:00Z')).toBeNull();
    expect(bootIdOf('0001-01-01T00:00:00Z')).toBeNull();
    expect(bootIdOf(undefined)).toBeNull();
  });

  it('keeps only the end of the output and drops NUL', () => {
    expect(outputText(Buffer.from('a\u0000b'))).toBe('ab');
    expect(Buffer.byteLength(outputText(Buffer.alloc(70_000, 97)))).toBe(64 * 1024);
    expect(outputText(null)).toBe('');
  });
});
