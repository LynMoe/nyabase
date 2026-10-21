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
