import { Link } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import type { ContainerDto } from '@nyabase/common';
import { useState } from 'react';
import { ContainerActionBar, type ContainerBarAction } from './container-action-bar.js';
import { ConsoleShortcut } from './console-shortcut.js';
import { StatusBadge } from '../layout/status-badge.js';
import { UsageMeter } from '../performance/usage-meter.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { useResourceMutationPending } from '../../lib/resource-mutation-gate.js';
import { containerLifecyclePending, containerStatusPending } from '../../lib/in-progress.js';
import {
  cpuReading,
  gpuCardCount,
  gpuReading,
  liveSample,
  memoryReading,
} from '../../lib/container-usage.js';
import { containerStatusLabel, lifecyclePhaseLabel } from '../../lib/status-labels.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { useIsNarrow } from '../../hooks/use-dom-state.js';
import { useContainerLiveUsage, type ContainerLiveUsageIndex } from '../../hooks/use-container-live-usage.js';
import { SectionCard } from '../layout/section-card.js';
import { ListSearch, SegmentedFilter } from '../layout/list-search.js';
import {
  type ContainerStatusFilter,
  containerStatusOptions,
  filterContainers,
} from '../../lib/container-filter.js';

type RowProps = {
  container: ContainerDto;
  admin: boolean;
  usage: ContainerLiveUsageIndex;
  onAction: (action: ContainerBarAction, container: ContainerDto) => void | Promise<void>;
};

export function ContainerTable({
  containers,
  usage,
  admin = false,
  showServerColumn = false,
  showGpuColumn = false,
  emptyLabel = '暂无容器',
  onAction,
}: {
  containers: ContainerDto[];
  usage: ContainerLiveUsageIndex;
  admin?: boolean;
  showServerColumn?: boolean;
  /** Only worth a column when some container holds a card. */
  showGpuColumn?: boolean;
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
          <ContainerCard key={container.id} container={container} admin={admin} usage={usage} onAction={onAction} />
        ))}
      </ul>
    );
  }
  const columnCount = 6 + (admin ? 1 : 0) + (showServerColumn ? 1 : 0) + (showGpuColumn ? 1 : 0);
  return (
    <Table className={showGpuColumn ? 'min-w-[880px]' : 'min-w-[760px]'}>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          {admin ? <TableHead>所有者</TableHead> : null}
          {showServerColumn ? <TableHead>服务器</TableHead> : null}
          <TableHead>状态</TableHead>
          <TableHead title="已用 / 可用核数">CPU</TableHead>
          <TableHead title="已用 / 规格">内存</TableHead>
          {showGpuColumn ? <TableHead title="显卡数 · 显存已用">GPU</TableHead> : null}
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
            usage={usage}
            showServerColumn={showServerColumn}
            showGpuColumn={showGpuColumn}
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
  usage,
  showServerColumn,
  showGpuColumn,
  onAction,
}: RowProps & { showServerColumn: boolean; showGpuColumn: boolean }) {
  const detailTo = admin ? '/manage/containers/$containerId' : '/containers/$containerId';
  const pending = useResourceMutationPending(container.id);
  const sample = liveSample(container, usage.byContainer.get(container.id));
  const stale = sample !== undefined && usage.staleServers.has(container.serverId);
  return (
    <TableRow>
      <TableCell className="min-w-[7.5rem] whitespace-normal">
        <Link
          to={detailTo}
          params={{ containerId: container.id }}
          search={{ tab: 'overview' }}
          className="font-medium hover:underline"
        >
          {container.name}
        </Link>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground">{container.routedIp ?? '等待容器 IP'}</p>
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
      <TableCell>
        <UsageMeter className="w-24" reading={cpuReading(container, sample)} stale={stale} />
      </TableCell>
      <TableCell>
        <UsageMeter className="w-24" reading={memoryReading(container, sample)} stale={stale} />
      </TableCell>
      {showGpuColumn ? (
        <TableCell>
          <UsageMeter className="w-28" reading={gpuReading(container, sample)} stale={stale} />
        </TableCell>
      ) : null}
      <TableCell className="text-right">
        <RowActions container={container} admin={admin} pending={pending} onAction={onAction} />
      </TableCell>
    </TableRow>
  );
}

/** 终端 first (the everyday jump), then the power icons after a hairline. */
function RowActions({
  container,
  admin,
  pending,
  onAction,
}: Omit<RowProps, 'usage'> & { pending: boolean }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <ConsoleShortcut container={container} admin={admin} />
      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
      <ContainerActionBar
        container={container}
        layout="icons"
        pending={pending}
        onAction={(action) => onAction(action, container)}
      />
    </div>
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
function ContainerCard({ container, admin, usage, onAction }: RowProps) {
  const detailTo = admin ? '/manage/containers/$containerId' : '/containers/$containerId';
  const pending = useResourceMutationPending(container.id);
  const sample = liveSample(container, usage.byContainer.get(container.id));
  const stale = sample !== undefined && usage.staleServers.has(container.serverId);
  const gpu = gpuReading(container, sample);
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
        <div className="shrink-0">
          <RowActions container={container} admin={admin} pending={pending} onAction={onAction} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {admin && container.ownerName ? `${container.ownerName} · ` : null}
        {container.serverName}
        {' · '}
        <span className="font-mono">{container.routedIp ?? '等待容器 IP'}</span>
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <UsageMeter layout="inline" label="CPU" reading={cpuReading(container, sample)} stale={stale} />
        <UsageMeter layout="inline" label="内存" reading={memoryReading(container, sample)} stale={stale} />
        {gpu ? <UsageMeter layout="inline" label="GPU" reading={gpu} stale={stale} /> : null}
      </div>
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
  const usage = useContainerLiveUsage(admin ? 'all' : 'mine');
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
        usage={usage}
        admin={admin}
        showServerColumn
        showGpuColumn={containers.some((container) => gpuCardCount(container) > 0)}
        emptyLabel={filtered ? '没有符合条件的容器' : '暂无容器'}
        onAction={onAction}
      />
    </SectionCard>
  );
}
