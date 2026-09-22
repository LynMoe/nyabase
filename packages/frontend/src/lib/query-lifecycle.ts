import { ApiError } from './api-error.js';

export type QueryLifecycle =
  | 'ready'
  | 'terminal'
  | 'transient-error'
  | 'permanent-error';

export interface PollableQueryState<T> {
  data?: T;
  error?: unknown;
  fetchFailureCount?: number;
}

const PERMANENT_QUERY_STATUSES = new Set([400, 401, 403, 404]);

export function queryErrorStatus(error: unknown): number | null {
  if (error instanceof ApiError) return error.status;
  if (!error || typeof error !== 'object') return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

export function isPermanentQueryError(error: unknown): boolean {
  const status = queryErrorStatus(error);
  return status !== null && PERMANENT_QUERY_STATUSES.has(status);
}

export function classifyQueryLifecycle<T>(
  state: PollableQueryState<T>,
  isTerminal?: (data: T) => boolean,
): QueryLifecycle {
  if (state.data !== undefined && isTerminal?.(state.data)) return 'terminal';
  if (state.error !== undefined && state.error !== null) {
    return isPermanentQueryError(state.error) ? 'permanent-error' : 'transient-error';
  }
  return 'ready';
}

export function boundedPollBackoff(
  failureCount: number,
  baseIntervalMs: number,
  maxIntervalMs: number,
): number {
  const safeFailureCount = Math.max(1, Math.min(16, Math.trunc(failureCount) || 1));
  return Math.min(maxIntervalMs, baseIntervalMs * (2 ** (safeFailureCount - 1)));
}

export function queryPollInterval<T>(
  state: PollableQueryState<T>,
  options: {
    activeIntervalMs: number | false;
    transientBaseIntervalMs?: number;
    transientMaxIntervalMs?: number;
    isTerminal?: (data: T) => boolean;
  },
): number | false {
  const lifecycle = classifyQueryLifecycle(state, options.isTerminal);
  if (lifecycle === 'terminal' || lifecycle === 'permanent-error') return false;
  if (lifecycle === 'transient-error') {
    return boundedPollBackoff(
      state.fetchFailureCount ?? 1,
      options.transientBaseIntervalMs ?? Math.max(1_000, options.activeIntervalMs || 1_000),
      options.transientMaxIntervalMs ?? Math.max(30_000, options.activeIntervalMs || 1_000),
    );
  }
  return options.activeIntervalMs;
}

export const IN_PROGRESS_INTERVAL_MS = 5_000;

export function refetchWhileInProgress<T>(
  state: PollableQueryState<T>,
  options: {
    /** false: stop once settled. A number: return to the steady keepalive interval. */
    steadyIntervalMs: number | false;
    inProgressIntervalMs?: number;
    isSettled: (data: T) => boolean;
  },
): number | false {
  const settled = state.data !== undefined && options.isSettled(state.data);
  return queryPollInterval(state, {
    activeIntervalMs: settled
      ? options.steadyIntervalMs
      : (options.inProgressIntervalMs ?? IN_PROGRESS_INTERVAL_MS),
    isTerminal: (data) => options.steadyIntervalMs === false && options.isSettled(data),
  });
}
