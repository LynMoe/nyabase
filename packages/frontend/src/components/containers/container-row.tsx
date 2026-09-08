import { Link } from '@tanstack/react-router';
import { ChevronRight, TriangleAlert } from 'lucide-react';
import type { ContainerAction, ContainerDto } from '@nyabase/common';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { useResourceMutationPending } from '../../hooks/use-resource-mutation-gate.js';
import { formatBytes, formatCpu } from '../../lib/utils.js';
import { containerStatusLabel, lifecyclePhaseLabel } from '../../lib/status-labels.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { ContainerActionBar } from './container-action-bar.js';

export function ContainerRow({
  container,
  admin = false,
  onAction,
}: {
  container: ContainerDto;
  admin?: boolean;
  onAction: (action: ContainerAction, container: ContainerDto) => void | Promise<void>;
}) {
  const detailTo = admin ? '/manage/containers/$containerId' : '/containers/$containerId';
  const status = container.actual.status;
  const pending = useResourceMutationPending(container.id);

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <Link to={detailTo} params={{ containerId: container.id }} search={{ tab: 'overview' }} className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{container.name}</span>
          <Badge
            className="shrink-0 whitespace-nowrap"
            variant={status === 'running' ? 'success' : container.needsAttention ? 'destructive' : 'secondary'}
            title={status}
          >
            {containerStatusLabel(status)}
          </Badge>
          {container.lifecyclePhase !== 'active' && (
            <Badge variant="warning" title={container.lifecyclePhase}>
              {lifecyclePhaseLabel(container.lifecyclePhase)}
            </Badge>
          )}
          {container.needsAttention && <TriangleAlert className="h-3.5 w-3.5 text-destructive" aria-label="需要关注" />}
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {admin && container.ownerId ? (
            <>
              <ResourceRef kind="user" id={container.ownerId} name={container.ownerName} />
              {' · '}
            </>
          ) : null}
          {container.serverName} · {container.routedIp ?? '等待容器 IP'} · {formatCpu(container.cpuMillis)} · {formatBytes(container.memBytes)}
        </p>
      </Link>
      <div className="flex shrink-0 justify-end gap-1">
        <ContainerActionBar
          container={container}
          layout="icons"
          pending={pending}
          onAction={(action) => onAction(action, container)}
        />
        <Button size="icon" variant="ghost" asChild aria-label="详情">
          <Link to={detailTo} params={{ containerId: container.id }} search={{ tab: 'overview' }}>
            <ChevronRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
