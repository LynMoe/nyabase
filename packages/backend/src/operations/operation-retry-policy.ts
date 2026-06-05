export interface RetryDecision {
  retry: boolean;
  nextAttemptAt: Date | null;
  terminal: boolean;
  reason: string;
}

export interface RetryPolicyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

export function classifyRetry(
  error: unknown,
  attempts: number,
  options: RetryPolicyOptions = {},
): RetryDecision {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (attempts >= maxAttempts) {
    return {
      retry: false,
      nextAttemptAt: null,
      terminal: true,
      reason: 'max_attempts_exhausted',
    };
  }

  const message = errorMessage(error).toLowerCase();
  const transient =
    message.includes('offline') ||
    message.includes('timeout') ||
    message.includes('disconnect') ||
    message.includes('econnreset') ||
    message.includes('temporarily') ||
    message.includes('busy') ||
    message.includes('locked');

  if (!transient) {
    return {
      retry: false,
      nextAttemptAt: null,
      terminal: true,
      reason: 'non_transient_error',
    };
  }

  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempts - 1));

  return {
    retry: true,
    nextAttemptAt: new Date(Date.now() + delayMs),
    terminal: false,
    reason: 'transient_error',
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
