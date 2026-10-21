import { ContainerStatus, type ContainerDto } from '@nyabase/common';
import { History } from 'lucide-react';
import { ContainerActionBar } from '../../components/containers/container-action-bar.js';
import { PageHeader } from '../../components/layout/page-header.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { Button } from '../../components/ui/button.js';
import {
  containerLifecyclePending,
  containerStatusPending,
} from '../../lib/in-progress.js';
import { containerStatusLabel, lifecyclePhaseLabel } from '../../lib/status-labels.js';

/** Container name with its status badges, breadcrumbs, the history button and the power actions. */
export function ContainerDetailHeader({
  container: c,
  admin,
  actionPending,
  onShowHistory,
  onAction,
}: {
  container: ContainerDto | undefined;
  admin: boolean;
  actionPending: boolean;
  onShowHistory: () => void;
  onAction: (name: 'start' | 'stop' | 'restart' | 'delete') => Promise<void>;
}) {
  const running = c?.actual.status === ContainerStatus.Running;
  return (
    <PageHeader
      title={
        c ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{c.name}</span>
            <StatusBadge
              label={containerStatusLabel(c.actual.status)}
              raw={c.actual.status}
              pending={containerStatusPending(c)}
              variant={running ? 'success' : c.needsAttention ? 'destructive' : 'secondary'}
            />
            {c.lifecyclePhase !== 'active' && (
              <StatusBadge
                label={lifecyclePhaseLabel(c.lifecyclePhase)}
                raw={c.lifecyclePhase}
                pending={containerLifecyclePending(c)}
                variant="warning"
              />
            )}
          </span>
        ) : '容器'
      }
      description={c ? c.serverName : undefined}
      crumbs={[
        admin
          ? { label: '全平台容器', to: '/manage/containers' }
          : { label: '容器', to: '/containers' },
        { label: c?.name ?? '…' },
      ]}
      actions={c ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-9"
            data-testid="open-intent-history"
            onClick={onShowHistory}
          >
            <History className="h-4 w-4" />操作记录
          </Button>
          <ContainerActionBar
            container={c}
            layout="labeled"
            pending={actionPending}
            showDelete
            onAction={onAction}
          />
        </div>
      ) : undefined}
    />
  );
}
