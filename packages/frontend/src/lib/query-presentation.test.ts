import { describe, expect, it } from 'vitest';
import { queryPresentationState } from './query-presentation.js';

describe('query presentation state', () => {
  it('never presents initial or failed unknown data as successful empty data', () => {
    expect(queryPresentationState({ hasData: false, isPending: true, isError: false })).toBe('loading');
    expect(queryPresentationState({ hasData: false, isPending: false, isError: true })).toBe('error');
  });

  it('distinguishes cached stale data from a current success', () => {
    expect(queryPresentationState({ hasData: true, isPending: false, isError: true })).toBe('stale-error');
    expect(queryPresentationState({ hasData: true, isPending: false, isError: false })).toBe('success');
  });
});
