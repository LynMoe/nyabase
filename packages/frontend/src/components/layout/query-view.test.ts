import { describe, expect, it } from 'vitest';
import { isQueryLoading, type QueryLike } from './query-view.js';

function query(partial: Partial<QueryLike<unknown>>): QueryLike<unknown> {
  return {
    data: undefined,
    isPending: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: () => undefined,
    ...partial,
  };
}

describe('isQueryLoading', () => {
  it('is true only for the TanStack v5 isLoading triple', () => {
    expect(isQueryLoading(query({ isPending: true, isFetching: true }))).toBe(true);
  });

  it('does not treat idle/disabled queries as loading', () => {
    expect(
      isQueryLoading(
        query({ isPending: true, isFetching: false, data: undefined, isError: false }),
      ),
    ).toBe(false);
  });

  it('is false once data exists, even while fetching', () => {
    expect(isQueryLoading(query({ data: { ok: true }, isPending: true, isFetching: true }))).toBe(
      false,
    );
  });

  it('is false on a failed query with no data', () => {
    expect(isQueryLoading(query({ isPending: false, isFetching: false, isError: true }))).toBe(
      false,
    );
  });
});
