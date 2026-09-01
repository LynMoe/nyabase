import { describe, expect, it } from 'vitest';
import { queryPresentationState } from './query-presentation.js';

describe('query presentation state', () => {
  it('never presents initial or failed unknown data as successful empty data', () => {
    expect(queryPresentationState({ hasData: false, isLoading: true, isError: false })).toBe('loading');
    expect(queryPresentationState({ hasData: false, isLoading: false, isError: true })).toBe('error');
  });

  it('distinguishes cached stale data from a current success', () => {
    expect(queryPresentationState({ hasData: true, isLoading: false, isError: true })).toBe('stale-error');
    expect(queryPresentationState({ hasData: true, isLoading: false, isError: false })).toBe('success');
  });

  it('does not treat idle/disabled (no data, not loading, no error) as loading', () => {
    expect(queryPresentationState({ hasData: false, isLoading: false, isError: false })).toBe('success');
  });
});
