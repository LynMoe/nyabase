import { IncusError, readAfterTimeout, requestAndWait } from '../incus/index.js';
import type { ReconcileRunContext } from '../reconcile/managed-reconciler.js';
import {
  powerTransition,
  restartTransition,
  running,
  type ContainerRow,
  type InstanceState,
} from './container-reconcile-support.js';

/** Start or stop the instance so its power state matches the desired power intent. */
export async function reconcilePower(
  context: ReconcileRunContext,
  row: ContainerRow,
  name: string,
  currentState: InstanceState,
): Promise<void> {
  if (context.intent.kind === 'container.power' && context.intent.request?.action === 'restart') {
    return;
  }
  const transition = powerTransition(currentState.status, row.power_intent);
  if (transition === 'none') return;
  await readAfterTimeout(
    () => requestAndWait(
      context.client!,
      (options) => context.client!.updateInstanceState(
        name,
        { action: transition, force: transition === 'stop' },
        options,
      ),
    ),
    async () => {
      const after = (await context.client!.getInstanceState(name)).metadata;
      const afterRunning = running(after);
      if ((transition === 'start' && afterRunning) || (transition === 'stop' && !afterRunning)) {
        return undefined;
      }
      throw new Error('INSTANCE_POWER_NOT_CONFIRMED');
    },
  );
}

/** Restart, proven by a changed `started_at` against the baseline recorded at request time. */
export async function reconcileRestart(
  context: ReconcileRunContext,
  name: string,
  currentState: InstanceState,
): Promise<void> {
  if (context.intent.kind !== 'container.power' || context.intent.request?.action !== 'restart') {
    return;
  }
  const baseline = context.intent.baseline;
  if (!baseline || !Object.prototype.hasOwnProperty.call(baseline, 'startedAt')) {
    throw new IncusError('RESTART_BASELINE_MISSING', 'managed_failure');
  }
  const baselineStartedAt = baseline.startedAt === null ? null : String(baseline.startedAt);
  const currentStartedAt = currentState.started_at ?? null;
  if (restartTransition(currentStartedAt, baselineStartedAt, currentState.status) === 'proven') {
    return;
  }
  await readAfterTimeout(
    () => requestAndWait(
      context.client!,
      (options) => context.client!.updateInstanceState(
        name,
        { action: 'restart', force: true },
        options,
      ),
    ),
    async () => {
      const after = (await context.client!.getInstanceState(name)).metadata;
      if (
        running(after)
        && after.started_at
        && after.started_at !== baselineStartedAt
      ) {
        return undefined;
      }
      throw new Error('INSTANCE_RESTART_NOT_CONFIRMED');
    },
  );
  const verified = await context.client!.getInstanceState(name);
  const nextStartedAt = verified.metadata.started_at ?? null;
  if (
    !running(verified.metadata)
    || nextStartedAt === null
    || nextStartedAt === baselineStartedAt
  ) {
    throw new IncusError('RESTART_PROOF_MISSING', 'managed_failure', {
      baselineStartedAt: baselineStartedAt ?? '',
      observedStartedAt: nextStartedAt ?? '',
    });
  }
}
