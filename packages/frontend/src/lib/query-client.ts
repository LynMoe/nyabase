import { QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from '../hooks/use-toast.js';
import { ApiError } from './api-error.js';

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status >= 500) {
        toast({ title: '服务器错误', description: error.message, variant: 'destructive' });
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

/**
 * Auth transitions must make stale principal data unreachable immediately.
 * cancelQueries marks active work as cancelled; clear synchronously drops every
 * cached value before a different principal can render.
 */
export function clearPrincipalQueryState(): void {
  void queryClient.cancelQueries();
  queryClient.clear();
}

export function isCurrentPrincipalAccessQuery(queryKey: readonly unknown[]): boolean {
  const root = String(queryKey[0] ?? '');
  const a = queryKey[1];
  const b = queryKey[2];
  if (root === 'me' && a === 'access') return true;
  if (
    (root === 'servers' || root === 'images' || root === 'containers'
      || root === 'container' || root === 'volumes' || root === 'shared-backends'
      || root === 'storage-pools' || root === 'container-intents'
      || root === 'container-attachments' || root === 'resource-intent-failures'
      || root === 'volume-intents')
    && a === 'user'
  ) return true;
  if (root === 'server-card-extension' && queryKey[3] === 'user') return true;
  if (root === 'http-proxy' && b === 'user') return true;
  return false;
}

/**
 * Drop only projections whose membership depends on the current principal's
 * grants. `resetQueries` clears the value synchronously before active
 * observers refetch, so a revoked resource is never presented as current.
 */
export function resetCurrentPrincipalAccessQueries(): void {
  void queryClient.cancelQueries({
    predicate: (query) => isCurrentPrincipalAccessQuery(query.queryKey),
  });
  void queryClient.resetQueries({
    predicate: (query) => isCurrentPrincipalAccessQuery(query.queryKey),
  });
}
