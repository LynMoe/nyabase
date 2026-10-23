import {
  IncusError,
  matchBusyInstanceError,
  type IncusClientPort,
  type IncusFailureCode,
} from '../incus/index.js';
import type { IntentFailure } from './intent.repository.js';

/* Pure helpers and tuning constants of the reconcile worker. */

export function asFailure(error: unknown): IntentFailure {
  if (error instanceof IncusError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details as Record<string, unknown>,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'RECONCILE_FAILURE',
    message: message.slice(0, 4096),
    details: {},
  };
}

export function isIncusInstanceLockBusy(failure: IntentFailure): boolean {
  if (failure.code !== 'INSTANCE_BUSY') return false;
  const reason = failure.details?.reason;
  if (reason === 'sshd_not_listening' || reason === 'guest_network_instance_not_ready') {
    return false;
  }
  const action = failure.details?.action;
  if (typeof action === 'string' && action.length > 0) return true;
  const errorText = failure.details?.error;
  return typeof errorText === 'string' && matchBusyInstanceError(errorText) !== undefined;
}

export function isIncusError(error: unknown, code: IncusFailureCode): boolean {
  return error instanceof IncusError && error.code === code;
}

export function boundedRetryDelay(attemptCount: number): number {
  const exponent = Math.min(6, Math.max(0, attemptCount));
  return Math.min(60_000, 1_000 * (2 ** exponent));
}

export const MAX_BACKGROUND_ERROR_LENGTH = 512;
export const QUEUE_PAGE_SIZE = 100;
/** Pages one queue pass drains before yielding; a full pass asks for a rerun. */
export const QUEUE_MAX_PAGES = 20;
export const INTENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const INTENT_PRUNE_INTERVAL_MS = 60 * 60_000;
export const INTENT_PRUNE_MAX_BATCHES = 20;
export const BUSY_STRIKE_WINDOW_MS = 300_000;
export const BUSY_STRIKE_LIMIT = 5;

export function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_BACKGROUND_ERROR_LENGTH
    ? `${message.slice(0, MAX_BACKGROUND_ERROR_LENGTH - 3)}...`
    : message;
}

/**
 * The client handed to a reconciler, recording whether any Incus call was
 * answered: only a pass that actually talked to the server may mark it online.
 */
export function trackedClient(client: IncusClientPort): { client: IncusClientPort; used: () => boolean } {
  let used = false;
  const proxy = new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        if (result instanceof Promise) {
          // Only an answered request counts; a SERVER_UNREACHABLE rejection does not.
          return result.then((answer: unknown) => {
            used = true;
            return answer;
          });
        }
        used = true;
        return result;
      };
    },
  });
  return { client: proxy, used: () => used };
}

export function isClosedDatabaseDriverError(error: unknown): boolean {
  const message = boundedErrorMessage(error).toLowerCase();
  return message.includes('driver has already been destroyed')
    || message.includes('driver has already been closed')
    || message.includes('pool has already been closed')
    || message.includes('connection has already been closed');
}

export function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError'
    || error.message === 'The operation was aborted'
    || error.message === 'The operation was aborted.';
}
