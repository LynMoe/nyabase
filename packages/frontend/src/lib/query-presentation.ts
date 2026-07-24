export type QueryPresentationState = 'loading' | 'error' | 'success' | 'stale-error';

export function queryPresentationState(input: {
  hasData: boolean;
  isPending: boolean;
  isError: boolean;
}): QueryPresentationState {
  if (!input.hasData && input.isPending) return 'loading';
  if (!input.hasData && input.isError) return 'error';
  if (input.hasData && input.isError) return 'stale-error';
  return 'success';
}
