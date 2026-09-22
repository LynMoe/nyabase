import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error.js';
import {
  boundedPollBackoff,
  classifyQueryLifecycle,
  isPermanentQueryError,
  queryPollInterval,
  refetchWhileInProgress,
} from './query-lifecycle.js';

describe('query lifecycle polling', () => {
  it.each([400, 401, 403, 404])('stops permanently for HTTP %s', (status) => {
    const error = new ApiError(status, 'DENIED', 'denied');
    expect(isPermanentQueryError(error)).toBe(true);
    expect(classifyQueryLifecycle({ error })).toBe('permanent-error');
    expect(queryPollInterval({ error }, { activeIntervalMs: 1_000 })).toBe(false);
  });

  it('uses bounded exponential backoff for network and 5xx failures', () => {
    const error = new ApiError(503, 'UNAVAILABLE', 'retry');
    expect(queryPollInterval(
      { error, fetchFailureCount: 1 },
      { activeIntervalMs: 1_000, transientBaseIntervalMs: 2_000, transientMaxIntervalMs: 8_000 },
    )).toBe(2_000);
    expect(queryPollInterval(
      { error, fetchFailureCount: 10 },
      { activeIntervalMs: 1_000, transientBaseIntervalMs: 2_000, transientMaxIntervalMs: 8_000 },
    )).toBe(8_000);
    expect(boundedPollBackoff(100, 1_000, 30_000)).toBe(30_000);
  });

  it('polls faster while work is in progress and can return to a steady interval', () => {
    const pending = { pages: [{ items: [{ status: 'pending' }] }, { items: [{ status: 'succeeded' }] }] };
    const settled = { pages: [{ items: [{ status: 'succeeded' }] }, { items: [{ status: 'failed' }] }] };
    const isSettled = (data: { pages: { items: { status: string }[] }[] }) => (
      data.pages.every((page) => page.items.every((item) => item.status !== 'pending'))
    );
    expect(refetchWhileInProgress({ data: pending }, { steadyIntervalMs: 15_000, isSettled })).toBe(5_000);
    expect(refetchWhileInProgress({ data: settled }, { steadyIntervalMs: false, isSettled })).toBe(false);
    expect(refetchWhileInProgress({ data: settled }, { steadyIntervalMs: 5_000, isSettled })).toBe(5_000);
    const denied = new ApiError(403, 'DENIED', 'denied');
    expect(refetchWhileInProgress({ data: pending, error: denied }, { steadyIntervalMs: 5_000, isSettled })).toBe(false);
  });

  it('stops immediately when the resource reports a terminal state', () => {
    expect(queryPollInterval(
      { data: { status: 'failed' } },
      { activeIntervalMs: 1_000, isTerminal: (data) => data.status === 'failed' },
    )).toBe(false);
  });
});
