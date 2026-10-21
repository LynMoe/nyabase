import { IntentStatus, type IntentAcceptedDto, type IntentDto } from '@nyabase/common';
import type { Api } from './api.js';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Used in the timeout message. */
  what?: string;
}

/** Calls `probe` until it returns a non-undefined value; throws on timeout. */
export async function pollUntil<T>(
  probe: () => Promise<T | undefined>,
  options: PollOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
      lastError = undefined;
    } catch (error) {
      // A probe that throws an assertion-style error is final; transient
      // network errors are retried until the deadline.
      if (error instanceof PollAbort) throw error.cause;
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.what ?? 'condition'}${detail}`);
    }
    await sleep(intervalMs);
  }
}

/** Throw from a probe to stop polling at once with `cause`. */
export class PollAbort extends Error {
  constructor(override readonly cause: Error) {
    super(cause.message);
  }
}

export class IntentFailedError extends Error {
  constructor(readonly intent: IntentDto) {
    super(`intent ${intent.id} (${intent.kind}) failed: ${JSON.stringify(intent.failure ?? intent.failureCode)}`);
  }
}

/** Waits for an accepted intent to settle. Resolves on `succeeded`, rejects on `failed`. */
export async function waitIntent(
  api: Api,
  accepted: Pick<IntentAcceptedDto, 'intentId'>,
  options: PollOptions = {},
): Promise<IntentDto> {
  return pollUntil(async () => {
    const intent = await api.get<IntentDto>(`/intents/${accepted.intentId}`);
    if (intent.status === IntentStatus.Succeeded) return intent;
    if (intent.status === IntentStatus.Failed) throw new PollAbort(new IntentFailedError(intent));
    return undefined;
  }, { timeoutMs: 300_000, what: `intent ${accepted.intentId}`, ...options });
}
