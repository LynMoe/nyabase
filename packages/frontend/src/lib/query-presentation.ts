export type QueryPresentationState = 'loading' | 'error' | 'success' | 'stale-error';

export function queryPresentationState(input: {
  hasData: boolean;
  isLoading: boolean; // caller passes isPending && isFetching
  isError: boolean;
}): QueryPresentationState {
  if (!input.hasData && input.isLoading) return 'loading';
  if (!input.hasData && input.isError) return 'error';
  if (input.hasData && input.isError) return 'stale-error';
  return 'success';
}
