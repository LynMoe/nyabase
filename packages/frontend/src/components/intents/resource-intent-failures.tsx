import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type CursorPaginatedResponse, type IntentDto } from '@nyabase/common';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  currentOutstandingIntents,
  formatIntentAttempt,
  formatIntentFailureMessage,
  isRetryableIntent,
  retryIntent,
} from '../../lib/intent-visibility.js';
import { intentKindLabel, intentStatusLabel } from '../../lib/status-labels.js';
import { Button } from '../ui/button.js';
import { toast } from '../../hooks/use-toast.js';
import { IntentsPanel } from '../containers/intents-panel.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';

export function ResourceIntentHistory({
  listPath,
  admin,
  enabled = true,
  defaultOpen = false,
}: {
  listPath: string;
  admin: boolean;
  enabled?: boolean;
  defaultOpen?: boolean;
}) {
  const query = useQuery({
    queryKey: queryKeys.resourceIntentFailures(admin ? 'admin' : 'user', listPath, 50),
    queryFn: () => api.get<CursorPaginatedResponse<IntentDto>>(
      `${listPath}${listPath.includes('?') ? '&' : '?'}limit=50`,
    ),
    enabled,
    refetchInterval: (queryState) => queryPollInterval(queryState.state, {
      activeIntervalMs: 5_000,
      isTerminal: (page) => currentOutstandingIntents(page.items ?? []).length === 0,
    }),
  });
  const items = query.data?.items ?? [];
  const outstandingCount = currentOutstandingIntents(items).length;
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (outstandingCount > 0) setOpen(true);
  }, [outstandingCount]);
  if (!enabled) return null;
  if (query.isLoading) {
    return <p className="text-xs text-muted-foreground">加载操作历史...</p>;
  }
  if (query.isError) {
    return <p className="text-xs text-destructive">操作历史加载失败：{errorMessage(query.error)}</p>;
  }
  return (
    <div className="min-w-0 space-y-2" data-testid="volume-intent-history">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-auto px-0 text-xs"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <History className="h-3.5 w-3.5" />
        操作历史
        {items.length > 0 ? `（${items.length}）` : ''}
        {outstandingCount > 0 ? ` · ${outstandingCount} 待处理` : ''}
      </Button>
      {open && (
        <IntentsPanel
          intents={items}
          admin={admin}
          embedded
          onRetry={() => { void query.refetch(); }}
        />
      )}
    </div>
  );
}

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
    queryKey: queryKeys.resourceIntentFailures(admin ? 'admin' : 'user', listPath, 20),
    queryFn: () => api.get<CursorPaginatedResponse<IntentDto>>(
      `${listPath}${listPath.includes('?') ? '&' : '?'}limit=20`,
    ),
    enabled,
    refetchInterval: (queryState) => queryPollInterval(queryState.state, {
      activeIntervalMs: 5_000,
      isTerminal: (page) => currentOutstandingIntents(page.items ?? []).length === 0,
    }),
  });
  const retry = useMutation({
    mutationFn: (intentId: string) => retryIntent(intentId, admin),
    onSuccess: () => {
      toast({ title: '已提交重试' });
      void query.refetch();
    },
    onError: (error) => toast({
      title: '重试失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });
  const outstanding = currentOutstandingIntents(query.data?.items ?? []);
  if (!enabled || query.isLoading) return null;
  if (query.isError) {
    return (
      <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3" data-testid="resource-intent-failures">
        <p className="text-sm text-destructive">操作失败记录加载失败：{errorMessage(query.error)}</p>
      </div>
    );
  }
  if (outstanding.length === 0) return null;
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
