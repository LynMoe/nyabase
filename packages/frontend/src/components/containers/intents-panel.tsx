import { useMutation } from '@tanstack/react-query';
import { IntentStatus, type IntentDto } from '@nyabase/common';
import { errorMessage } from '../../lib/api-error.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { toast } from '../../hooks/use-toast.js';
import { intentKindLabel, intentStatusLabel } from '../../lib/status-labels.js';
import {
  formatIntentAttempt,
  formatIntentFailureMessage,
  isRetryableIntent,
  retryIntent,
} from '../../lib/intent-visibility.js';

export function IntentsPanel({
  intents,
  admin,
  onRetry,
}: {
  intents: IntentDto[];
  admin: boolean;
  onRetry: () => void;
}) {
  const retry = useMutation({
    mutationFn: (intentId: string) => retryIntent(intentId, admin),
    onSuccess: () => {
      toast({ title: '已提交重试' });
      onRetry();
    },
    onError: (error) => toast({
      title: '重试失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });
  return (
    <Card data-testid="intent-history">
      <CardHeader>
        <CardTitle className="text-base">意图历史</CardTitle>
        <CardDescription>显示请求人、操作类型、尝试次数、结果与错误说明。</CardDescription>
      </CardHeader>
      <CardContent>
        {intents.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无操作记录。</p>
        ) : (
          <div className="divide-y rounded-md border">
            {intents.map((intent) => {
              const failure = formatIntentFailureMessage(intent);
              return (
                <div key={intent.id} className="space-y-1 px-3 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{intentKindLabel(intent.kind)}</span>
                    <Badge
                      title={intent.status}
                      variant={intent.status === IntentStatus.Succeeded ? 'success' : intent.status === IntentStatus.Failed ? 'destructive' : 'warning'}
                    >
                      {intentStatusLabel(intent.status)}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {intent.requestedBy ?? '系统'} · {new Date(intent.createdAt).toLocaleString()} · {formatIntentAttempt(intent)}
                  </div>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-xs">{JSON.stringify(intent.requestSummary)}</pre>
                  {failure && (
                    <p className="break-all text-xs text-destructive">{failure}</p>
                  )}
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
        )}
      </CardContent>
    </Card>
  );
}
