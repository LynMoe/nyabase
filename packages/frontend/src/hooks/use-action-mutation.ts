import { useMutation } from '@tanstack/react-query';
import { errorMessage } from '../lib/api-error.js';
import { toast } from './use-toast.js';

/**
 * A user-triggered mutation with the app's standard feedback: a toast on
 * success, a destructive toast carrying the server's message on failure.
 * Callers keep only what differs (the request, titles, cache refresh).
 */
export function useActionMutation<TVariables = void, TResult = unknown>({
  mutationFn,
  successTitle,
  errorTitle,
  onSuccess,
}: {
  mutationFn: (variables: TVariables) => Promise<TResult>;
  successTitle?: string | ((variables: TVariables, result: TResult) => string);
  errorTitle: string;
  onSuccess?: (result: TResult, variables: TVariables) => void;
}) {
  return useMutation({
    mutationFn,
    onSuccess: (result, variables) => {
      if (successTitle) {
        toast({ title: typeof successTitle === 'function' ? successTitle(variables, result) : successTitle });
      }
      onSuccess?.(result, variables);
    },
    onError: (error) => toast({ title: errorTitle, description: errorMessage(error), variant: 'destructive' }),
  });
}
