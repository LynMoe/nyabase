import { useMutation, useQuery } from '@tanstack/react-query';
import { type CursorPaginatedResponse, type IntentDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import {
  formatIntentAttempt,
  formatIntentFailureMessage,
  isOutstandingIntent,
  isRetryableIntent,
  retryIntent,
} from '../../lib/intent-visibility.js';
import { intentKindLabel, intentStatusLabel } from '../../lib/status-labels.js';
import { Button } from '../ui/button.js';
import { toast } from '../../hooks/use-toast.js';

export function ResourceIntentFailures({
  listPath,
  admin,
  enabled = true,
}: {
  listPath: string;
  admin: boolean;
  enabled?: boolean;
}) {
  const query = useQuery({
    queryKey: ['resource-intent-failures', admin ? 'admin' : 'user', listPath],
    queryFn: () => api.get<CursorPaginatedResponse<IntentDto>>(
      `${listPath}${listPath.includes('?') ? '&' : '?'}limit=20`,
    ),
    enabled,
  });
  const retry = useMutation({
    mutationFn: (intentId: string) => retryIntent(intentId, admin),
    onSuccess: () => {
      toast({ title: '已提交重试' });
      void query.refetch();
    },
    onError: (error) => toast({
      title: '重试失败',
      description: error instanceof Error ? error.message : '请稍后重试',
      variant: 'destructive',
    }),
  });
  const outstanding = (query.data?.items ?? []).filter(isOutstandingIntent);
  if (!enabled || query.isLoading || outstanding.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3" data-testid="resource-intent-failures">
      {outstanding.map((intent) => {
        const failure = formatIntentFailureMessage(intent);
        return (
          <div key={intent.id} className="space-y-1 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{intentKindLabel(intent.kind)}</span>
              <span className="text-xs text-muted-foreground">
                {intentStatusLabel(intent.status)} · {formatIntentAttempt(intent)}
              </span>
            </div>
            {failure && <p className="break-all text-xs text-destructive">{failure}</p>}
            {isRetryableIntent(intent) && (
              <Button
                size="sm"
                variant="outline"
                disabled={retry.isPending}
                onClick={() => retry.mutate(intent.id)}
              >
                {retry.isPending && retry.variables === intent.id ? '提交中...' : '重试'}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
