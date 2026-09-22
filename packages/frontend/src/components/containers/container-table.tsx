import { Link } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import type { ContainerDto } from '@nyabase/common';
import { ContainerActionBar, type ContainerBarAction } from './container-action-bar.js';
import { StatusBadge } from '../layout/status-badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js';
import { useResourceMutationPending } from '../../hooks/use-resource-mutation-gate.js';
import { containerLifecyclePending, containerStatusPending } from '../../lib/in-progress.js';
import { formatBytes, formatCpu } from '../../lib/utils.js';
import { containerStatusLabel, lifecyclePhaseLabel } from '../../lib/status-labels.js';
import { ResourceRef } from '../refs/resource-ref.js';


export function ContainerTable({
  containers,
  admin = false,
  showServerColumn = false,
  emptyLabel = '暂无容器',
  onAction,
}: {
  containers: ContainerDto[];
  admin?: boolean;
  showServerColumn?: boolean;
  emptyLabel?: string;
  onAction: (action: ContainerBarAction, container: ContainerDto) => void | Promise<void>;
}) {
  const columnCount = 6 + (admin ? 1 : 0) + (showServerColumn ? 1 : 0);
  return (
    <Table className="min-w-[720px]">
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          {admin ? <TableHead>所有者</TableHead> : null}
          {showServerColumn ? <TableHead>服务器</TableHead> : null}
          <TableHead>状态</TableHead>
          <TableHead>IP</TableHead>
          <TableHead>CPU</TableHead>
          <TableHead>内存</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {containers.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columnCount} className="py-8 text-center text-muted-foreground">
              {emptyLabel}
            </TableCell>
          </TableRow>
        ) : containers.map((container) => (
          <ContainerTableRow
            key={container.id}
            container={container}
            admin={admin}
            showServerColumn={showServerColumn}
            onAction={onAction}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function ContainerTableRow({
  container,
  admin,
  showServerColumn,
  onAction,
}: {
  container: ContainerDto;
  admin: boolean;
  showServerColumn: boolean;
  onAction: (action: ContainerBarAction, container: ContainerDto) => void | Promise<void>;
}) {
  const detailTo = admin ? '/manage/containers/$containerId' : '/containers/$containerId';
  const status = container.actual.status;
  const pending = useResourceMutationPending(container.id);
  return (
    <TableRow>
      <TableCell className="whitespace-normal">
        <Link
          to={detailTo}
          params={{ containerId: container.id }}
          search={{ tab: 'overview' }}
          className="font-medium hover:underline"
        >
          {container.name}
        </Link>
      </TableCell>
      {admin ? (
        <TableCell>
          {container.ownerId ? (
            <ResourceRef kind="user" id={container.ownerId} name={container.ownerName} />
          ) : '—'}
        </TableCell>
      ) : null}
      {showServerColumn ? <TableCell>{container.serverName}</TableCell> : null}
      <TableCell className="whitespace-normal">
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge
            label={containerStatusLabel(status)}
            raw={status}
            pending={containerStatusPending(container)}
            variant={status === 'running' ? 'success' : container.needsAttention ? 'destructive' : 'secondary'}
          />
          {container.lifecyclePhase !== 'active' ? (
            <StatusBadge
              label={lifecyclePhaseLabel(container.lifecyclePhase)}
              raw={container.lifecyclePhase}
              pending={containerLifecyclePending(container)}
              variant="warning"
            />
          ) : null}
          {container.needsAttention ? <TriangleAlert className="h-3.5 w-3.5 text-destructive" aria-label="需要关注" /> : null}
        </div>
      </TableCell>
      <TableCell className="font-mono">{container.routedIp ?? '等待容器 IP'}</TableCell>
      <TableCell>{formatCpu(container.cpuMillis)}</TableCell>
      <TableCell>{formatBytes(container.memBytes)}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <ContainerActionBar
            container={container}
            layout="icons"
            pending={pending}
            onAction={(action) => onAction(action, container)}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}
