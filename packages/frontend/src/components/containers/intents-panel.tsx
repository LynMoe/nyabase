import type { ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { IntentStatus, type IntentDto, type UserDto } from '@nyabase/common';
import { errorMessage } from '../../lib/api-error.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js';
import { StatusBadge } from '../layout/status-badge.js';
import { toast } from '../../hooks/use-toast.js';
import { intentPending } from '../../lib/in-progress.js';
import { intentKindLabel, intentStatusLabel } from '../../lib/status-labels.js';
import {
  currentOutstandingIntents,
  formatIntentAttempt,
  formatIntentFailureMessage,
  isRetryableIntent,
  retryIntent,
} from '../../lib/intent-visibility.js';
import { useAuthStore } from '../../store/auth.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { truncateId } from '../refs/truncate-id.js';

function requestedByLabel(
  requestedBy: string | null,
  admin: boolean,
  currentUser: UserDto | null,
): ReactNode {
  if (!requestedBy) return '系统';
  if (admin) return <ResourceRef kind="user" id={requestedBy} />;
  if (currentUser?.id === requestedBy) {
    return (
      <ResourceRef
        kind="user"
        id={requestedBy}
        name={currentUser.displayName || currentUser.username}
      />
    );
  }
  return <span title={requestedBy} className="font-mono text-xs">{truncateId(requestedBy)}</span>;
}

export function IntentRow({
  intent,
  admin,
  onRetried,
  showRequestSummary = false,
  resourceLabel,
  serverLabel,
  retryable = false,
}: {
  intent: IntentDto;
  admin: boolean;
  onRetried: () => void;
  showRequestSummary?: boolean;
  resourceLabel?: string;
  serverLabel?: string | null;
  retryable?: boolean;
}) {
  const currentUser = useAuthStore((state) => state.user);
  const retry = useMutation({
    mutationFn: (intentId: string) => retryIntent(intentId, admin),
    onSuccess: () => {
      toast({ title: '已提交重试' });
      onRetried();
    },
    onError: (error) => toast({
      title: '重试失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });
  const failure = formatIntentFailureMessage(intent);
  const requestedBy = requestedByLabel(intent.requestedBy, admin, currentUser);
  const meta = [
    resourceLabel,
    serverLabel,
    requestedBy,
    new Date(intent.createdAt).toLocaleString(),
    formatIntentAttempt(intent),
  ].filter((part): part is ReactNode => Boolean(part));
  return (
    <div className="space-y-1 px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{intentKindLabel(intent.kind)}</span>
        <StatusBadge
          label={intentStatusLabel(intent.status)}
          raw={intent.status}
          pending={intentPending(intent.status)}
          variant={intent.status === IntentStatus.Succeeded ? 'success' : intent.status === IntentStatus.Failed ? 'destructive' : 'warning'}
        />
      </div>
      <div className="text-xs text-muted-foreground">
        {meta.map((part, index) => (
          <span key={index}>
            {index > 0 ? ' · ' : null}
            {part}
          </span>
        ))}
      </div>
      {showRequestSummary && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-xs">{JSON.stringify(intent.requestSummary)}</pre>
      )}
      {failure && (
        <p className="break-all text-xs text-destructive">{failure}</p>
      )}
      {retryable && isRetryableIntent(intent) && (
        <Button
          size="sm"
          variant="outline"
          disabled={retry.isPending}
          onClick={() => retry.mutate(intent.id)}
        >
          {retry.isPending ? '提交中...' : '重试'}
        </Button>
      )}
    </div>
  );
}

export function IntentsPanel({
  intents,
  admin,
  onRetry,
  embedded = false,
}: {
  intents: IntentDto[];
  admin: boolean;
  onRetry: () => void;
  embedded?: boolean;
}) {
  const retryableIds = new Set(currentOutstandingIntents(intents).map((intent) => intent.id));
  const list = intents.length === 0 ? (
    <p className="text-sm text-muted-foreground">暂无操作记录。</p>
  ) : (
    <div className="divide-y rounded-md border">
      {intents.map((intent) => (
        <IntentRow
          key={intent.id}
          intent={intent}
          admin={admin}
          onRetried={onRetry}
          showRequestSummary
          retryable={retryableIds.has(intent.id)}
        />
      ))}
    </div>
  );
  if (embedded) {
    return <div data-testid="intent-history">{list}</div>;
  }
  return (
    <Card data-testid="intent-history">
      <CardHeader>
        <CardTitle className="text-base">意图历史</CardTitle>
      </CardHeader>
      <CardContent>
        {list}
      </CardContent>
    </Card>
  );
}
