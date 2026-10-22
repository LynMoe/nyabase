import { Link } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import type { ContainerDto } from '@nyabase/common';
import { useState } from 'react';
import { ContainerActionBar, type ContainerBarAction } from './container-action-bar.js';
import { StatusBadge } from '../layout/status-badge.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { useResourceMutationPending } from '../../lib/resource-mutation-gate.js';
import { containerLifecyclePending, containerStatusPending } from '../../lib/in-progress.js';
import { formatBytes } from '../../lib/utils.js';
import { cpuSetLabel } from '../../lib/cpu-set.js';
import { containerStatusLabel, lifecyclePhaseLabel } from '../../lib/status-labels.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { useIsNarrow } from '../../hooks/use-dom-state.js';
import { SectionCard } from '../layout/section-card.js';
import { ListSearch, SegmentedFilter } from '../layout/list-search.js';
import {
  type ContainerStatusFilter,
  containerStatusOptions,
  filterContainers,
} from '../../lib/container-filter.js';

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
  const narrow = useIsNarrow();
  if (narrow) {
    return (
      <ul className="divide-y" data-testid="container-cards">
        {containers.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyLabel}</li>
        ) : containers.map((container) => (
          <ContainerCard key={container.id} container={container} admin={admin} onAction={onAction} />
        ))}
      </ul>
    );
  }
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
        <ContainerStatusBadges container={container} />
      </TableCell>
      <TableCell className="font-mono">{container.routedIp ?? '等待容器 IP'}</TableCell>
      <TableCell className="tabular-nums" title="该用户在此服务器上的 CPU 组，容器间共享">{cpuSetLabel(container.cpuSet)}</TableCell>
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

function ContainerStatusBadges({ container }: { container: ContainerDto }) {
  const status = container.actual.status;
  return (
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
  );
}

/** Phone layout: one stacked card per container, power actions always in reach. */
function ContainerCard({
  container,
  admin,
  onAction,
}: {
  container: ContainerDto;
  admin: boolean;
  onAction: (action: ContainerBarAction, container: ContainerDto) => void | Promise<void>;
}) {
  const detailTo = admin ? '/manage/containers/$containerId' : '/containers/$containerId';
  const pending = useResourceMutationPending(container.id);
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Link
            to={detailTo}
            params={{ containerId: container.id }}
            search={{ tab: 'overview' }}
            className="block truncate font-medium hover:underline"
          >
            {container.name}
          </Link>
          <ContainerStatusBadges container={container} />
        </div>
        <div className="flex shrink-0 gap-1">
          <ContainerActionBar
            container={container}
            layout="icons"
            pending={pending}
            onAction={(action) => onAction(action, container)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {admin && container.ownerName ? `${container.ownerName} · ` : null}
        {container.serverName}
        {' · '}
        <span className="font-mono">{container.routedIp ?? '等待容器 IP'}</span>
        {' · '}
        CPU {cpuSetLabel(container.cpuSet)} / {formatBytes(container.memBytes)}
      </p>
    </li>
  );
}

/** Container table with search and a status segment, shared by the user and admin lists. */
export function ContainerList({
  containers,
  admin = false,
  onAction,
}: {
  containers: ContainerDto[];
  admin?: boolean;
  onAction: (action: ContainerBarAction, container: ContainerDto) => void | Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ContainerStatusFilter>('all');
  const visible = filterContainers(containers, query, status);
  const filtered = query.trim() !== '' || status !== 'all';
  return (
    <SectionCard
      flush
      toolbar={(
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedFilter
            label="按状态筛选"
            value={status}
            onChange={setStatus}
            options={containerStatusOptions(containers)}
          />
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder={admin ? '搜索名称、所有者、服务器、IP' : '搜索名称、服务器、IP'}
          />
        </div>
      )}
    >
      <ContainerTable
        containers={visible}
        admin={admin}
        showServerColumn
        emptyLabel={filtered ? '没有符合条件的容器' : '暂无容器'}
        onAction={onAction}
      />
    </SectionCard>
  );
}
