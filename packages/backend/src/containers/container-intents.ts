import { IntentKind } from '@nyabase/common';
import type {
  CreatePendingIntentInput,
  IntentExecutor,
  IntentRecord,
  IntentRepository,
  PhysicalSettlement,
} from '../reconcile/intent.repository.js';

export function isRestartIntent(
  kind: string,
  request: Record<string, unknown> | null | undefined,
): boolean {
  return kind === IntentKind.ContainerPower && request?.action === 'restart';
}

/**
 * A restart is proven by the instance start time moving past the baseline
 * recorded at request time, so a restart must carry exactly that baseline and
 * no other container intent may carry one.
 */
export function assertContainerIntentBaseline(
  input: Pick<CreatePendingIntentInput, 'kind' | 'request' | 'baseline'>,
): void {
  if (!isRestartIntent(input.kind, input.request)) {
    if (input.baseline) throw new Error('Only restart intents may carry a baseline');
    return;
  }
  const baseline = input.baseline;
  if (
    !baseline
    || Object.keys(baseline).some((key) => key !== 'startedAt')
    || !Object.prototype.hasOwnProperty.call(baseline, 'startedAt')
    || (baseline.startedAt !== null && typeof baseline.startedAt !== 'string')
  ) {
    throw new Error('Restart intents require a startedAt baseline');
  }
}

export async function createContainerIntent(
  intents: Pick<IntentRepository, 'createPending'>,
  input: CreatePendingIntentInput,
  executor?: IntentExecutor,
): Promise<IntentRecord> {
  assertContainerIntentBaseline(input);
  return intents.createPending(input, executor);
}

/**
 * Settles a finished container intent. A restart settles only itself (and its
 * success settles the older desired-state intents it covers); a later
 * desired-state revision that succeeds must never settle a pending restart,
 * because only the restart's own start-time proof can.
 */
export async function settleContainerIntent(
  intents: Pick<IntentRepository, 'settleOne' | 'settleForObservedRevision'>,
  intent: IntentRecord,
  observedRevision: number,
  settlement: PhysicalSettlement,
): Promise<void> {
  if (isRestartIntent(intent.kind, intent.request)) {
    await intents.settleOne(intent.id, settlement);
    if (settlement.outcome !== 'succeeded') return;
  }
  await intents.settleForObservedRevision(
    intent.resourceType,
    intent.resourceId,
    observedRevision,
    settlement,
    undefined,
    { keep: (candidate) => isRestartIntent(candidate.kind, candidate.request) },
  );
}
